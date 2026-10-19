/**
 * Slash commands (W-B) — `/cmd` parsing for the command bar.
 *
 *   GET  /api/commands           list available commands (built-ins + custom)
 *   POST /api/commands/execute   { input: "/plan fix the login bug" }
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
 * Custom commands: AI_FACTORY_DATA_DIR/slash-commands.json —
 *   [{ "name": "deploy-note", "description": "…",
 *      "template": "Write a deploy note for: {args}" }]
 * `{args}` expands to the full argument string, `{args:N}` to the Nth
 * whitespace-separated argument (1-based). Execution is deterministic
 * template expansion — no new dependencies, no hidden behavior.
 *
 * The coordinator wires this in: handleCommandRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouteContext } from './context';
import { PlanStore } from '../plan-store';
import { ApprovalManager } from '@ai-factory/approvals';
import { planContentDigest } from '../plan-store';
import { executeQualityGate, type QualityGateKind } from './quality';
import { getRepoMapService } from './repomap';
import { RepoMapError } from '@ai-factory/repomap';

const PREFIX = '/api/commands';

export interface CustomCommand {
  name: string;
  description: string;
  template: string;
}

export function customCommandsPath(): string {
  const fromEnv = process.env.AI_FACTORY_COMMANDS_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'slash-commands.json');
}

export function loadCustomCommands(): CustomCommand[] {
  const path = customCommandsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { commands?: CustomCommand[] };
    return (raw.commands ?? []).filter(
      (c) => c && typeof c.name === 'string' && typeof c.template === 'string'
        && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(c.name),
    );
  } catch {
    return [];
  }
}

export function saveCustomCommands(commands: CustomCommand[]): void {
  const path = customCommandsPath();
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ commands }, null, 2), 'utf8');
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

function listCommands(): { builtins: BuiltinCommand[]; custom: CustomCommand[] } {
  return { builtins: BUILTINS, custom: loadCustomCommands() };
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

  // GET /api/commands — list.
  if (method === 'GET' && path === PREFIX) {
    ctx.json(res, 200, listCommands());
    return true;
  }

  // POST /api/commands — manage custom commands: {op:'add'|'remove', ...}.
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const op = body['op'];
    if (op === 'add') {
      const name = body['name'];
      const template = body['template'];
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
        ctx.json(res, 400, { error: 'name must match [a-z0-9][a-z0-9_-]{0,39}' });
        return true;
      }
      if (typeof template !== 'string' || !template.trim() || template.length > 4000) {
        ctx.json(res, 400, { error: 'template is required (max 4000 chars)' });
        return true;
      }
      if (BUILTINS.some((b) => b.name === name)) {
        ctx.json(res, 409, { error: `/${name} is a built-in command` });
        return true;
      }
      const commands = loadCustomCommands().filter((c) => c.name !== name);
      const description = typeof body['description'] === 'string' ? body['description'] : '';
      commands.push({ name, description, template });
      saveCustomCommands(commands);
      ctx.audit.record('human', 'COMMAND_ADDED', 'command', name, { description });
      ctx.json(res, 201, { ok: true, command: { name, description, template } });
      return true;
    }
    if (op === 'remove') {
      const name = body['name'];
      if (typeof name !== 'string') {
        ctx.json(res, 400, { error: 'name is required' });
        return true;
      }
      const commands = loadCustomCommands().filter((c) => c.name !== name);
      saveCustomCommands(commands);
      ctx.audit.record('human', 'COMMAND_REMOVED', 'command', name, {});
      ctx.json(res, 200, { ok: true });
      return true;
    }
    ctx.json(res, 400, { error: "op must be 'add' or 'remove'" });
    return true;
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

    if (name === 'help') {
      ctx.json(res, 200, { type: 'help', ...listCommands() });
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

    const custom = loadCustomCommands().find((c) => c.name === name);
    if (custom) {
      const text = expandTemplate(custom.template, args);
      ctx.audit.record(actor, 'COMMAND_EXECUTED', 'command', name, { args: args.slice(0, 200) });
      ctx.json(res, 200, { type: 'template', name, text });
      return true;
    }

    ctx.json(res, 404, { error: `unknown command: /${name} (try /help)` });
    return true;
  }

  return false;
}
