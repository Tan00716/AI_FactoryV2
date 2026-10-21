/**
 * Scope Lock routes (second-round strengthening, item 8).
 *
 *   GET /api/tasks/:id/scope  → the task's edit scope + post-hoc
 *                               out-of-scope report computed from the
 *                               task's shadow-checkpoint diff plus live
 *                               worktree changes (viewer; RBAC is
 *                               centralised in auth.ts requiredRoleFor)
 *
 * The PATCH for setting the scope lives in index.ts next to the other
 * /api/tasks handlers (creation accepts `scope` too — see index.ts).
 * This module owns the READ + DETECTION side:
 *
 *  - computeTaskScopeReport(ctx, taskId): pure-read computation. The
 *    changed-file set is the union of (a) the task-scoped shadow diff
 *    ranges (files snapshotted under this task id) and (b) live
 *    worktree changes since the last snapshot (git status against the
 *    sidecar). Files outside the scope are listed with reasons.
 *  - scopeRunCompleteCheck(ctx, taskId, runId): fire-and-forget hook
 *    fired at a run's terminal write (installed by index.ts via
 *    setScopeRunCompleteHook in routes/runtime.ts) — recomputes the
 *    report and, for violations not already audited for this tip,
 *    records SCOPE_VIOLATION_DETECTED + a HIGH notification.
 *
 * HONEST BOUNDARIES:
 *  - Detection is POST-HOC. Shell/exec writes are caught here, not
 *    blocked in real time (there is no per-write interception on the
 *    exec surface). Pre-write blocking exists only where writes are
 *    enumerable up front: attributed /api/file writes and recipe plans.
 *  - The report needs a shadow workspace: a shadow config keyed by the
 *    task id (the run-start convention) or by the task's workspace
 *    path. Without one the endpoint answers `shadow: null` and an
 *    honest note — no violations are fabricated from an empty diff.
 *  - Nothing here ever rolls back. Undo is the human's decision, via
 *    the shadow-checkpoint restore (Changes / shadow tab).
 *  - The live-worktree half of the diff trusts git's own status: files
 *    shadow enumeration skips (symlinks, >5 MiB, SKIP_DIRS) are not
 *    visible to it either — stated in the report note.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Task } from '@ai-factory/core';
import type { RouteContext } from './context';
import { shadowCheckpointStore } from './shadow';
import {
  ShadowCheckpointError,
  diffShadowCheckpoints,
  sidecarPath,
  taskDiffRange,
  type ShadowConfig,
} from '../shadow-checkpoints';
import {
  detectOutOfScopePaths,
  hasScope,
  type ScopeDenyReason,
  type TaskEditScope,
} from '../scope-lock';

// ------------------------------------------------------------ git -----

/** Minimal hermetic git runner (mirrors shadow-checkpoints' helper). */
function git(args: string[], gitDir: string, workTree: string): { status: number; stdout: string } {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: process.env.HOME,
    },
  });
  return { status: r.status ?? 1, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
}

/** Files changed in the worktree since the sidecar's index/HEAD state. */
function liveWorktreeChanges(workspaceId: string, workspacePath: string): string[] {
  const gitDir = sidecarPath(workspaceId);
  if (!existsSync(join(gitDir, 'HEAD'))) return [];
  const r = git(['status', '--porcelain', '-z', '--untracked-files=normal'], gitDir, workspacePath);
  if (r.status !== 0) return [];
  const out: string[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    let p = entry.slice(3);
    // Rename/copy entries are followed by the source path in -z mode.
    if (xy.includes('R') || xy.includes('C')) i += 1;
    if (p) out.push(p);
  }
  return out;
}

// -------------------------------------------------- workspace lookup --

/**
 * The shadow workspace a task's report is computed against. Convention
 * (see maybeShadowCheckpointOnRunStart): a shadow config whose
 * workspaceId IS the task id. Fallback: a config whose workspacePath
 * equals the task's recorded workspace path. Null when neither exists.
 */
function shadowConfigForTask(task: Task): ShadowConfig | null {
  const st = shadowCheckpointStore();
  const byId = st.config(task.id);
  if (byId) return byId;
  if (task.workspace) {
    try {
      const p = resolve(task.workspace);
      const byPath = st.configsForPath(p);
      if (byPath.length > 0) return byPath[0];
    } catch {
      /* workspace string not a resolvable path — no config */
    }
  }
  return null;
}

// ------------------------------------------------------------- report ---

export interface ScopeViolationEntry {
  path: string;
  reason: ScopeDenyReason;
}

export interface TaskScopeReport {
  taskId: string;
  /** The task's recorded scope, or null when no lock is recorded. */
  scope: TaskEditScope | null;
  /** True when the recorded scope actually restricts something. */
  locked: boolean;
  checkedAt: string;
  /** Shadow workspace the detection ran against (null = unconfigured). */
  shadow: { workspaceId: string; workspacePath: string; tip: string | null } | null;
  /** All files attributable to this task (snapshotted + live), deduped. */
  changedFiles: string[];
  /** The subset of changedFiles outside the scope, with reasons. */
  outOfScope: ScopeViolationEntry[];
  /** Honest notes about what this report can and cannot see. */
  notes: string[];
}

const REPORT_NOTE =
  'Post-hoc detection from shadow-checkpoint diffs: shell/exec writes are found here after the fact, ' +
  'not blocked in real time. Files shadow snapshots skip (symlinks, files >5 MiB, skipped dirs) are not visible.';

/**
 * Compute the scope report for one task. Never throws into callers:
 * shadow failures surface as an empty change set + a note.
 */
export function computeTaskScopeReport(ctx: RouteContext, task: Task): TaskScopeReport {
  void ctx;
  const scope = task.scope ?? null;
  const locked = hasScope(scope);
  const notes: string[] = [REPORT_NOTE];
  const cfg = shadowConfigForTask(task);
  if (!cfg) {
    notes.push(
      'No shadow workspace is configured for this task, so no changed-file set could be computed; ' +
        'the out-of-scope list is empty because nothing was measured, not because nothing changed.',
    );
    return {
      taskId: task.id,
      scope,
      locked,
      checkedAt: new Date().toISOString(),
      shadow: null,
      changedFiles: [],
      outOfScope: [],
      notes,
    };
  }
  const changed = new Set<string>();
  let tip: string | null = null;
  try {
    const st = shadowCheckpointStore();
    const range = taskDiffRange(st, cfg.workspaceId, task.id);
    if (range) {
      tip = range.tip;
      const diff = diffShadowCheckpoints(st, cfg.workspaceId, range.base, range.tip);
      for (const f of diff.files) changed.add(f.path);
    }
    for (const p of liveWorktreeChanges(cfg.workspaceId, cfg.workspacePath)) changed.add(p);
  } catch (e) {
    notes.push(
      `Shadow diff failed (${e instanceof ShadowCheckpointError ? e.code : 'error'}): ` +
        'the change set may be incomplete.',
    );
  }
  const changedFiles = [...changed].sort();
  const outOfScope = locked && scope ? detectOutOfScopePaths(scope, changedFiles) : [];
  return {
    taskId: task.id,
    scope,
    locked,
    checkedAt: new Date().toISOString(),
    shadow: { workspaceId: cfg.workspaceId, workspacePath: cfg.workspacePath, tip },
    changedFiles,
    outOfScope,
    notes,
  };
}

// ---------------------------------------------------- audit dedupe ----

/**
 * Which (taskId, tip, path) violations have already been audited, so a
 * run-end check or a report view does not spam the audit log with the
 * same finding on every poll. JSON file under the data dir, atomic
 * write — same pattern as the shadow store. Corrupt file = treated as
 * empty (worst case: one duplicate audit entry) and rebuilt.
 */
class ScopeAuditDedupe {
  private file: { version: 1; audited: Record<string, string[]> } | null = null;
  constructor(private readonly path: string) {}

  private load(): { version: 1; audited: Record<string, string[]> } {
    if (this.file) return this.file;
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as {
          version?: unknown;
          audited?: unknown;
        };
        if (parsed.version === 1 && typeof parsed.audited === 'object' && parsed.audited !== null) {
          this.file = { version: 1, audited: parsed.audited as Record<string, string[]> };
          return this.file;
        }
      } catch {
        /* corrupt → rebuild empty */
      }
    }
    this.file = { version: 1, audited: {} };
    return this.file;
  }

  private save(): void {
    const f = this.load();
    const tmp = `${this.path}.tmp-${process.pid}`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  /** Paths of `violations` not yet audited under this (taskId, tip) key. */
  unseen(taskId: string, tip: string | null, violations: ScopeViolationEntry[]): string[] {
    const key = `${taskId}@${tip ?? 'none'}`;
    const seen = new Set(this.load().audited[key] ?? []);
    return violations.map((v) => v.path).filter((p) => !seen.has(p));
  }

  mark(taskId: string, tip: string | null, paths: string[]): void {
    const f = this.load();
    const key = `${taskId}@${tip ?? 'none'}`;
    const seen = new Set(f.audited[key] ?? []);
    for (const p of paths) seen.add(p);
    f.audited[key] = [...seen];
    // Bound the file: keep at most the 500 most recent task keys.
    const keys = Object.keys(f.audited);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete f.audited[k];
    }
    this.save();
  }
}

let dedupe: ScopeAuditDedupe | null = null;
function scopeAuditDedupe(): ScopeAuditDedupe {
  if (!dedupe) {
    const dataDir = process.env.AI_FACTORY_DATA_DIR ?? './data';
    dedupe = new ScopeAuditDedupe(join(resolve(dataDir), 'scope-audit-dedupe.json'));
  }
  return dedupe;
}

/** Test seam. */
export function setScopeAuditDedupe(d: ScopeAuditDedupe | null): void {
  dedupe = d;
}

/**
 * Audit + notify violations that have not been recorded yet for this
 * report's tip. Returns the count of NEWLY audited violations.
 */
export function auditNewViolations(
  ctx: RouteContext,
  report: TaskScopeReport,
  extra: { runId?: string } = {},
): number {
  if (!report.locked || report.outOfScope.length === 0 || !report.shadow) return 0;
  const d = scopeAuditDedupe();
  const fresh = d.unseen(report.taskId, report.shadow.tip, report.outOfScope);
  if (fresh.length === 0) return 0;
  const freshEntries = report.outOfScope.filter((v) => fresh.includes(v.path));
  ctx.audit.record('system', 'SCOPE_VIOLATION_DETECTED', 'task', report.taskId, {
    count: freshEntries.length,
    files: freshEntries.map((v) => v.path),
    reasons: freshEntries.map((v) => `${v.path}:${v.reason}`),
    workspaceId: report.shadow.workspaceId,
    tip: report.shadow.tip ?? undefined,
    ...(extra.runId ? { runId: extra.runId } : {}),
    note: 'post-hoc shadow-diff detection; writes were NOT rolled back',
  });
  try {
    ctx.notify.emit({
      type: 'SCOPE_VIOLATION_DETECTED',
      actor: 'system',
      entity: { kind: 'task', id: report.taskId, label: report.taskId },
      detail: {
        count: String(freshEntries.length),
        files: freshEntries.map((v) => v.path).slice(0, 10).join(', '),
        taskId: report.taskId,
      },
    });
  } catch {
    /* notification fan-out is best-effort — the audit record stands */
  }
  d.mark(report.taskId, report.shadow.tip, fresh);
  return freshEntries.length;
}

/**
 * Run-completion observer (installed by index.ts via
 * setScopeRunCompleteHook in routes/runtime.ts). Fire-and-forget:
 * recomputes the task's scope report at the run's terminal write and
 * audits newly detected out-of-scope writes. Never throws.
 */
export function scopeRunCompleteCheck(ctx: RouteContext, taskId: string, runId: string): void {
  void (async () => {
    try {
      const task = ctx.tasks.get(taskId);
      if (!hasScope(task.scope)) return;
      const report = computeTaskScopeReport(ctx, task);
      auditNewViolations(ctx, report, { runId });
    } catch {
      /* observer — detection failure must never break run bookkeeping */
    }
  })().catch(() => {
    /* see above */
  });
}

// ------------------------------------------------------------- routes ---

const PREFIX = '/api/tasks';

export async function handleScopeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const m = url.pathname.match(/^\/api\/tasks\/([^/]+)\/scope$/);
  if (!m || method !== 'GET') return false;
  const taskId = decodeURIComponent(m[1]);
  let task: Task;
  try {
    task = ctx.tasks.get(taskId);
  } catch {
    return ctx.json(res, 404, { error: `task not found: ${taskId}`, code: 'TASK_NOT_FOUND' }), true;
  }
  const report = computeTaskScopeReport(ctx, task);
  // Viewing the report is also a detection point: newly seen violations
  // are audited exactly once per tip (dedupe), like the run-end hook.
  const newlyAudited = auditNewViolations(ctx, report);
  return ctx.json(res, 200, { ...report, newlyAudited }), true;
}

export { PREFIX as SCOPE_ROUTES_PREFIX };
