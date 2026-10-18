/**
 * @ai-factory/plugins — plugin manifest format + validation + local install.
 *
 * A plugin is a distributable capability bundle declared by a `plugin.json`
 * manifest at the root of a local directory:
 *
 *   {
 *     "name": "my-plugin",            // ^[a-z0-9][a-z0-9._-]{1,63}$
 *     "version": "1.0.0",             // semver-ish ^\d+\.\d+\.\d+(-suffix)?$
 *     "description": "…",
 *     "author": "…",                  // optional
 *     "permissions": ["network.access"], // declared, validated against known set
 *     "capabilities": {
 *       "skills":        [{ "id": "…", "version": "…", "description": "…", "instructions": "…" }],
 *       "slashCommands": [{ "name": "…", "description": "…", "template": "…" }],
 *       "hooks":         [{ "event": "PreToolUse", "tool": "…", "command": "…",
 *                           "timeoutMs": 10000, "description": "…" }],
 *       "mcpServers":    [{ "name": "…", "version": "…", "transport": "stdio",
 *                           "command": "…", "args": ["…"], "description": "…" }]
 *     },
 *     "marketplace": { "homepage": "…", "repository": "…" }  // optional, reserved
 *   }
 *
 * The `marketplace` block is a reserved extension point for a future
 * remote marketplace (an ecosystem decision, out of scope for W-F);
 * install is local-directory only. Zip/tarball sources are NOT
 * supported — no archive dependency is declared anywhere in this repo
 * (unzipper exists in node_modules only transitively).
 *
 * Capability registration itself (skills registry, slash-commands.json,
 * hooks.json, MCP registry) lives in apps/server/src/routes/plugins.ts —
 * this package is pure validation + file copying so it stays unit-
 * testable without a server.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/;

/**
 * Permissions a plugin may declare. Mirrors the permission vocabulary
 * used elsewhere (packages/core ALL_PERMISSIONS + tool grants).
 * Declaring a permission does not grant it — grants are still decided
 * by the existing per-surface mechanisms (W-C tiers, RUNTIME_TOOL_GRANTS).
 */
export const KNOWN_PLUGIN_PERMISSIONS = [
  'network.access',
  'filesystem.read',
  'filesystem.write',
  'exec',
  'mcp',
] as const;
export type PluginPermission = (typeof KNOWN_PLUGIN_PERMISSIONS)[number];

export interface PluginSkillDef {
  id: string;
  version: string;
  description: string;
  instructions: string;
}

export interface PluginSlashCommandDef {
  name: string;
  description: string;
  template: string;
}

export type PluginHookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface PluginHookDef {
  event: PluginHookEvent;
  tool?: string;
  command: string;
  timeoutMs?: number;
  description?: string;
}

export interface PluginMcpServerDef {
  name: string;
  version: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
}

export interface PluginCapabilities {
  skills: PluginSkillDef[];
  slashCommands: PluginSlashCommandDef[];
  hooks: PluginHookDef[];
  mcpServers: PluginMcpServerDef[];
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: PluginPermission[];
  capabilities: PluginCapabilities;
  marketplace?: { homepage?: string; repository?: string };
}

export class PluginManifestError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqStr(obj: Record<string, unknown>, field: string, what: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || !v.trim()) {
    throw new PluginManifestError(`${what}: "${field}" must be a non-empty string`);
  }
  return v;
}

function optStr(obj: Record<string, unknown>, field: string, what: string): string | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new PluginManifestError(`${what}: "${field}" must be a string`);
  return v;
}

const SLASH_NAME_RE = /^[a-z0-9][a-z0-9-_]{1,47}$/;
const HOOK_EVENTS: readonly string[] = ['PreToolUse', 'PostToolUse', 'Stop'];

/**
 * Validate a parsed plugin.json object. Returns a normalized manifest.
 * Throws PluginManifestError on any violation (fail-closed: the caller
 * installs nothing when this throws).
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (!isRecord(raw)) throw new PluginManifestError('manifest must be a JSON object');
  const name = reqStr(raw, 'name', 'manifest');
  if (!PLUGIN_NAME_RE.test(name)) {
    throw new PluginManifestError(`manifest: invalid name "${name}"`);
  }
  const version = reqStr(raw, 'version', 'manifest');
  if (!PLUGIN_VERSION_RE.test(version)) {
    throw new PluginManifestError(`manifest: invalid version "${version}" (want x.y.z)`);
  }
  const description = reqStr(raw, 'description', 'manifest');
  const author = optStr(raw, 'author', 'manifest');

  const permissions: PluginPermission[] = [];
  const praw = raw['permissions'] ?? [];
  if (!Array.isArray(praw)) throw new PluginManifestError('manifest: "permissions" must be an array');
  for (const p of praw) {
    if (typeof p !== 'string' || !(KNOWN_PLUGIN_PERMISSIONS as readonly string[]).includes(p)) {
      throw new PluginManifestError(`manifest: unknown permission "${String(p)}"`);
    }
    permissions.push(p as PluginPermission);
  }

  const caps = raw['capabilities'] ?? {};
  if (!isRecord(caps)) throw new PluginManifestError('manifest: "capabilities" must be an object');
  const capabilities: PluginCapabilities = {
    skills: [],
    slashCommands: [],
    hooks: [],
    mcpServers: [],
  };

  const seen = new Set<string>();
  const claim = (kind: string, id: string) => {
    const k = `${kind}:${id}`;
    if (seen.has(k)) throw new PluginManifestError(`manifest: duplicate ${kind} "${id}"`);
    seen.add(k);
  };

  for (const s of asArray(caps['skills'], 'capabilities.skills')) {
    if (!isRecord(s)) throw new PluginManifestError('capabilities.skills[] must be objects');
    const id = reqStr(s, 'id', 'skill');
    const ver = reqStr(s, 'version', `skill "${id}"`);
    if (!PLUGIN_VERSION_RE.test(ver)) {
      throw new PluginManifestError(`skill "${id}": invalid version "${ver}"`);
    }
    claim('skill', id);
    capabilities.skills.push({
      id,
      version: ver,
      description: reqStr(s, 'description', `skill "${id}"`),
      instructions: reqStr(s, 'instructions', `skill "${id}"`),
    });
  }

  for (const c of asArray(caps['slashCommands'], 'capabilities.slashCommands')) {
    if (!isRecord(c)) throw new PluginManifestError('capabilities.slashCommands[] must be objects');
    const n = reqStr(c, 'name', 'slashCommand');
    if (!SLASH_NAME_RE.test(n)) throw new PluginManifestError(`slashCommand: invalid name "${n}"`);
    claim('slashCommand', n);
    capabilities.slashCommands.push({
      name: n,
      description: reqStr(c, 'description', `slashCommand "${n}"`),
      template: reqStr(c, 'template', `slashCommand "${n}"`),
    });
  }

  for (const h of asArray(caps['hooks'], 'capabilities.hooks')) {
    if (!isRecord(h)) throw new PluginManifestError('capabilities.hooks[] must be objects');
    const event = reqStr(h, 'event', 'hook');
    if (!HOOK_EVENTS.includes(event)) {
      throw new PluginManifestError(`hook: invalid event "${event}"`);
    }
    const command = reqStr(h, 'command', 'hook');
    const tool = optStr(h, 'tool', 'hook');
    const timeoutMs: unknown = h['timeoutMs'];
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
      throw new PluginManifestError('hook: "timeoutMs" must be a positive integer');
    }
    capabilities.hooks.push({
      event: event as PluginHookEvent,
      tool,
      command,
      timeoutMs: timeoutMs as number | undefined,
      description: optStr(h, 'description', 'hook'),
    });
  }

  for (const m of asArray(caps['mcpServers'], 'capabilities.mcpServers')) {
    if (!isRecord(m)) throw new PluginManifestError('capabilities.mcpServers[] must be objects');
    const mname = reqStr(m, 'name', 'mcpServer');
    const mver = reqStr(m, 'version', `mcpServer "${mname}"`);
    if (!PLUGIN_VERSION_RE.test(mver)) {
      throw new PluginManifestError(`mcpServer "${mname}": invalid version "${mver}"`);
    }
    const transport = reqStr(m, 'transport', `mcpServer "${mname}"`);
    if (transport !== 'stdio' && transport !== 'http') {
      throw new PluginManifestError(`mcpServer "${mname}": transport must be "stdio" or "http"`);
    }
    if (transport === 'stdio' && !optStr(m, 'command', `mcpServer "${mname}"`)) {
      throw new PluginManifestError(`mcpServer "${mname}": stdio transport needs "command"`);
    }
    if (transport === 'http' && !optStr(m, 'url', `mcpServer "${mname}"`)) {
      throw new PluginManifestError(`mcpServer "${mname}": http transport needs "url"`);
    }
    claim('mcpServer', `${mname}@${mver}`);
    capabilities.mcpServers.push({
      name: mname,
      version: mver,
      transport,
      command: optStr(m, 'command', `mcpServer "${mname}"`),
      args: asStringArray(m['args'], `mcpServer "${mname}".args`),
      url: optStr(m, 'url', `mcpServer "${mname}"`),
      description: optStr(m, 'description', `mcpServer "${mname}"`),
    });
  }

  let marketplace: PluginManifest['marketplace'];
  if (raw['marketplace'] !== undefined) {
    if (!isRecord(raw['marketplace'])) {
      throw new PluginManifestError('manifest: "marketplace" must be an object');
    }
    marketplace = {
      homepage: optStr(raw['marketplace'], 'homepage', 'marketplace'),
      repository: optStr(raw['marketplace'], 'repository', 'marketplace'),
    };
  }

  return { name, version, description, author, permissions, capabilities, marketplace };
}

function asArray(v: unknown, what: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new PluginManifestError(`manifest: "${what}" must be an array`);
  return v;
}

function asStringArray(v: unknown, what: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new PluginManifestError(`manifest: "${what}" must be a string array`);
  }
  return v as string[];
}

/** Read + validate plugin.json from a source directory. */
export function readManifest(sourceDir: string): PluginManifest {
  const p = join(resolve(sourceDir), PLUGIN_MANIFEST_FILE);
  if (!existsSync(p)) {
    throw new PluginManifestError(`no ${PLUGIN_MANIFEST_FILE} in ${sourceDir}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new PluginManifestError(`invalid JSON in ${PLUGIN_MANIFEST_FILE}: ${(e as Error).message}`);
  }
  return validateManifest(parsed);
}

/**
 * Copy a plugin source directory into the plugins home.
 *
 * Path jail: every copied entry must resolve inside `destDir`; symlinks
 * are refused outright (a symlink could point outside the jail after
 * install). Throws PluginManifestError on violation — nothing is left
 * half-copied (copy goes to a temp dir first, then renames into place).
 */
export function copyPluginDir(sourceDir: string, destDir: string): void {
  const src = resolve(sourceDir);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new PluginManifestError(`plugin source is not a directory: ${sourceDir}`);
  }
  const dest = resolve(destDir);
  const staging = `${dest}.staging-${process.pid}`;
  // Staging sits next to dest (same filesystem so the final rename is
  // atomic); both must stay inside the parent of dest.
  const parent = dirname(dest);
  const insideParent = (p: string) => {
    const r = resolve(p);
    return r === parent || r.startsWith(parent + '/');
  };
  if (!insideParent(staging) || !insideParent(dest)) {
    throw new PluginManifestError('refusing to stage outside plugins home');
  }

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new PluginManifestError(`refusing symlink in plugin source: ${full}`);
      }
      if (st.isDirectory()) walk(full);
      else if (!st.isFile()) {
        throw new PluginManifestError(`refusing non-file entry in plugin source: ${full}`);
      }
    }
  };
  walk(src);

  mkdirSync(dirname(staging), { recursive: true });
  cpSync(src, staging, { recursive: true, dereference: false });
  // Defense in depth: re-verify after copy (TOCTOU on the source tree).
  walk(staging);
  try {
    renameSync(staging, dest);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** Absolute plugin home: AI_FACTORY_DATA_DIR/plugins (override via env). */
export function pluginsHome(): string {
  const fromEnv = process.env.AI_FACTORY_PLUGINS_DIR;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'plugins');
}

/** Install destination for one plugin (name-scoped, jail-checked). */
export function pluginDestDir(name: string): string {
  if (!PLUGIN_NAME_RE.test(name)) throw new PluginManifestError(`invalid plugin name "${name}"`);
  const dest = join(pluginsHome(), name);
  if (isAbsolute(dest) && !resolve(dest).startsWith(pluginsHome() + '/')) {
    throw new PluginManifestError('plugin destination escapes plugins home');
  }
  return resolve(dest);
}
