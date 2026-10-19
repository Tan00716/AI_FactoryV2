/**
 * Schedule routes — the general task scheduler's HTTP surface.
 *
 *   GET    /api/schedules                 list schedules
 *   POST   /api/schedules                 create {name, kind, cronExpr|intervalMs, job}
 *   GET    /api/schedules/:id             one schedule
 *   PATCH  /api/schedules/:id             update {name?, status?} (pause/resume)
 *   DELETE /api/schedules/:id             delete
 *   POST   /api/schedules/:id/trigger     fire now (manual trigger)
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) gives GET →
 * viewer and every other method → operator for this prefix — no
 * auth.ts change needed. Schedules are operator-configured by design:
 * a schedule's job parameters are trusted as operator input (like the
 * backup schedules), while untrusted external content (webhook bodies)
 * is quarantined through sanitizeUntrusted() inside the scheduler.
 *
 * The coordinator (index.ts) calls initTaskScheduler(routeCtx) once at
 * boot; the singleton serves both the tick loop and these routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RouteContext } from './context';
import {
  ScheduleStore,
  TaskScheduler,
  type Schedule,
  type ScheduleJob,
  type WebhookFetchOpts,
} from '../scheduler';
import { createBackup, listBackupManifests, backupDirPath, stagedRestoreBackupId } from './backup';
import { runGuardedBackup, checkLiveDbIntegrity } from '../auto-backup';
import { startScheduledRun } from './runtime';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { networkMode } from '../network-mode';

const PREFIX = '/api/schedules';

let scheduler: TaskScheduler | null = null;
let store: ScheduleStore | null = null;

/** Real webhook fetch: node builtins only, timeout-guarded, no redirects. */
function fetchWebhookReal(url: string, opts: WebhookFetchOpts): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`invalid webhook url: ${url}`));
      return;
    }
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib(
      u,
      {
        method: opts.method,
        headers: { 'user-agent': 'ai-factory-scheduler/1.0', ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          // Cap the buffered body; the scheduler truncates + sanitizes.
          if (bytes <= 256 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`webhook timed out after ${opts.timeoutMs}ms: ${url}`));
    }, Math.max(1000, opts.timeoutMs));
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (opts.body !== undefined && opts.method === 'POST') req.write(opts.body);
    req.end();
  });
}

function actorOf(body: Record<string, unknown>): string {
  const c = body['createdBy'];
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 64) : 'human';
}

function parseJob(raw: unknown): ScheduleJob {
  if (!raw || typeof raw !== 'object') throw new Error('job is required');
  const j = raw as Record<string, unknown>;
  if (j['type'] === 'run-task') {
    const title = j['title'];
    if (typeof title !== 'string' || !title.trim()) throw new Error('run-task job requires title');
    const job: ScheduleJob = { type: 'run-task', title: title.trim() };
    if (j['goal'] !== undefined) {
      if (typeof j['goal'] !== 'string') throw new Error('run-task goal must be a string');
      job.goal = j['goal'];
    }
    if (j['projectId'] !== undefined) {
      if (typeof j['projectId'] !== 'string') throw new Error('run-task projectId must be a string');
      job.projectId = j['projectId'];
    }
    if (j['agentId'] !== undefined) {
      if (typeof j['agentId'] !== 'string') throw new Error('run-task agentId must be a string');
      job.agentId = j['agentId'];
    }
    return job;
  }
  if (j['type'] === 'webhook') {
    if (typeof j['url'] !== 'string' || !j['url'].trim()) throw new Error('webhook job requires url');
    const job: ScheduleJob = { type: 'webhook', url: j['url'].trim() };
    if (j['method'] !== undefined) {
      if (j['method'] !== 'GET' && j['method'] !== 'POST') throw new Error('webhook method must be GET or POST');
      job.method = j['method'];
    }
    if (j['headers'] !== undefined) {
      if (!j['headers'] || typeof j['headers'] !== 'object') throw new Error('webhook headers must be an object');
      job.headers = j['headers'] as Record<string, string>;
    }
    if (j['body'] !== undefined) {
      if (typeof j['body'] !== 'string') throw new Error('webhook body must be a string');
      job.body = j['body'];
    }
    if (j['timeoutMs'] !== undefined) {
      if (typeof j['timeoutMs'] !== 'number') throw new Error('webhook timeoutMs must be a number');
      job.timeoutMs = j['timeoutMs'];
    }
    if (j['forwardToTask'] !== undefined && j['forwardToTask'] !== null) {
      const f = j['forwardToTask'] as Record<string, unknown>;
      if (typeof f['title'] !== 'string' || !f['title'].trim()) {
        throw new Error('forwardToTask requires title');
      }
      if (typeof f['goalTemplate'] !== 'string' || !f['goalTemplate'].includes('{{output}}')) {
        throw new Error('forwardToTask goalTemplate must be a string containing {{output}}');
      }
      job.forwardToTask = {
        title: f['title'].trim(),
        goalTemplate: f['goalTemplate'] as string,
        ...(typeof f['agentId'] === 'string' ? { agentId: f['agentId'] } : {}),
      };
    }
    return job;
  }
  if (j['type'] === 'backup') return { type: 'backup' };
  throw new Error(`unknown job type: ${String(j['type'])}`);
}

/**
 * Wire the singleton. Called once by the coordinator at boot with the
 * server's route context; the same instance drives the tick loop.
 */
export function initTaskScheduler(ctx: RouteContext): TaskScheduler {
  store = new ScheduleStore();
  scheduler = new TaskScheduler({
    store,
    audit: {
      record: (actor, event, entityType, entityId, details) =>
        ctx.audit.record(actor, event, entityType, entityId, details),
    },
    createTask: (input) => {
      const t = ctx.tasks.create({
        title: input.title,
        goal: input.goal ?? '',
        // The seeded project; operator templates may name any existing
        // project instead (validated at creation in parseJob/POST).
        projectId: input.projectId ?? 'proj-myapp',
        creator: 'scheduler',
      });
      return { id: t.id };
    },
    startRun: async (input) => startScheduledRun(ctx, input),
    // The `backup` job goes through the auto-backup policy guard:
    // a live-DB PRAGMA quick_check gates every scheduled backup (a
    // corrupt database is never snapshotted — the firing is skipped
    // and audited), and when the auto-backup policy is enabled the
    // keep-newest-N retention prunes excess scheduled snapshots.
    runBackup: () =>
      runGuardedBackup({
        audit: {
          record: (actor, event, entityType, entityId, details) =>
            ctx.audit.record(actor, event, entityType, entityId, details),
        },
        createBackup: (kind: 'manual' | 'scheduled') => createBackup(ctx.fdb, kind),
        listBackups: () => listBackupManifests(),
        deleteBackupDir: (backupId: string) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backupId) || backupId.includes('..')) {
            throw new Error(`refusing to delete backup with unsafe id: ${backupId}`);
          }
          rmSync(join(backupDirPath(), backupId), { recursive: true, force: true });
        },
        stagedRestoreBackupId: () => stagedRestoreBackupId(),
        activeHoldCount: () => ctx.fdb.retention.countActiveHolds(),
        checkLiveDbIntegrity: () => checkLiveDbIntegrity(ctx.fdb),
      }),
    fetchWebhook: fetchWebhookReal,
    isOffline: () => networkMode().isOffline(),
  });
  return scheduler;
}

export function taskScheduler(): TaskScheduler {
  if (!scheduler) throw new Error('task scheduler not initialized');
  return scheduler;
}

/**
 * The singleton store — shared by the tick loop (inside the
 * scheduler) and these routes. A second instance would serve stale
 * reads because ScheduleStore caches in memory. Exported for the
 * auto-backup policy (routes/auto-backup.ts), which owns exactly one
 * schedule in this store and reconciles it at boot / on PUT.
 */
export function scheduleStore(): ScheduleStore {
  if (!store) store = new ScheduleStore();
  return store;
}

export async function handleScheduleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  const store = scheduleStore();
  const notFound = () => ctx.json(res, 404, { error: 'schedule not found' });

  // GET /api/schedules — list.
  if (method === 'GET' && path === PREFIX) {
    ctx.json(res, 200, { schedules: store.list() });
    return true;
  }

  // POST /api/schedules — create.
  if (method === 'POST' && path === PREFIX) {
    const body = await ctx.readBody(req);
    try {
      const kind = body['kind'];
      if (kind !== 'cron' && kind !== 'interval') {
        ctx.json(res, 400, { error: "kind must be 'cron' or 'interval'" });
        return true;
      }
      const job = parseJob(body['job']);
      // The run-task job (and webhook forwardToTask) create tasks, whose
      // project_id is a real FK — fail fast on an unknown project instead
      // of failing every firing with a FOREIGN KEY error.
      const projectId = job.type === 'run-task' ? (job.projectId ?? 'proj-myapp') : 'proj-myapp';
      if ((job.type === 'run-task' || (job.type === 'webhook' && job.forwardToTask)) && !ctx.fdb.getProject(projectId)) {
        ctx.json(res, 400, { error: `unknown project: ${projectId}` });
        return true;
      }
      const s = store.create({
        name: typeof body['name'] === 'string' ? body['name'] : '',
        kind,
        cronExpr: typeof body['cronExpr'] === 'string' ? body['cronExpr'] : undefined,
        intervalMs: typeof body['intervalMs'] === 'number' ? body['intervalMs'] : undefined,
        job,
        createdBy: actorOf(body),
      });
      ctx.audit.record(actorOf(body), 'SCHEDULE_CREATED', 'schedule', s.id, {
        name: s.name,
        kind: s.kind,
        jobType: s.job.type,
      });
      ctx.json(res, 201, { schedule: s });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.json(res, msg.includes('corrupt') ? 503 : 400, { error: msg });
    }
    return true;
  }

  const rest = path.slice(PREFIX.length + 1);
  const [id, seg2] = rest.split('/');

  // GET /api/schedules/:id
  if (method === 'GET' && seg2 === undefined) {
    const s = store.get(id);
    if (!s) return notFound(), true;
    ctx.json(res, 200, { schedule: s });
    return true;
  }

  // PATCH /api/schedules/:id — rename / pause / resume.
  if (method === 'PATCH' && seg2 === undefined) {
    const body = await ctx.readBody(req);
    try {
      const patch: { name?: string; status?: 'active' | 'paused' } = {};
      if (body['name'] !== undefined) {
        if (typeof body['name'] !== 'string') {
          ctx.json(res, 400, { error: 'name must be a string' });
          return true;
        }
        patch.name = body['name'];
      }
      if (body['status'] !== undefined) {
        if (body['status'] !== 'active' && body['status'] !== 'paused') {
          ctx.json(res, 400, { error: "status must be 'active' or 'paused'" });
          return true;
        }
        patch.status = body['status'];
      }
      const s = store.update(id, patch);
      ctx.audit.record(actorOf(body), 'SCHEDULE_UPDATED', 'schedule', id, { patch });
      ctx.json(res, 200, { schedule: s });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.json(res, msg.includes('not found') ? 404 : 400, { error: msg });
    }
    return true;
  }

  // DELETE /api/schedules/:id
  if (method === 'DELETE' && seg2 === undefined) {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      store.remove(id);
      ctx.audit.record(actorOf(body), 'SCHEDULE_DELETED', 'schedule', id, {});
      ctx.json(res, 200, { deleted: true });
    } catch (e) {
      ctx.json(res, 404, { error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }

  // POST /api/schedules/:id/trigger — manual fire.
  if (method === 'POST' && seg2 === 'trigger') {
    const body = await ctx.readBody(req).catch(() => ({} as Record<string, unknown>));
    try {
      const result = await taskScheduler().trigger(id);
      ctx.audit.record(actorOf(body), 'SCHEDULE_TRIGGERED', 'schedule', id, {
        ok: result.ok,
        summary: result.summary.slice(0, 300),
      });
      ctx.json(res, 200, { result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.json(res, msg.includes('not found') ? 404 : 500, { error: msg });
    }
    return true;
  }

  return false;
}
