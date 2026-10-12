/**
 * Retention + legal hold — SPEC v2 §47 (Batch 14).
 *
 *   GET  /api/retention/policies            current policies + excluded categories
 *   PUT  /api/retention/policies            set per-category retention days
 *   GET  /api/retention/holds               legal holds (active + released)
 *   POST /api/retention/holds               set a legal hold (GLOBAL or PROJECT)
 *   POST /api/retention/holds/:id/release   release a legal hold
 *   POST /api/retention/evaluate            DRY RUN: what enforcement would
 *                                           delete right now — deletes nothing
 *   POST /api/retention/enforce             actually delete; requires the
 *                                           request body confirm field to be
 *                                           exactly "DELETE_EXPIRED"
 *
 * Safety posture (the whole point of this module):
 *  - Default is KEEP FOREVER. A category with no policy — or a policy
 *    of null/0 days — never loses a row. Nothing is deleted on a timer;
 *    deletion happens only inside POST /api/retention/enforce, only
 *    for the ids a fresh evaluation in the same request selected.
 *  - Legal hold beats retention, always. An active GLOBAL hold exempts
 *    everything; an active PROJECT hold exempts every record that
 *    resolves to that project. A backup is a whole-database snapshot,
 *    so ANY active hold exempts ALL backups (they may contain held
 *    project data), and the backup staged for a pending restore is
 *    exempt unconditionally.
 *  - §47: "未知引用阻止清理" — records whose project cannot be
 *    resolved are never deleted, only counted (unknownRefExempt).
 *    Resolution includes the retention tombstone (Batch 15): when
 *    enforce deletes a run row, the db store first records its
 *    run → project mapping, so the run's leftover intents/checkpoints
 *    keep resolving (and keep honoring that project's holds) instead
 *    of becoming permanent orphans; true orphans stay exempt.
 *  - Live state is never eligible: RUNNING runs and PENDING step
 *    intents (a dead process's unreconciled intents, §28.3) are
 *    excluded by the candidate queries themselves.
 *  - §32: deletions go through a controlled retention event — the
 *    RETENTION_ENFORCED audit record carries per-category deleted
 *    counts and sample ids. Policy changes and hold set/release are
 *    likewise audited (RETENTION_POLICY_UPDATED, LEGAL_HOLD_SET,
 *    LEGAL_HOLD_RELEASED).
 *
 * Excluded categories (reported in every evaluation, never deletable
 * through this module):
 *  - audit_logs: the accountability root — hash-chained (§32); §47
 *    lists Audit among retention categories but nothing in the spec
 *    requires or sanctions deleting the chain, and retention must not
 *    become the tool that rewrites it. Excluded by default, full stop.
 *  - evidence: §39 (SPEC L925) — evidence retention must not be
 *    shorter than task audit/release/incident-investigation needs, and
 *    sealed evidence is the immutable verification record; sweeping it
 *    needs a tombstone design this batch does not pretend to have.
 *  - tasks/projects: removal is the project lifecycle's decision
 *    (§47 archive/delete, Scope/Owner/Retention), not a sweep here.
 *  - notifications: the notification engine is in-memory only
 *    (nothing is persisted), so there is nothing to retain or sweep.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  RETENTION_CATEGORIES,
  type CategoryEvaluation,
  type LegalHold,
  type RetentionCategory,
} from '@ai-factory/db';
import type { RouteContext } from './context';

export const RETENTION_CONFIRM_TEXT = 'DELETE_EXPIRED';
const DAY_MS = 86_400_000;
const SAMPLE_LIMIT = 10;

export const EXCLUDED_CATEGORIES: { category: string; reason: string }[] = [
  {
    category: 'audit_logs',
    reason:
      'accountability root (hash-chained audit, §32): never deletable via retention',
  },
  {
    category: 'evidence',
    reason:
      'evidence retention must not undercut audit/release/incident needs (§39); sealed evidence is immutable',
  },
  {
    category: 'tasks',
    reason:
      'task/project removal belongs to the project lifecycle (§47 archive/delete), not a retention sweep',
  },
  {
    category: 'notifications',
    reason: 'notification engine is in-memory only; nothing is persisted',
  },
];

interface CategoryReport {
  category: RetentionCategory;
  /** Effective policy in days; null = keep forever. */
  retentionDays: number | null;
  candidates: number;
  sampleIds: string[];
  heldExempt: number;
  unknownRefExempt: number;
  note?: string;
}

interface EvaluationReport {
  evaluatedAt: string;
  activeHolds: LegalHold[];
  categories: CategoryReport[];
  excluded: { category: string; reason: string }[];
  /** Candidate ids per DB category — internal, for enforce. */
  _candidateIds: Partial<Record<RetentionCategory, string[]>>;
}

function effectiveDays(days: number | null): number | null {
  return days === null || days === 0 ? null : days;
}

function evaluateAll(ctx: RouteContext, now: Date): EvaluationReport {
  const store = ctx.fdb.retention;
  const policies = new Map(
    store.listPolicies().map((p) => [p.category, p.retentionDays]),
  );
  const holds = store.activeHolds();
  const anyHold = holds.length > 0;
  const nowMs = now.getTime();
  const categories: CategoryReport[] = [];
  const candidateIds: EvaluationReport['_candidateIds'] = {};

  for (const category of RETENTION_CATEGORIES) {
    const days = effectiveDays(policies.get(category) ?? null);
    if (days === null) {
      categories.push({
        category,
        retentionDays: policies.get(category) ?? null,
        candidates: 0,
        sampleIds: [],
        heldExempt: 0,
        unknownRefExempt: 0,
        note: 'keep forever (no retention policy)',
      });
      continue;
    }
    const cutoffMs = nowMs - days * DAY_MS;
    const cutoffIso = new Date(cutoffMs).toISOString();

    if (category === 'backups') {
      const access = ctx.backupAccess;
      if (!access) {
        // No backup service wired in this process: report honestly
        // and delete nothing — retention never deletes blind.
        candidateIds[category] = [];
        categories.push({
          category,
          retentionDays: days,
          candidates: 0,
          sampleIds: [],
          heldExempt: 0,
          unknownRefExempt: 0,
          note: 'backup service not wired in this process; nothing will be deleted',
        });
        continue;
      }
      // Whole-database snapshots: ANY active hold exempts every
      // backup, and the staged-restore snapshot is exempt outright.
      const staged = access.stagedRestoreBackupId();
      let candidates = 0;
      let held = 0;
      const sampleIds: string[] = [];
      const ids: string[] = [];
      for (const m of access.list()) {
        if (m.createdAt >= cutoffIso) continue; // not expired
        if (anyHold || m.backupId === staged) {
          held++;
          continue;
        }
        candidates++;
        ids.push(m.backupId);
        if (sampleIds.length < SAMPLE_LIMIT) sampleIds.push(m.backupId);
      }
      candidateIds[category] = ids;
      categories.push({
        category,
        retentionDays: days,
        candidates,
        sampleIds,
        heldExempt: held,
        unknownRefExempt: 0,
        note: anyHold
          ? 'backups are whole-database snapshots: any active legal hold exempts all of them'
          : undefined,
      });
      continue;
    }

    const ev: CategoryEvaluation = store.evaluateCategory(
      category,
      cutoffIso,
      cutoffMs,
      holds,
    );
    candidateIds[category] = ev.candidates;
    categories.push({
      category,
      retentionDays: days,
      candidates: ev.candidates.length,
      sampleIds: ev.candidates.slice(0, SAMPLE_LIMIT),
      heldExempt: ev.heldExempt,
      unknownRefExempt: ev.unknownRefExempt,
    });
  }

  return {
    evaluatedAt: now.toISOString(),
    activeHolds: holds,
    categories,
    excluded: EXCLUDED_CATEGORIES,
    _candidateIds: candidateIds,
  };
}

function publicReport(r: EvaluationReport) {
  const { _candidateIds: _omit, ...pub } = r;
  return pub;
}

function actorOf(body: Record<string, unknown>): string {
  const a = body['actor'];
  return typeof a === 'string' && a.length > 0 ? a : 'human';
}

const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function handleRetentionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const { json, readBody, audit, fdb } = ctx;
  const method = req.method ?? 'GET';
  const p = url.pathname;
  if (p !== '/api/retention' && !p.startsWith('/api/retention/')) return false;
  const store = fdb.retention;

  // ---------------------------------------------------------- policies --

  if (p === '/api/retention/policies' && method === 'GET') {
    json(res, 200, {
      policies: store.listPolicies(),
      excluded: EXCLUDED_CATEGORIES,
    });
    return true;
  }

  if (p === '/api/retention/policies' && method === 'PUT') {
    const b = await readBody(req);
    const policies = b['policies'];
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) {
      json(res, 400, {
        error: 'body must be { policies: { <category>: <days|null> } }',
      });
      return true;
    }
    const entries = Object.entries(policies as Record<string, unknown>);
    for (const [category, days] of entries) {
      if (EXCLUDED_CATEGORIES.some((e) => e.category === category)) {
        json(res, 400, {
          error: `category '${category}' is excluded from retention and cannot be given a policy`,
        });
        return true;
      }
      if (!(RETENTION_CATEGORIES as readonly string[]).includes(category)) {
        json(res, 400, { error: `unknown retention category: ${category}` });
        return true;
      }
      if (
        days !== null &&
        (typeof days !== 'number' || !Number.isInteger(days) || days < 0)
      ) {
        json(res, 400, {
          error: `retention days for '${category}' must be a non-negative integer or null (keep forever)`,
        });
        return true;
      }
    }
    const actor = actorOf(b);
    const nowIso = new Date().toISOString();
    const updated = entries.map(([category, days]) =>
      store.setPolicy(
        category as RetentionCategory,
        days as number | null,
        actor,
        nowIso,
      ),
    );
    audit.record(actor, 'RETENTION_POLICY_UPDATED', 'retention_policy', 'policies', {
      policies: Object.fromEntries(
        updated.map((u) => [u.category, u.retentionDays]),
      ),
    });
    json(res, 200, { policies: store.listPolicies() });
    return true;
  }

  // -------------------------------------------------------------- holds --

  if (p === '/api/retention/holds' && method === 'GET') {
    const holds = store.listHolds();
    json(res, 200, {
      holds,
      active: holds.filter((h) => h.releasedAt === null),
    });
    return true;
  }

  if (p === '/api/retention/holds' && method === 'POST') {
    const b = await readBody(req);
    const scope = b['scope'];
    if (scope !== 'GLOBAL' && scope !== 'PROJECT') {
      json(res, 400, { error: "scope must be 'GLOBAL' or 'PROJECT'" });
      return true;
    }
    let projectId: string | null = null;
    if (scope === 'PROJECT') {
      if (typeof b['projectId'] !== 'string' || b['projectId'].length === 0) {
        json(res, 400, { error: 'projectId is required for a PROJECT hold' });
        return true;
      }
      projectId = b['projectId'];
      if (!store.projectExists(projectId)) {
        json(res, 404, { error: `unknown project: ${projectId}` });
        return true;
      }
    }
    const existing = store.findActiveHold(scope, projectId);
    if (existing) {
      json(res, 409, {
        error: 'an active hold already covers this scope',
        hold: existing,
      });
      return true;
    }
    const actor = actorOf(b);
    const hold = store.addHold({
      id: randomUUID(),
      scope,
      projectId,
      reason: typeof b['reason'] === 'string' ? b['reason'] : '',
      setBy: actor,
      setAt: new Date().toISOString(),
      releasedAt: null,
      releasedBy: null,
    });
    audit.record(actor, 'LEGAL_HOLD_SET', 'legal_hold', hold.id, {
      scope: hold.scope,
      projectId: hold.projectId,
      reason: hold.reason,
    });
    json(res, 201, { hold });
    return true;
  }

  const releaseMatch = p.match(/^\/api\/retention\/holds\/([^/]+)\/release$/);
  if (releaseMatch && method === 'POST') {
    const id = decodeURIComponent(releaseMatch[1]);
    const existing = store.getHold(id);
    if (!existing) {
      json(res, 404, { error: `unknown legal hold: ${id}` });
      return true;
    }
    if (existing.releasedAt !== null) {
      json(res, 409, { error: 'legal hold is already released', hold: existing });
      return true;
    }
    const b = await readBody(req);
    const actor = actorOf(b);
    const hold = store.releaseHold(id, actor, new Date().toISOString());
    audit.record(actor, 'LEGAL_HOLD_RELEASED', 'legal_hold', id, {
      scope: existing.scope,
      projectId: existing.projectId,
    });
    json(res, 200, { hold });
    return true;
  }

  // -------------------------------------------------- evaluate / enforce --

  if (p === '/api/retention/evaluate' && method === 'POST') {
    const report = evaluateAll(ctx, new Date());
    json(res, 200, publicReport(report));
    return true;
  }

  if (p === '/api/retention/enforce' && method === 'POST') {
    const b = await readBody(req);
    if (b['confirm'] !== RETENTION_CONFIRM_TEXT) {
      json(res, 400, {
        error:
          `refusing to delete anything: body.confirm must be exactly "${RETENTION_CONFIRM_TEXT}" ` +
          '(run POST /api/retention/evaluate first to see what would be deleted)',
      });
      return true;
    }
    const actor = actorOf(b);
    // Fresh evaluation inside this request — a stale dry-run report is
    // never an authorization to delete a specific set of rows.
    const report = evaluateAll(ctx, new Date());
    const ids = report._candidateIds;
    const deleted: Record<string, number> = {};
    // Children first: checkpoints/intents resolve their project through
    // the run record, so runs are deleted last within this request
    // (the candidate sets were already fixed by the evaluation above).
    deleted['checkpoints'] = store.deleteCheckpoints(ids['checkpoints'] ?? []);
    deleted['step_intents'] = store.deleteStepIntents(ids['step_intents'] ?? []);
    deleted['runtime_runs'] = store.deleteRuntimeRuns(ids['runtime_runs'] ?? []);
    // Backups: whole directories under the backup dir (id validated
    // against the same shape the backup module writes). The dir is
    // resolved only when this request's evaluation produced backup
    // candidates — which already implies the accessors worked above.
    let backupsDeleted = 0;
    const backupIds = ids['backups'] ?? [];
    if (backupIds.length > 0 && ctx.backupAccess) {
      const dir = ctx.backupAccess.dir();
      for (const backupId of backupIds) {
        if (!BACKUP_ID_RE.test(backupId) || backupId.includes('..')) continue;
        const target = path.join(dir, backupId);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          backupsDeleted++;
        }
      }
    }
    deleted['backups'] = backupsDeleted;
    audit.record(actor, 'RETENTION_ENFORCED', 'retention', 'enforce', {
      evaluatedAt: report.evaluatedAt,
      deleted,
      candidates: Object.fromEntries(
        report.categories.map((c) => [c.category, c.candidates]),
      ),
      sampleDeletedIds: Object.fromEntries(
        report.categories.map((c) => [c.category, c.sampleIds]),
      ),
      activeHolds: report.activeHolds.map((h) => h.id),
    });
    json(res, 200, {
      ok: true,
      evaluatedAt: report.evaluatedAt,
      deleted,
      report: publicReport(report),
    });
    return true;
  }

  return false;
}
