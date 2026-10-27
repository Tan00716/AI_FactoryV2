/**
 * Slash commands (W-B, extended R6-A7) — `/cmd` parsing for the command bar.
 *
 *   GET  /api/commands[?root=]    list available commands (built-ins + custom)
 *   POST /api/commands            manage custom commands (add/remove/update/enable/disable)
 *   POST /api/commands/execute    { input: "/plan fix the login bug" }
 *
 * Built-ins:
 *   /help            list commands
 *   /plan <goal>     create a PENDING plan-mode plan from the goal text
 *   /review          show the 10 review dimensions + usage (a full review
 *                    needs files/diff, which a one-line command cannot
 *                    provide — this command is discoverability, not a
 *                    fake review)
 *   /lint            run the project's lint quality gate (needs
 *                    projectId in the request body)
 *   /test            run the project's test quality gate (needs
 *                    projectId in the request body)
 *   /run             run lint then test quality gates (needs
 *                    projectId in the request body)
 *
 * Custom commands (R6-A7): a slash command is an alias + parameter
 * template for something the IDE already knows how to run — never a
 * natural-language parser, never a new execution channel:
 *   kind 'template'  deterministic text expansion (W-B behavior):
 *                    `{args}` = full argument string, `{args:N}` = Nth
 *                    whitespace-separated argument (1-based).
 *   kind 'command'   alias for a command-palette command id: execution
 *                    returns { type: 'command', commandId, args } and the
 *                    desktop dispatches it (the server cannot run a
 *                    desktop-only command itself — it says so).
 *   kind 'task'      alias for a tasks.json chain label: execution runs
 *                    the chain through runTaskChainByLabel — the exact
 *                    same policy/audit/record path as a manual
 *                    POST /api/tasks/run — with the expanded args
 *                    template appended to the REQUESTED task only
 *                    (dependencies keep their declared args).
 * `template` doubles as the args template for 'command'/'task' kinds
 * (default '{args}').
 *
 * Storage: user scope AI_FACTORY_DATA_DIR/slash-commands.json (W-B file,
 * unchanged shape, entries normalized on load); project scope
 * <root>/.ai-factory/slash-commands.json (root jailed by the injected
 * resolver, atomic tmp+rename write). Resolution order on execute:
 * project > user > built-in. A custom command may shadow a built-in
 * only with explicit `override: true` on add/update; the shadow is then
 * surfaced as a warning in list and execute responses (never silent).
 * Disabled commands list but do not execute (409).
 *
 * The coordinator wires this in: handleCommandRoutes(req, res, url, ctx).
 * The task-chain runner and the root jail are setter-injected from
 * index.ts (route must not value-import ./tasks — dual-mode rule).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RouteContext } from './context';
import { PlanStore } from '../plan-store';
import { ApprovalManager } from '@ai-factory/approvals';
import { planContentDigest } from '../plan-store';
import { executeQualityGate, type QualityGateKind } from './quality';
import { getRepoMapService } from './repomap';
import { RepoMapError } from '@ai-factory/repomap';
import { CONTEXT_PROVIDER_METAS } from './context-providers';

const PREFIX = '/api/commands';

export type SlashCommandKind = 'template' | 'command' | 'task';

export interface CustomCommand {
  name: string;
  description: string;
  /** Expansion text ('template') or args template ('command'/'task'). */
  template: string;
  kind: SlashCommandKind;
  /** Command-palette command id ('command') or tasks.json label ('task'). */
  target: string;
  enabled: boolean;
}

/** A custom command as listed, annotated with where it came from. */
export interface ListedCommand extends CustomCommand {
  source: 'user' | 'project';
  /** True when this custom command shadows a built-in of the same name. */
  shadowsBuiltin: boolean;
  /** True when a project command overrides a user command of the same name. */
  shadowsUser: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const COMMAND_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEMPLATE = 4000;

function normalizeCustom(raw: unknown): CustomCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['name'] !== 'string' || !NAME_RE.test(r['name'])) return null;
  if (typeof r['template'] !== 'string' || r['template'].length > MAX_TEMPLATE) return null;
  const kind = r['kind'];
  const normKind: SlashCommandKind = kind === 'command' || kind === 'task' ? kind : 'template';
  const target = typeof r['target'] === 'string' ? r['target'] : '';
  if (normKind !== 'template' && !target) return null;
  return {
    name: r['name'],
    description: typeof r['description'] === 'string' ? r['description'] : '',
    template: r['template'],
    kind: normKind,
    target,
    enabled: r['enabled'] !== false,
  };
}

function loadCommandFile(path: string): CustomCommand[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { commands?: unknown[] };
    const out: CustomCommand[] = [];
    for (const c of raw.commands ?? []) {
      const norm = normalizeCustom(c);
      if (norm) out.push(norm);
    }
    return out;
  } catch {
    return [];
  }
}

export function customCommandsPath(): string {
  const fromEnv = process.env.AI_FACTORY_COMMANDS_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'slash-commands.json');
}

export function loadCustomCommands(): CustomCommand[] {
  return loadCommandFile(customCommandsPath());
}

export function saveCustomCommands(commands: CustomCommand[]): void {
  const path = customCommandsPath();
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ commands }, null, 2), 'utf8');
}

/** Project-scope file: <root>/.ai-factory/slash-commands.json. */
export function projectCommandsPath(root: string): string {
  return join(root, '.ai-factory', 'slash-commands.json');
}

export function loadProjectCommands(root: string): CustomCommand[] {
  return loadCommandFile(projectCommandsPath(root));
}

export function saveProjectCommands(root: string, commands: CustomCommand[]): void {
  const path = projectCommandsPath(root);
  mkdirSync(resolve(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ commands }, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * Setter-injected deps (index.ts): the root jail and the task-chain
 * runner. The runner's outcome shape mirrors tasks.ts ChainRunOutcome
 * structurally, so no value import of ./tasks is needed (dual-mode rule).
 */
export interface SlashTaskChainOutcome {
  ok: boolean;
  chain?: { ok: boolean; results: { label: string; status: string; output: string }[]; stoppedAt: string | null };
  status?: number;
  code?: string;
  error?: string;
  errors?: string[];
}

export interface SlashCommandDeps {
  resolveRoot: (root?: string) => string;
  runTaskChain: (
    label: string,
    root: string,
    projectId: string,
    actor: string,
    ctx: RouteContext,
    extraArgs?: string[],
  ) => Promise<SlashTaskChainOutcome>;
}

let slashDeps: SlashCommandDeps | null = null;

export function setSlashCommandDeps(d: SlashCommandDeps | null): void {
  slashDeps = d;
}

function resolveProjectRoot(rawRoot?: string): string {
  if (!slashDeps) throw new Error('project slash commands are not wired (no root resolver)');
  return slashDeps.resolveRoot(rawRoot);
}

/**
 * Merged custom commands: project entries override user entries of the
 * same name; both are annotated. Warnings describe every shadow so a
 * builtin (or user command) is never silently replaced.
 */
export function loadMergedCommands(root?: string): { custom: ListedCommand[]; warnings: string[] } {
  const user = loadCustomCommands();
  const userNames = new Set(user.map((c) => c.name));
  const merged = new Map<string, ListedCommand>();
  for (const c of user) {
    merged.set(c.name, {
      ...c,
      source: 'user',
      shadowsBuiltin: BUILTINS.some((b) => b.name === c.name),
      shadowsUser: false,
    });
  }
  const warnings: string[] = [];
  if (root) {
    for (const c of loadProjectCommands(root)) {
      merged.set(c.name, {
        ...c,
        source: 'project',
        shadowsBuiltin: BUILTINS.some((b) => b.name === c.name),
        shadowsUser: userNames.has(c.name),
      });
    }
  }
  const custom = [...merged.values()];
  for (const c of custom) {
    if (c.shadowsBuiltin) {
      warnings.push(`/${c.name} is shadowed by a ${c.source} command (built-in /${c.name} will not run)`);
    } else if (c.shadowsUser) {
      warnings.push(`/${c.name}: project command overrides user command`);
    }
  }
  return { custom, warnings };
}

export interface BuiltinCommand {
  name: string;
  description: string;
  usage: string;
}

export const BUILTINS: BuiltinCommand[] = [
  { name: 'help', description: 'List available commands', usage: '/help' },
  { name: 'plan', description: 'Create a PENDING plan-mode plan for a task', usage: '/plan <taskId> <goal>' },
  { name: 'review', description: 'Show review dimensions and usage', usage: '/review' },
  { name: 'lint', description: "Run the project's lint quality gate", usage: '/lint (projectId in body)' },
  { name: 'test', description: "Run the project's test quality gate", usage: '/test (projectId in body)' },
  { name: 'run', description: 'Run the lint gate, then the test gate', usage: '/run (projectId in body)' },
  { name: 'map', description: 'Show the importance-ranked repo map for a root', usage: '/map [root] [maxTokens]' },
  { name: 'map-refresh', description: 'Force a full repo map rebuild for a root', usage: '/map-refresh [root]' },
  { name: 'providers', description: 'List deterministic @-context providers for run prompts', usage: '/providers' },
];

/** Parse "/name arg1 arg2" → { name, args } or an error string. */
export function parseSlashInput(input: string): { name: string; args: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { error: 'not a slash command (must start with /)' };
  const space = trimmed.indexOf(' ');
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
    return { error: `invalid command name: ${name}` };
  }
  return { name, args: space === -1 ? '' : trimmed.slice(space + 1).trim() };
}

function expandTemplate(template: string, args: string): string {
  const parts = args.split(/\s+/).filter(Boolean);
  return template
    .replace(/\{args:(\d+)\}/g, (_, n: string) => parts[Number(n) - 1] ?? '')
    .replace(/\{args\}/g, args);
}

/**
 * Quote-aware split of an expanded args string into argv tokens:
 * single quotes, double quotes, backslash escapes. An unterminated
 * quote runs to end of input (documented, never throws).
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && i + 1 < text.length) { cur += text[i + 1]; i++; }
      else cur += ch;
      has = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { cur += text[i + 1]; i++; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

function listCommands(root?: string): { builtins: BuiltinCommand[]; custom: ListedCommand[]; warnings: string[] } {
  const { custom, warnings } = loadMergedCommands(root);
  return { builtins: BUILTINS, custom, warnings };
}

function shadowWarning(c: ListedCommand): string | undefined {
  if (c.shadowsBuiltin) return `/${c.name} is shadowed by a ${c.source} command (built-in /${c.name} will not run)`;
  if (c.shadowsUser) return `/${c.name}: project command overrides user command`;
  return undefined;
}

/** Validate one custom command body; returns an error string or null. */
function validateCustom(body: Record<string, unknown>): string | null {
  const name = body['name'];
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return 'name must match [a-z0-9][a-z0-9_-]{0,39}';
  }
  const kind = body['kind'];
  if (kind !== undefined && kind !== 'template' && kind !== 'command' && kind !== 'task') {
    return "kind must be 'template', 'command' or 'task'";
  }
  const normKind = (kind ?? 'template') as SlashCommandKind;
  const template = body['template'];
  if (normKind === 'template') {
    if (typeof template !== 'string' || !template.trim() || template.length > MAX_TEMPLATE) {
      return 'template is required (max 4000 chars)';
    }
  } else if (template !== undefined && (typeof template !== 'string' || template.length > MAX_TEMPLATE)) {
    return 'template (args template) must be a string (max 4000 chars)';
  }
  const target = body['target'];
  if (normKind === 'command') {
    if (typeof target !== 'string' || !COMMAND_ID_RE.test(target)) {
      return 'target must be a command-palette command id ([a-z0-9][a-z0-9._-]{0,63})';
    }
  }
  if (normKind === 'task') {
    if (typeof target !== 'string' || !target.trim() || target.length > 128 || /[\r\n]/.test(target)) {
      return 'target must be a non-empty tasks.json label (max 128 chars)';
    }
  }
  const scope = body['scope'];
  if (scope !== undefined && scope !== 'user' && scope !== 'project') {
    return "scope must be 'user' or 'project'";
  }
  return null;
}

function buildCustom(body: Record<string, unknown>): CustomCommand {
  const kind = (body['kind'] ?? 'template') as SlashCommandKind;
  return {
    name: body['name'] as string,
    description: typeof body['description'] === 'string' ? body['description'] : '',
    template: kind === 'template'
      ? body['template'] as string
      : (typeof body['template'] === 'string' ? body['template'] : '{args}'),
    kind,
    target: kind === 'template' ? '' : body['target'] as string,
    enabled: body['enabled'] !== false,
  };
}

export async function handleCommandRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/commands[?root=] — list (merged user + project + warnings).
  if (method === 'GET' && path === PREFIX) {
    const rawRoot = url.searchParams.get('root');
    try {
      const root = rawRoot ? resolveProjectRoot(rawRoot) : undefined;
      ctx.json(res, 200, listCommands(root));
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes('outside the allowed roots') ? 403 : msg.includes('not wired') ? 503 : 400;
      ctx.json(res, status, { error: msg });
    }
    return true;
  }

  // POST /api/commands — manage custom commands.
  // {op:'add'|'remove'|'update'|'enable'|'disable', name, scope?('user'|'project'),
  //  root?, kind?, target?, template?, description?, enabled?, override?}
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const op = body['op'];
    const scope = body['scope'] === 'project' ? 'project' : 'user';
    const readScope = (): { list: CustomCommand[]; root: string | null } => {
      if (scope === 'user') return { list: loadCustomCommands(), root: null };
      const root = resolveProjectRoot(typeof body['root'] === 'string' ? body['root'] : undefined);
      return { list: loadProjectCommands(root), root };
    };
    const writeScope = (root: string | null, list: CustomCommand[]): void => {
      if (scope === 'user') saveCustomCommands(list);
      else saveProjectCommands(root as string, list);
    };
    try {
      if (op === 'add') {
        const err = validateCustom(body);
        if (err) {
          ctx.json(res, 400, { error: err });
          return true;
        }
        const name = body['name'] as string;
        const isBuiltin = BUILTINS.some((b) => b.name === name);
        if (isBuiltin && body['override'] !== true) {
          ctx.json(res, 409, { error: `/${name} is a built-in command (pass override: true to shadow it)` });
          return true;
        }
        const { list, root } = readScope();
        const command = buildCustom(body);
        writeScope(root, [...list.filter((c) => c.name !== name), command]);
        ctx.audit.record('human', 'COMMAND_ADDED', 'command', name, {
          scope, kind: command.kind, target: command.target,
          ...(isBuiltin ? { overridesBuiltin: true } : {}),
        });
        ctx.json(res, 201, {
          ok: true,
          command,
          ...(isBuiltin ? { warning: `/${name} shadows built-in /${name}` } : {}),
        });
        return true;
      }
      if (op === 'remove') {
        const name = body['name'];
        if (typeof name !== 'string') {
          ctx.json(res, 400, { error: 'name is required' });
          return true;
        }
        const { list, root } = readScope();
        writeScope(root, list.filter((c) => c.name !== name));
        ctx.audit.record('human', 'COMMAND_REMOVED', 'command', name, { scope });
        ctx.json(res, 200, { ok: true });
        return true;
      }
      if (op === 'update') {
        const name = body['name'];
        if (typeof name !== 'string') {
          ctx.json(res, 400, { error: 'name is required' });
          return true;
        }
        const { list, root } = readScope();
        const existing = list.find((c) => c.name === name);
        if (!existing) {
          ctx.json(res, 404, { error: `no ${scope} command: /${name}` });
          return true;
        }
        const merged = { ...existing, ...body, name };
        const err = validateCustom(merged);
        if (err) {
          ctx.json(res, 400, { error: err });
          return true;
        }
        const command = buildCustom(merged as Record<string, unknown>);
        writeScope(root, list.map((c) => (c.name === name ? command : c)));
        ctx.audit.record('human', 'COMMAND_UPDATED', 'command', name, { scope, kind: command.kind });
        ctx.json(res, 200, { ok: true, command });
        return true;
      }
      if (op === 'enable' || op === 'disable') {
        const name = body['name'];
        if (typeof name !== 'string') {
          ctx.json(res, 400, { error: 'name is required' });
          return true;
        }
        const { list, root } = readScope();
        const existing = list.find((c) => c.name === name);
        if (!existing) {
          ctx.json(res, 404, { error: `no ${scope} command: /${name}` });
          return true;
        }
        const enabled = op === 'enable';
        writeScope(root, list.map((c) => (c.name === name ? { ...c, enabled } : c)));
        ctx.audit.record('human', enabled ? 'COMMAND_ENABLED' : 'COMMAND_DISABLED', 'command', name, { scope });
        ctx.json(res, 200, { ok: true, command: { ...existing, enabled } });
        return true;
      }
      ctx.json(res, 400, { error: "op must be 'add', 'remove', 'update', 'enable' or 'disable'" });
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes('outside the allowed roots') ? 403 : msg.includes('not wired') ? 503 : 400;
      ctx.json(res, status, { error: msg });
      return true;
    }
  }

  // POST /api/commands/execute — { input: "/plan ..." }.
  if (method === 'POST' && path === `${PREFIX}/execute`) {
    const body = await ctx.readBody(req);
    const input = body['input'];
    if (typeof input !== 'string' || !input.trim()) {
      ctx.json(res, 400, { error: 'input is required' });
      return true;
    }
    const parsed = parseSlashInput(input);
    if ('error' in parsed) {
      ctx.json(res, 400, { error: parsed.error });
      return true;
    }
    const { name, args } = parsed;
    const actor = typeof body['actor'] === 'string' && body['actor'] ? body['actor'] : 'human';

    // R6-A7 resolution: project > user > built-in. A custom command that
    // shadows a built-in (added with override: true) wins, with a
    // warning attached to the response — never silently.
    let execRoot: string | undefined;
    if (typeof body['root'] === 'string' && body['root']) {
      try {
        execRoot = resolveProjectRoot(body['root']);
      } catch (e) {
        const msg = (e as Error).message;
        const status = msg.includes('outside the allowed roots') ? 403 : msg.includes('not wired') ? 503 : 400;
        ctx.json(res, status, { error: msg });
        return true;
      }
    } else if (slashDeps) {
      try {
        execRoot = slashDeps.resolveRoot(undefined);
      } catch {
        execRoot = undefined;
      }
    }
    const merged = loadMergedCommands(execRoot).custom;
    const custom = merged.find((c) => c.name === name);
    if (custom) {
      if (!custom.enabled) {
        ctx.json(res, 409, { error: `command disabled: /${name}` });
        return true;
      }
      const warning = shadowWarning(custom);
      if (custom.kind === 'template') {
        const text = expandTemplate(custom.template, args);
        ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', name, { kind: 'template', args: args.slice(0, 200) });
        ctx.json(res, 200, { type: 'template', name, text, ...(warning ? { warning } : {}) });
        return true;
      }
      if (custom.kind === 'command') {
        const expanded = expandTemplate(custom.template, args);
        ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', name, { kind: 'command', target: custom.target, args: args.slice(0, 200) });
        ctx.json(res, 200, { type: 'command', name, commandId: custom.target, args: expanded, ...(warning ? { warning } : {}) });
        return true;
      }
      // kind 'task': run the chain through the shared task runner.
      if (!slashDeps || !execRoot) {
        ctx.json(res, 503, { error: 'task commands are not wired' });
        return true;
      }
      const projectId = typeof body['projectId'] === 'string' && body['projectId'] ? body['projectId'] : 'default';
      const expandedArgs = splitArgs(expandTemplate(custom.template, args));
      const outcome = await slashDeps.runTaskChain(custom.target, execRoot, projectId, actor, ctx, expandedArgs);
      if (!outcome.ok) {
        ctx.json(res, outcome.status ?? 500, {
          error: outcome.error ?? 'task chain failed',
          ...(outcome.errors ? { errors: outcome.errors } : {}),
        });
        return true;
      }
      ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', name, { kind: 'task', target: custom.target, expandedArgs: expandedArgs.slice(0, 20) });
      ctx.json(res, 200, {
        type: 'task', name, label: custom.target, expandedArgs,
        chain: outcome.chain, ...(warning ? { warning } : {}),
      });
      return true;
    }

    if (name === 'help') {
      ctx.json(res, 200, { type: 'help', ...listCommands(execRoot) });
      return true;
    }

    if (name === 'plan') {
      // §23.3 approvals are task-bound: /plan <taskId> <goal>.
      const firstSpace = args.indexOf(' ');
      const taskId = firstSpace === -1 ? '' : args.slice(0, firstSpace).trim();
      const goal = firstSpace === -1 ? '' : args.slice(firstSpace + 1).trim();
      if (!taskId || !goal) {
        ctx.json(res, 400, { error: 'usage: /plan <taskId> <goal>' });
        return true;
      }
      try {
        try {
          ctx.tasks.get(taskId);
        } catch {
          ctx.json(res, 404, { error: `task not found: ${taskId}` });
          return true;
        }
        const st = new PlanStore();
        const lines = goal.split('\n').map((l) => l.trim()).filter(Boolean);
        const steps = lines.length > 1
          ? lines.map((title) => ({ title }))
          : [
              { title: 'Explore the relevant code (read-only)' },
              { title: 'Propose detailed implementation steps' },
              { title: 'Implement after plan approval' },
            ];
        const plan = st.create({
          title: goal.length > 80 ? `${goal.slice(0, 77)}…` : goal,
          goal,
          steps,
          taskId,
          createdBy: actor,
        });
        const approval = new ApprovalManager(ctx.fdb.approvals, {
          audit: (action, entityId, details) =>
            ctx.audit.record('slash-command', action, 'approval', entityId, details),
        }).request({
          action: 'plan.execute',
          requester: actor,
          task_id: taskId,
          candidate_digest: planContentDigest({ title: plan.title, goal: plan.goal, steps: plan.steps }),
          risk_level: 'MEDIUM',
          required_approvers: ['human'],
          reversibility_ref: `plan:${plan.id}`,
        });
        const bound = st.bindApproval(plan.id, approval.approval_id);
        ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', 'plan', { plan_id: plan.id });
        ctx.json(res, 201, { type: 'plan', plan: bound, approval });
        return true;
      } catch (e) {
        ctx.json(res, 400, { error: (e as Error).message });
        return true;
      }
    }

    if (name === 'review') {
      // Discoverability: a real review needs files/diff (POST /api/review),
      // which a one-line command cannot supply — say so honestly.
      ctx.json(res, 200, {
        type: 'review',
        message: 'A full review needs files or a diff — use the Review tab (POST /api/review).',
        dimensionsEndpoint: '/api/review/dimensions',
        reviewEndpoint: '/api/review',
      });
      return true;
    }

    if (name === 'lint' || name === 'test' || name === 'run') {
      // Deterministic quality gates (quality-gate.ts): run the project's
      // configured lint/test commands and report. No fixing happens here —
      // the gate only runs, judges, and reports.
      const projectId = typeof body['projectId'] === 'string' ? body['projectId'].trim() : '';
      if (!projectId) {
        ctx.json(res, 400, { error: `/${name} needs projectId in the request body` });
        return true;
      }
      const kinds: QualityGateKind[] = name === 'run' ? ['lint', 'test'] : [name];
      const results: unknown[] = [];
      for (const kind of kinds) {
        try {
          const { result, blocked } = await executeQualityGate(ctx, projectId, kind, {
            actor,
            trigger: 'slash',
          });
          results.push({ ...result, blocked });
        } catch (e) {
          ctx.json(res, 500, { error: (e as Error).message });
          return true;
        }
      }
      ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', name, { projectId });
      ctx.json(res, 200, { type: 'quality-gate', results });
      return true;
    }

    if (name === 'map' || name === 'map-refresh') {
      // Deterministic repo map (@ai-factory/repomap): importance-ranked
      // structural summary. /map rebuilds incrementally (unchanged
      // files reused); /map-refresh forces a full re-walk.
      const parts = args.split(/\s+/).filter(Boolean);
      let root = parts[0] ?? '';
      if (!root) {
        const envRoots = (process.env.FACTORY_CODEINDEX_ROOTS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        root = envRoots[0] ?? '';
      }
      if (!root) {
        ctx.json(res, 400, { error: 'usage: /map [root] [maxTokens] (or set FACTORY_CODEINDEX_ROOTS)' });
        return true;
      }
      const maxTokens = Math.min(
        100000,
        Math.max(100, Math.floor(Number(parts[1])) || 20000),
      );
      try {
        const { markdown, stats } = await getRepoMapService().buildMap(root, {
          maxTokens,
          full: name === 'map-refresh',
        });
        ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', name, {
          root: stats.root,
          files: stats.files,
          symbols: stats.symbols,
          truncated: stats.truncated,
        });
        ctx.json(res, 200, { type: 'map', command: name, root: stats.root, markdown, stats });
      } catch (e) {
        if (e instanceof RepoMapError) {
          const status = e.code === 'ROOT_DENIED' ? 403 : 400;
          ctx.json(res, status, { error: e.code, detail: e.message });
          return true;
        }
        ctx.json(res, 500, { error: (e as Error).message });
      }
      return true;
    }

    if (name === 'providers') {
      // Deterministic @-context providers (task ⑥): the same providers
      // run creation resolves in script text (@diff/@terminal/@problems/
      // @tree/@open). Listing is read-only metadata — no resolution runs.
      ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', 'providers', {});
      ctx.json(res, 200, { type: 'providers', providers: CONTEXT_PROVIDER_METAS });
      return true;
    }

    ctx.json(res, 404, { error: `unknown command: /${name} (try /help)` });
    return true;
  }

  return false;
}
