/**
 * Session routes (W-D) — conversation-level sessions + session checkpoints.
 *
 *   GET  /api/sessions                              list sessions
 *   POST /api/sessions            {title, projectId?} → 201 session
 *   GET  /api/sessions/:id                          one session
 *   POST /api/sessions/:id/archive                  archive it
 *   POST /api/sessions/:id/attach  {runId?|taskId?}  link a run/task
 *   POST /api/sessions/:id/resume                   resume bundle
 *        (session + task states + per-run §28.3 resume points — the
 *        `codex resume` / `/resume` equivalent: everything a client
 *        needs to continue the conversation)
 *   POST /api/sessions/:id/checkpoints {label?, codeRoot?}
 *        → 201 session checkpoint (session snapshot + run resume
 *        points + best-effort git diff of codeRoot)
 *   GET  /api/sessions/:id/checkpoints               list checkpoints
 *   POST /api/sessions/:id/checkpoints/:cid/restore  one-click rollback:
 *        auto-snapshots current state first (so restore is reversible),
 *        restores the session record atomically, then applies the code
 *        diff with `git apply --check` first — fail-closed, never partial.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) already gives
 * GET → viewer, POST → operator for this prefix — no auth.ts change.
 * The coordinator wires this in: handleSessionRoutes(req, res, url, ctx).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import type { RouteContext } from './context';
import {
  SessionCheckpointStore,
  SessionStore,
  type RunResumePoint,
  type Session,
} from '../session-store';

const PREFIX = '/api/sessions';

const sessionStore = new SessionStore();
const checkpointStore = new SessionCheckpointStore();

function actorOf(body: Record<string, unknown>): string {
  const c = body['createdBy'];
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 64) : 'human';
}

/** The server's control data dir — code capture/apply may never target it. */
function controlDataDir(): string {
  return resolve(process.env.AI_FACTORY_DATA_DIR ?? 'data');
}

function codeRootDenied(codeRoot: string): boolean {
  const dir = controlDataDir();
  return codeRoot === dir || codeRoot.startsWith(dir + sep);
}

/** Latest §28.3 checkpoint position per run, straight from the checkpoints table. */
function runResumePoints(ctx: RouteContext, runIds: string[]): RunResumePoint[] {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => '?').join(',');
  const rows = ctx.fdb.db
    .prepare(
      `SELECT run_id AS runId, MAX(step_position) AS pos, MAX(captured_at) AS cap
         FROM checkpoints WHERE run_id IN (${placeholders}) GROUP BY run_id`,
    )
    .all(...runIds) as Array<{ runId: string; pos: number | null; cap: number | null }>;
  const byRun = new Map(rows.map((r) => [r.runId, r]));
  return runIds.map((runId) => {
    const r = byRun.get(runId);
    return {
      runId,
      stepPosition: r && r.pos !== null ? Number(r.pos) : -1,
      capturedAt: r && r.cap !== null ? Number(r.cap) : 0,
    };
  });
}

function resumeEndpoint(runId: string): string {
  return `/api/runtime/runs/${encodeURIComponent(runId)}/resume`;
}

/** Best-effort `git apply` — `--check` first, fail-closed, never partial. */
function tryApplyCodeDiff(codeRoot: string, diff: string): { applied: boolean; reason: string } {
  try {
    execFileSync('git', ['-C', codeRoot, 'apply', '--check', '-'], {
      input: diff,
      timeout: 30_000,
    });
  } catch {
    return { applied: false, reason: 'apply-check-failed' };
  }
  try {
    execFileSync('git', ['-C', codeRoot, 'apply', '-'], { input: diff, timeout: 60_000 });
    return { applied: true, reason: '' };
  } catch {
    return { applied: false, reason: 'apply-failed' };
  }
}

export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  const notFound = (entity: string) => ctx.json(res, 404, { error: `${entity} not found` });

  // GET /api/sessions — list.
  if (method === 'GET' && path === PREFIX) {
    ctx.json(res, 200, { sessions: sessionStore.list() });
    return true;
  }

  // POST /api/sessions — create.
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    const title = body['title'];
    if (typeof title !== 'string' || !title.trim()) {
      ctx.json(res, 400, { error: 'title is required' });
      return true;
    }
    const projectId = body['projectId'];
    try {
      const s = sessionStore.create({
        title: title.trim(),
        projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null,
        createdBy: actorOf(body),
      });
      ctx.audit.record(actorOf(body), 'SESSION_CREATED', 'session', s.id, { title: s.title });
      ctx.json(res, 201, { session: s });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('corrupt') ? 503 : 400;
      ctx.json(res, code, { error: msg });
    }
    return true;
  }

  const rest = path.slice(PREFIX.length + 1); // e.g. "<id>" / "<id>/archive" / ...
  const parts = rest.split('/');
  const [id, seg2, seg3] = parts;

  // GET /api/sessions/:id
  if (method === 'GET' && seg2 === undefined) {
    const s = sessionStore.get(id);
    if (!s) return notFound('session'), true;
    ctx.json(res, 200, { session: s });
    return true;
  }

  // POST /api/sessions/:id/archive
  if (method === 'POST' && seg2 === 'archive' && seg3 === undefined) {
    try {
      const s = sessionStore.archive(id);
      const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
      ctx.audit.record(actorOf(body), 'SESSION_ARCHIVED', 'session', id, {});
      ctx.json(res, 200, { session: s });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.json(res, msg.includes('not found') ? 404 : 400, { error: msg });
    }
    return true;
  }

  // POST /api/sessions/:id/attach {runId?|taskId?}
  if (method === 'POST' && seg2 === 'attach' && seg3 === undefined) {
    const body = await ctx.readBody(req);
    const runId = body['runId'];
    const taskId = body['taskId'];
    if (typeof runId !== 'string' && typeof taskId !== 'string') {
      ctx.json(res, 400, { error: 'runId or taskId is required' });
      return true;
    }
    if (typeof runId === 'string') {
      if (!ctx.fdb.runs.get(runId)) {
        ctx.json(res, 404, { error: `run not found: ${runId}` });
        return true;
      }
    }
    if (typeof taskId === 'string') {
      let task: unknown;
      try {
        task = ctx.tasks.get(taskId);
      } catch {
        task = undefined; // TaskManager.get throws TaskNotFoundError
      }
      if (!task) {
        ctx.json(res, 404, { error: `task not found: ${taskId}` });
        return true;
      }
    }
    try {
      let s: Session | undefined;
      if (typeof runId === 'string') s = sessionStore.attach(id, 'run', runId);
      if (typeof taskId === 'string') s = sessionStore.attach(id, 'task', taskId);
      ctx.audit.record(actorOf(body), 'SESSION_ATTACHED', 'session', id, {
        ...(typeof runId === 'string' ? { run_id: runId } : {}),
        ...(typeof taskId === 'string' ? { task_id: taskId } : {}),
      });
      ctx.json(res, 200, { session: s });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.json(res, msg.includes('not found') ? 404 : 400, { error: msg });
    }
    return true;
  }

  // POST /api/sessions/:id/resume — the resume bundle.
  if (method === 'POST' && seg2 === 'resume' && seg3 === undefined) {
    const s = sessionStore.get(id);
    if (!s) return notFound('session'), true;
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const tasks: Array<Record<string, unknown>> = [];
    for (const tid of s.taskIds) {
      try {
        tasks.push(ctx.tasks.get(tid) as unknown as Record<string, unknown>);
      } catch {
        /* task deleted since attach — skip, don't break resume */
      }
    }
    const points = runResumePoints(ctx, s.runIds).map((p) => ({
      ...p,
      resumeEndpoint: resumeEndpoint(p.runId),
      hasCheckpoint: p.stepPosition >= 0,
    }));
    ctx.audit.record(actorOf(body), 'SESSION_RESUMED', 'session', id, {
      task_count: tasks.length,
      run_count: points.length,
    });
    ctx.json(res, 200, {
      session: s,
      tasks,
      runResumePoints: points,
      checkpointIds: s.checkpointIds,
      resumedAt: new Date().toISOString(),
    });
    return true;
  }

  // GET /api/sessions/:id/checkpoints — list.
  if (method === 'GET' && seg2 === 'checkpoints' && seg3 === undefined) {
    if (!sessionStore.get(id)) return notFound('session'), true;
    ctx.json(res, 200, { checkpoints: checkpointStore.list(id) });
    return true;
  }

  // POST /api/sessions/:id/checkpoints — create.
  if (method === 'POST' && seg2 === 'checkpoints' && seg3 === undefined) {
    const s = sessionStore.get(id);
    if (!s) return notFound('session'), true;
    const body = await ctx.readBody(req);
    const rawRoot = body['codeRoot'];
    let codeRoot: string | null = null;
    if (typeof rawRoot === 'string' && rawRoot.trim()) {
      codeRoot = resolve(rawRoot.trim());
      if (codeRootDenied(codeRoot)) {
        ctx.json(res, 403, { error: 'codeRoot must not point inside the server data dir', code: 'SESSION_CODE_ROOT_DENIED' });
        return true;
      }
    }
    try {
      const cp = checkpointStore.create({
        session: s,
        runResumePoints: runResumePoints(ctx, s.runIds),
        label: typeof body['label'] === 'string' ? body['label'] : undefined,
        createdBy: actorOf(body),
        codeRoot,
      });
      sessionStore.linkCheckpoint(id, cp.id);
      ctx.audit.record(actorOf(body), 'SESSION_CHECKPOINT_CREATED', 'session', id, {
        checkpoint_id: cp.id,
        label: cp.label,
        code_captured: cp.gitDiff !== null,
      });
      ctx.json(res, 201, { checkpoint: cp });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.json(res, msg.includes('corrupt') ? 503 : 400, { error: msg });
    }
    return true;
  }

  // POST /api/sessions/:id/checkpoints/:cid/restore — one-click rollback.
  if (method === 'POST' && seg2 === 'checkpoints' && parts.length === 4 && parts[3] === 'restore') {
    const cid = parts[2];
    const s = sessionStore.get(id);
    if (!s) return notFound('session'), true;
    const cp = checkpointStore.get(cid);
    if (!cp || cp.sessionId !== id) {
      ctx.json(res, 404, { error: `checkpoint not found: ${cid}` });
      return true;
    }
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    const actor = actorOf(body);
    try {
      // 1) Safety first: snapshot the CURRENT state so this restore is itself reversible.
      const pre = checkpointStore.create({
        session: s,
        runResumePoints: runResumePoints(ctx, s.runIds),
        label: `pre-restore ${new Date().toISOString()}`,
        createdBy: actor,
        codeRoot: cp.codeRoot,
      });
      sessionStore.linkCheckpoint(id, pre.id);
      // 2) Restore the session record atomically.
      const restored = sessionStore.restoreFromSnapshot(cp.sessionSnapshot);
      // 3) Code: apply the captured diff, --check first, fail-closed.
      let codeApplied = false;
      let codeApplyReason = cp.gitDiffNote || 'no-diff-captured';
      if (cp.gitDiff && cp.codeRoot) {
        if (codeRootDenied(cp.codeRoot)) {
          codeApplyReason = 'code-root-denied';
        } else {
          const r = tryApplyCodeDiff(cp.codeRoot, cp.gitDiff);
          codeApplied = r.applied;
          codeApplyReason = r.applied ? '' : r.reason;
        }
      }
      ctx.audit.record(actor, 'SESSION_CHECKPOINT_RESTORED', 'session', id, {
        checkpoint_id: cid,
        pre_restore_checkpoint_id: pre.id,
        code_applied: codeApplied,
        code_apply_reason: codeApplyReason,
      });
      ctx.json(res, 200, {
        session: restored,
        codeApplied,
        codeApplyReason,
        preRestoreCheckpointId: pre.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.json(res, msg.includes('corrupt') ? 503 : 400, { error: msg });
    }
    return true;
  }

  return false;
}
