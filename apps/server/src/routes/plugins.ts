/**
 * Plugin routes (W-F) — local plugin install / enable / disable / uninstall.
 *
 *   GET    /api/plugins                  list installed plugins
 *   POST   /api/plugins/install          {sourceDir, requestedBy?, approvedByHuman?}
 *   POST   /api/plugins/:name/enable
 *   POST   /api/plugins/:name/disable
 *   DELETE /api/plugins/:name            uninstall
 *
 * A plugin is a local directory with a plugin.json manifest
 * (@ai-factory/plugins). Install copies it into
 * AI_FACTORY_DATA_DIR/plugins/<name>/ (path jail, no symlinks) and
 * registers its capabilities with provenance:
 *   - skills → SkillRegistry.install (namespaced id `plugin-<name>-<id>`,
 *     §74 security scan still applies; HIGH findings block the whole
 *     install unless approvedByHuman)
 *   - slashCommands → slash-commands.json (name collision = 400)
 *   - hooks → hooks.json (ids tracked for exact removal)
 *   - mcpServers → McpRegistry.register (name@version collision = 400)
 *
 * Enable/disable are exact inverses (DEPRECATED/ACTIVE for skills,
 * remove/re-add for the rest); uninstall deregisters everything and
 * deletes the plugin directory. Every mutation is audited.
 * Install is all-or-nothing: a failure partway rolls back what was
 * already registered.
 *
 * RBAC: the dispatch layer classifies /api/plugins/* POST/DELETE as
 * operator and GET as viewer — no route change needed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import {
  copyPluginDir,
  pluginDestDir,
  pluginsHome,
  readManifest,
  PluginManifestError,
  type PluginManifest,
  type PluginMcpServerDef,
} from '@ai-factory/plugins';
import { PluginStore } from '../plugin-store';
import { getSkillRegistry } from './skills';
import { getMcpRegistry } from './mcp';
import { createHook, deleteHook } from '../hooks';
import { loadCustomCommands, saveCustomCommands } from './commands';
import { SkillNotFoundError, type InstallSkillDef } from '@ai-factory/skills';
import type { RouteContext } from './context';

const PREFIX = '/api/plugins';

const pluginStore = new PluginStore();

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Namespace a plugin skill id into the registry-safe shape. */
function skillIdFor(pluginName: string, skillId: string): string {
  const safe = pluginName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `plugin-${safe}-${skillId}`;
}

function skillDefFor(m: PluginManifest, s: PluginManifest['capabilities']['skills'][number]): InstallSkillDef {
  return {
    id: skillIdFor(m.name, s.id),
    version: s.version,
    description: s.description,
    compatibility: `plugin ${m.name}@${m.version}`,
    author: m.author ?? `plugin:${m.name}`,
    source: `plugin:${m.name}`,
    trustLevel: 'COMMUNITY',
    evaluationScore: 0,
    content: { instructions: s.instructions, references: [], scripts: [], assets: [] },
    declared: {
      network: m.permissions.includes('network.access'),
      fileAccess: m.permissions.includes('filesystem.write')
        ? 'WRITE'
        : m.permissions.includes('filesystem.read')
          ? 'READ'
          : 'NONE',
      shell: m.permissions.includes('exec'),
    },
    keywords: [m.name],
  };
}

export async function handlePluginRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/plugins
  if (method === 'GET' && path === PREFIX) {
    return ctx.json(res, 200, { plugins: pluginStore.list(), home: pluginsHome() }), true;
  }

  // POST /api/plugins/install
  if (method === 'POST' && path === `${PREFIX}/install`) {
    const body = await ctx.readBody(req);
    const sourceDir = str(body['sourceDir']);
    if (!sourceDir) return ctx.json(res, 400, { error: 'sourceDir is required' }), true;
    const requestedBy = str(body['requestedBy']) ?? 'human';
    const approvedByHuman = body['approvedByHuman'] === true;

    let manifest: PluginManifest;
    try {
      manifest = readManifest(sourceDir);
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
    if (pluginStore.has(manifest.name)) {
      return ctx.json(res, 409, { error: `plugin already installed: ${manifest.name}` }), true;
    }

    // Rollback journal: every successful registration pushes its inverse.
    const undo: (() => void)[] = [];
    const rollback = () => {
      for (const fn of undo.reverse()) {
        try { fn(); } catch { /* best effort */ }
      }
    };

    try {
      // 1. Copy files into the jail.
      const dest = pluginDestDir(manifest.name);
      if (existsSync(dest)) {
        return ctx.json(res, 409, { error: `plugin directory already exists: ${manifest.name}` }), true;
      }
      copyPluginDir(sourceDir, dest);
      undo.push(() => rmSync(dest, { recursive: true, force: true }));

      const caps = manifest.capabilities;
      const installed = {
        skills: [] as { id: string; version: string }[],
        slashCommands: [] as { name: string; description: string; template: string }[],
        hooks: [] as { id: string; event: 'PreToolUse' | 'PostToolUse' | 'Stop'; tool?: string; command: string; timeoutMs?: number; description?: string }[],
        mcpServers: [] as { name: string; version: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; description?: string }[],
      };

      // 2. Skills (security scan still applies).
      const registry = getSkillRegistry();
      for (const s of caps.skills) {
        const def = skillDefFor(manifest, s);
        let exists = false;
        try {
          registry.get(def.id);
          exists = true;
        } catch (e) {
          if (!(e instanceof SkillNotFoundError)) throw e;
        }
        if (exists) {
          throw new PluginManifestError(`skill id collision: ${def.id} already registered`);
        }
        const result = registry.install({ skill: def, requestedBy, approvedByHuman });
        if (!result.ok) {
          throw new PluginManifestError(
            `skill "${s.id}" blocked by security checklist (HIGH findings); ` +
              `re-install with approvedByHuman after human review`,
          );
        }
        installed.skills.push({ id: def.id, version: def.version });
        undo.push(() => {
          try { registry.retire(def.id, def.version); } catch { /* best effort */ }
        });
      }

      // 3. Slash commands.
      const existing = new Set(loadCustomCommands().map((c) => c.name));
      const customs = loadCustomCommands();
      for (const c of caps.slashCommands) {
        if (existing.has(c.name)) {
          throw new PluginManifestError(`slash command name collision: /${c.name} already exists`);
        }
        existing.add(c.name);
        customs.push({ name: c.name, description: c.description, template: c.template, kind: 'template', target: '', enabled: true });
        installed.slashCommands.push({ name: c.name, description: c.description, template: c.template });
      }
      if (caps.slashCommands.length > 0) {
        saveCustomCommands(customs);
        undo.push(() => {
          const rest = loadCustomCommands().filter(
            (c) => !installed.slashCommands.some((s) => s.name === c.name),
          );
          saveCustomCommands(rest);
        });
      }

      // 4. Hooks.
      for (const h of caps.hooks) {
        const created = createHook({
          event: h.event,
          tool: h.tool,
          command: h.command,
          timeoutMs: h.timeoutMs,
          description: h.description ?? `[plugin:${manifest.name}]`,
          enabled: true,
        });
        installed.hooks.push({
          id: created.id,
          event: h.event,
          tool: h.tool,
          command: h.command,
          timeoutMs: h.timeoutMs,
          description: h.description,
        });
        undo.push(() => deleteHook(created.id));
      }

      // 5. MCP servers.
      const mcp = getMcpRegistry();
      for (const m of caps.mcpServers) {
        if (mcp.has(m.name, m.version)) {
          throw new PluginManifestError(`MCP server collision: ${m.name}@${m.version} already registered`);
        }
        mcp.register(mcpDefFor(manifest, m));
        installed.mcpServers.push({
          name: m.name, version: m.version, transport: m.transport,
          command: m.command, args: m.args, url: m.url, description: m.description,
        });
        undo.push(() => { mcp.remove(m.name, m.version); });
      }

      const record = pluginStore.add({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        permissions: manifest.permissions,
        enabled: true,
        installedBy: requestedBy,
        capabilities: installed,
      });
      undo.length = 0; // committed — no rollback
      ctx.audit.record(requestedBy, 'PLUGIN_INSTALLED', 'plugin', manifest.name, {
        version: manifest.version,
        skills: installed.skills.length,
        slashCommands: installed.slashCommands.length,
        hooks: installed.hooks.length,
        mcpServers: installed.mcpServers.length,
      });
      return ctx.json(res, 201, { ok: true, plugin: record }), true;
    } catch (e) {
      rollback();
      const status = e instanceof PluginManifestError ? 400 : 500;
      return ctx.json(res, status, { error: (e as Error).message }), true;
    }
  }

  const nameMatch = path.match(/^\/api\/plugins\/([^/]+)\/(enable|disable)$/);
  if (method === 'POST' && nameMatch) {
    const name = decodeURIComponent(nameMatch[1]);
    const action = nameMatch[2];
    const actor = 'human';
    let rec;
    try {
      rec = pluginStore.get(name);
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
    try {
      if (action === 'disable') {
        if (!rec.enabled) return ctx.json(res, 200, { ok: true, plugin: rec }), true;
        setPluginEnabled(rec, false);
        rec = pluginStore.update(name, { enabled: false });
        ctx.audit.record(actor, 'PLUGIN_DISABLED', 'plugin', name, {});
      } else {
        if (rec.enabled) return ctx.json(res, 200, { ok: true, plugin: rec }), true;
        setPluginEnabled(rec, true);
        // Enable re-creates hooks with new ids — persist the refreshed refs.
        rec = pluginStore.update(name, { enabled: true, capabilities: rec.capabilities });
        ctx.audit.record(actor, 'PLUGIN_ENABLED', 'plugin', name, {});
      }
      return ctx.json(res, 200, { ok: true, plugin: rec }), true;
    } catch (e) {
      return ctx.json(res, 500, { error: (e as Error).message }), true;
    }
  }

  const delMatch = path.match(/^\/api\/plugins\/([^/]+)$/);
  if (method === 'DELETE' && delMatch) {
    const name = decodeURIComponent(delMatch[1]);
    const actor = 'human';
    let rec;
    try {
      rec = pluginStore.get(name);
    } catch (e) {
      return ctx.json(res, 404, { error: (e as Error).message }), true;
    }
    // Deregister everything, then remove the record and the directory.
    // (Already-disabled plugins have nothing live to deregister.)
    if (rec.enabled) setPluginEnabled(rec, false);
    pluginStore.remove(name);
    const dest = pluginDestDir(name);
    rmSync(dest, { recursive: true, force: true });
    ctx.audit.record(actor, 'PLUGIN_UNINSTALLED', 'plugin', name, { version: rec.version });
    return ctx.json(res, 200, { ok: true, name }), true;
  }

  return false;
}

/** Deregister (enabled=false) or re-register (enabled=true) all capabilities. */
function setPluginEnabled(
  rec: ReturnType<PluginStore['get']>,
  enabled: boolean,
): void {
  const registry = getSkillRegistry();
  const mcp = getMcpRegistry();
  if (!enabled) {
    for (const s of rec.capabilities.skills) {
      registry.transitionStatus(s.id, s.version, 'DEPRECATED');
    }
    const rest = loadCustomCommands().filter(
      (c) => !rec.capabilities.slashCommands.some((sc) => sc.name === c.name),
    );
    saveCustomCommands(rest);
    for (const h of rec.capabilities.hooks) deleteHook(h.id);
    for (const m of rec.capabilities.mcpServers) mcp.remove(m.name, m.version);
  } else {
    for (const s of rec.capabilities.skills) {
      registry.transitionStatus(s.id, s.version, 'ACTIVE');
    }
    const customs = loadCustomCommands();
    const names = new Set(customs.map((c) => c.name));
    for (const sc of rec.capabilities.slashCommands) {
      if (!names.has(sc.name)) {
        customs.push({ name: sc.name, description: sc.description, template: sc.template, kind: 'template', target: '', enabled: true });
      }
    }
    saveCustomCommands(customs);
    const newHooks: typeof rec.capabilities.hooks = [];
    for (const h of rec.capabilities.hooks) {
      const created = createHook({
        event: h.event,
        tool: h.tool,
        command: h.command,
        timeoutMs: h.timeoutMs,
        description: h.description ?? `[plugin:${rec.name}]`,
        enabled: true,
      });
      newHooks.push({ ...h, id: created.id });
    }
    // Refresh hook ids (re-created hooks get new ids).
    rec.capabilities.hooks = newHooks;
    for (const m of rec.capabilities.mcpServers) {
      if (!mcp.has(m.name, m.version)) {
        mcp.register({
          name: m.name,
          version: m.version,
          provider: `plugin:${rec.name}`,
          transport: m.transport,
          ...(m.command ? { command: m.command } : {}),
          ...(m.args ? { args: m.args } : {}),
          ...(m.url ? { url: m.url } : {}),
        });
      }
    }
  }
}

function mcpDefFor(manifest: PluginManifest, m: PluginMcpServerDef) {
  return {
    name: m.name,
    version: m.version,
    provider: `plugin:${manifest.name}`,
    transport: m.transport,
    ...(m.command ? { command: m.command } : {}),
    ...(m.args ? { args: m.args } : {}),
    ...(m.url ? { url: m.url } : {}),
  };
}
