/**
 * Headless CLI core (W-D) — `claude -p` / `codex exec` equivalent for AI Factory.
 *
 * Non-interactive, pipe-friendly, CI-usable:
 *   echo "summarize the board" | ai-factory exec
 *   ai-factory exec --prompt "triage open tasks" --json
 *   ai-factory resume <session-id>
 *   ai-factory checkpoint create --session <id> --label "before refactor"
 *
 * Exit codes: 0 = success, 1 = the requested operation failed
 * (run failed, entity missing, HTTP error), 2 = usage error / timeout /
 * interrupted. All network access goes through the injected HttpClient so
 * the logic is unit-testable without a server.
 */
import { createHttpClient, resolveToken, type HttpClient, type HttpResult } from './http.ts';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const DEFAULT_API = 'http://127.0.0.1:3100';
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_POLL_MS = 2000;

export interface ParsedCli {
  command: string;
  sub: string | null;
  positionals: string[];
  opts: Record<string, string | boolean>;
  error?: string;
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'h']);

export function parseArgs(argv: string[]): ParsedCli {
  const opts: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command = '';
  let sub: string | null = null;
  let i = 0;
  const takeValue = (flag: string): string | undefined => {
    const eq = flag.indexOf('=');
    if (eq !== -1) return flag.slice(eq + 1);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) return undefined;
    i++;
    return next;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (BOOLEAN_FLAGS.has(name)) {
        opts[name] = true;
        continue;
      }
      const v = takeValue(a);
      if (v === undefined) {
        return { command: '', sub: null, positionals: [], opts: {}, error: `flag --${name} requires a value` };
      }
      opts[name] = v;
      continue;
    }
    if (a === '-h') {
      opts['help'] = true;
      continue;
    }
    if (!command) command = a;
    else if ((command === 'sessions' || command === 'checkpoint') && sub === null) sub = a;
    else positionals.push(a);
  }
  return { command, sub, positionals, opts };
}

export function usage(): string {
  return [
    'ai-factory — headless CLI for the AI Factory API',
    '',
    '  exec [--prompt TEXT | stdin] [--project ID] [--agent ID] [--image a.png,b.jpg] [--timeout-ms N] [--poll-ms N]',
    '      Create a task from the prompt, dispatch an agent run, wait, print the result.',
    '  sessions list',
    '  sessions create --title TEXT [--project ID]',
    '  sessions attach --session ID [--run RUN-ID] [--task TASK-ID]',
    '  resume <session-id>                      Print the session resume bundle.',
    '  checkpoint create --session ID [--label TEXT] [--code-root DIR]',
    '  checkpoint list --session ID',
    '  checkpoint restore --session ID --id CHECKPOINT-ID',
    '',
    'Global flags: --api URL (default http://127.0.0.1:3100) --token TOKEN',
    '  (or FACTORY_API_TOKEN env) --json  -h/--help',
    '',
    'Exit codes: 0 success · 1 operation failed · 2 usage/timeout/interrupted',
  ].join('\n');
}

export interface CommandResult {
  exitCode: number;
  /** Human-readable lines, or the raw payload when --json. */
  output: unknown;
}

function asArray(body: unknown): Array<Record<string, unknown>> {
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
}

function err(status: number, body: unknown, fallback: string): CommandResult {
  const msg =
    body && typeof body === 'object' && typeof (body as Record<string, unknown>)['error'] === 'string'
      ? String((body as Record<string, unknown>)['error'])
      : fallback;
  return { exitCode: EXIT_FAILED, output: [`error: HTTP ${status}: ${msg}`] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ExecRequest {
  prompt: string;
  projectId?: string;
  agentId?: string;
  /** W-E: local image paths to attach to the task (comma-separated at the CLI). */
  images?: string[];
  json: boolean;
  timeoutMs: number;
  pollMs: number;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** W-E: upload one local image to the task's attachments. Throws on failure. */
export async function uploadTaskImage(
  http: HttpClient,
  taskId: string,
  filePath: string,
): Promise<void> {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`image not found: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  if (stat.size > 10 * 1024 * 1024) throw new Error(`image exceeds 10 MiB: ${filePath}`);
  const mime = IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()];
  if (!mime) throw new Error(`unsupported image type (png/jpg/webp/gif): ${filePath}`);
  const dataBase64 = readFileSync(filePath).toString('base64');
  const r = await http.request('POST', `/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
    filename: basename(filePath),
    mimeType: mime,
    dataBase64,
  });
  if (!r || r.status !== 201) {
    throw new Error(`upload failed for ${filePath}: HTTP ${r?.status ?? 'request failed'}`);
  }
}

/** exec: task → agent run → poll → result. */
export async function execCommand(req: ExecRequest, http: HttpClient): Promise<CommandResult> {
  const prompt = req.prompt.trim();
  if (!prompt) return { exitCode: EXIT_USAGE, output: ['error: empty prompt — pass --prompt or pipe via stdin'] };

  // Project: explicit, else the first active project.
  let projectId = req.projectId;
  if (!projectId) {
    const pr = await http.request('GET', '/api/projects').catch(() => null);
    if (!pr || pr.status !== 200) {
      return { exitCode: EXIT_FAILED, output: ['error: could not list projects'] };
    }
    const first = asArray(pr.body)[0];
    if (!first || typeof first['id'] !== 'string') {
      return { exitCode: EXIT_FAILED, output: ['error: no projects on the server (create one in the desktop app first)'] };
    }
    projectId = String(first['id']);
  }

  // Task.
  const title = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt;
  const tr = await http.request('POST', '/api/tasks', { projectId, title, goal: prompt }).catch(() => null);
  if (!tr || tr.status !== 201) {
    return tr ? err(tr.status, tr.body, 'task creation failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const task = tr.body as Record<string, unknown>;
  const taskId = task && typeof task['id'] === 'string' ? String(task['id']) : null;
  if (!taskId) return { exitCode: EXIT_FAILED, output: ['error: server did not return a task id'] };

  // W-E: attach images before the run starts. A failed upload is loud —
  // the task exists, but the run must not proceed pretending it saw them.
  for (const img of req.images ?? []) {
    try {
      await uploadTaskImage(http, taskId, img);
    } catch (e) {
      return { exitCode: EXIT_FAILED, output: [`error: ${(e as Error).message} (task ${taskId} created without it)`] };
    }
  }

  // Agent: explicit, else the first registered agent.
  let agentId = req.agentId;
  if (!agentId) {
    const ar = await http.request('GET', '/api/agents').catch(() => null);
    if (!ar || ar.status !== 200) {
      return { exitCode: EXIT_FAILED, output: ['error: could not list agents'] };
    }
    const first = asArray(ar.body)[0];
    if (!first || typeof first['id'] !== 'string') {
      return { exitCode: EXIT_FAILED, output: ['error: no agents registered (create one in the desktop app first)'] };
    }
    agentId = String(first['id']);
  }

  // Run.
  const rr = await http.request('POST', '/api/runtime/runs', { agentId, taskId }).catch(() => null);
  if (!rr || (rr.status !== 200 && rr.status !== 202)) {
    return rr ? err(rr.status, rr.body, 'run start failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const runId = String((rr.body as Record<string, unknown>)['id'] ?? '');
  if (!runId) return { exitCode: EXIT_FAILED, output: ['error: server did not return a run id'] };

  // Poll until terminal.
  const deadline = Date.now() + req.timeoutMs;
  for (;;) {
    const gr = await http.request('GET', `/api/runtime/runs/${encodeURIComponent(runId)}`).catch(() => null);
    if (!gr || gr.status !== 200) {
      return { exitCode: EXIT_FAILED, output: ['error: lost the run while polling'] };
    }
    const status = String((gr.body as Record<string, unknown>)['status'] ?? '');
    if (status === 'COMPLETED' || status === 'FAILED') {
      const payload = { taskId, runId, status, run: gr.body };
      return {
        exitCode: status === 'COMPLETED' ? EXIT_OK : EXIT_FAILED,
        output: req.json ? payload : [`run ${status.toLowerCase()}: task=${taskId} run=${runId}`],
      };
    }
    if (Date.now() >= deadline) {
      return { exitCode: EXIT_USAGE, output: [`error: timed out after ${req.timeoutMs}ms waiting for run ${runId}`] };
    }
    await sleep(req.pollMs);
  }
}

export async function sessionsList(http: HttpClient, json: boolean): Promise<CommandResult> {
  const r = await http.request('GET', '/api/sessions').catch(() => null);
  if (!r || r.status !== 200) {
    return r ? err(r.status, r.body, 'list failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const sessions = asArray((r.body as Record<string, unknown>)['sessions']);
  if (json) return { exitCode: EXIT_OK, output: { sessions } };
  const lines =
    sessions.length === 0
      ? ['(no sessions yet)']
      : sessions.map(
          (s) =>
            `${String(s['id']).slice(0, 8)}  [${s['status']}] ${s['title']}  runs=${(s['runIds'] as unknown[]).length} tasks=${(s['taskIds'] as unknown[]).length} checkpoints=${(s['checkpointIds'] as unknown[]).length}`,
        );
  return { exitCode: EXIT_OK, output: lines };
}

export async function sessionsCreate(
  http: HttpClient,
  title: string,
  projectId: string | undefined,
  json: boolean,
): Promise<CommandResult> {  if (!title.trim()) return { exitCode: EXIT_USAGE, output: ['error: --title is required'] };
  const r = await http
    .request('POST', '/api/sessions', { title: title.trim(), ...(projectId ? { projectId } : {}) })
    .catch(() => null);
  if (!r || r.status !== 201) {
    return r ? err(r.status, r.body, 'create failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const session = (r.body as Record<string, unknown>)['session'] as Record<string, unknown>;
  return {
    exitCode: EXIT_OK,
    output: json ? { session } : [`created session ${String(session['id'])} — "${String(session['title'])}"`],
  };
}

export async function sessionsAttach(
  http: HttpClient,
  sessionId: string,
  runId: string | undefined,
  taskId: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  if (!sessionId) return { exitCode: EXIT_USAGE, output: ['error: --session is required'] };
  if (!runId && !taskId) return { exitCode: EXIT_USAGE, output: ['error: --run or --task is required'] };
  const r = await http
    .request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
      ...(runId ? { runId } : {}),
      ...(taskId ? { taskId } : {}),
    })
    .catch(() => null);
  if (!r || r.status !== 200) {
    return r ? err(r.status, r.body, 'attach failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const session = (r.body as Record<string, unknown>)['session'] as Record<string, unknown>;
  return {
    exitCode: EXIT_OK,
    output: json ? { session } : [`attached to session ${String(session['id'])}`],
  };
}

export async function resumeSession(http: HttpClient, id: string, json: boolean): Promise<CommandResult> {
  if (!id) return { exitCode: EXIT_USAGE, output: ['error: session id is required'] };
  const r = await http.request('POST', `/api/sessions/${encodeURIComponent(id)}/resume`, {}).catch(() => null);
  if (!r || r.status !== 200) {
    return r ? err(r.status, r.body, 'resume failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  if (json) return { exitCode: EXIT_OK, output: r.body };
  const b = r.body as Record<string, unknown>;
  const session = b['session'] as Record<string, unknown>;
  const tasks = asArray(b['tasks']);
  const points = asArray(b['runResumePoints']);
  const lines = [
    `session: ${String(session['id'])} — "${String(session['title'])}" [${session['status']}]`,
    `tasks (${tasks.length}):`,
    ...tasks.map((t) => `  - ${String(t['id']).slice(0, 8)} ${t['title']} [${t['status'] ?? '?'}]`),
    `runs (${points.length}):`,
    ...points.map(
      (p) =>
        `  - ${String(p['runId']).slice(0, 8)} step=${p['stepPosition']}${p['hasCheckpoint'] ? '' : ' (no checkpoint)'} → POST ${p['resumeEndpoint']}`,
    ),
    `checkpoints: ${(b['checkpointIds'] as unknown[]).length}`,
  ];
  return { exitCode: EXIT_OK, output: lines };
}

export async function checkpointCreate(
  http: HttpClient,
  sessionId: string,
  label: string | undefined,
  codeRoot: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  if (!sessionId) return { exitCode: EXIT_USAGE, output: ['error: --session is required'] };
  const r = await http
    .request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`, {
      ...(label ? { label } : {}),
      ...(codeRoot ? { codeRoot } : {}),
    })
    .catch(() => null);
  if (!r || r.status !== 201) {
    return r ? err(r.status, r.body, 'checkpoint failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const cp = (r.body as Record<string, unknown>)['checkpoint'] as Record<string, unknown>;
  return {
    exitCode: EXIT_OK,
    output: json
      ? { checkpoint: cp }
      : [
          `checkpoint ${String(cp['id'])} — "${String(cp['label'])}"`,
          `  code: ${cp['gitDiff'] ? `captured (${String(cp['gitDiff']).length} chars${cp['gitDiffTruncated'] ? ', truncated' : ''})` : `not captured (${cp['gitDiffNote']})`}`,
        ],
  };
}

export async function checkpointList(http: HttpClient, sessionId: string, json: boolean): Promise<CommandResult> {
  if (!sessionId) return { exitCode: EXIT_USAGE, output: ['error: --session is required'] };
  const r = await http.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`).catch(() => null);
  if (!r || r.status !== 200) {
    return r ? err(r.status, r.body, 'list failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const cps = asArray((r.body as Record<string, unknown>)['checkpoints']);
  if (json) return { exitCode: EXIT_OK, output: { checkpoints: cps } };
  const lines =
    cps.length === 0
      ? ['(no checkpoints)']
      : cps.map((c) => `${String(c['id'])}  ${c['createdAt']}  "${c['label']}"${c['gitDiff'] ? '  [code]' : ''}`);
  return { exitCode: EXIT_OK, output: lines };
}

export async function checkpointRestore(
  http: HttpClient,
  sessionId: string,
  checkpointId: string | undefined,
  json: boolean,
): Promise<CommandResult> {
  if (!sessionId) return { exitCode: EXIT_USAGE, output: ['error: --session is required'] };
  if (!checkpointId) return { exitCode: EXIT_USAGE, output: ['error: --id is required'] };
  const r = await http
    .request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, {})
    .catch(() => null);
  if (!r || r.status !== 200) {
    return r ? err(r.status, r.body, 'restore failed') : { exitCode: EXIT_FAILED, output: ['error: request failed'] };
  }
  const b = r.body as Record<string, unknown>;
  return {
    exitCode: EXIT_OK,
    output: json
      ? b
      : [
          `restored session ${sessionId} to checkpoint ${checkpointId}`,
          `  code: ${b['codeApplied'] ? 'diff applied' : `not applied (${b['codeApplyReason']})`}`,
          `  pre-restore safety checkpoint: ${b['preRestoreCheckpointId']}`,
        ],
  };
}

export { createHttpClient, resolveToken };
export type { HttpClient, HttpResult };
