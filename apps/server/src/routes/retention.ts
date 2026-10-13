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
 *    For SBOMs (Batch 26) the association is verified first too: a
 *    file is deleted only when a builds record's sbomRef points at
 *    it and that record is expired, or when it is an orphan AND the
 *    policy explicitly opts into orphan sweeping (deleteOrphans) —
 *    an unassociated file might belong to an in-flight build, so it
 *    is kept by default. Deleting an SBOM file leaves the builds
 *    record's sbomRef dangling BY DESIGN: builds rows are
 *    insert-only history and are never rewritten.
 *  - Live state is never eligible: RUNNING runs and PENDING step
 *    intents (a dead process's unreconciled intents, §28.3) are
 *    excluded by the candidate queries themselves.
 *  - §32: deletions go through a controlled retention event — the
 *    RETENTION_ENFORCED audit record carries per-category deleted
 *    counts and sample ids. Policy changes and hold set/release are
 *    likewise audited (RETENTION_POLICY_UPDATED, LEGAL_HOLD_SET,
 *    LEGAL_HOLD_RELEASED).
 *  - SBOMs (Batch 26): like backups, ANY active legal hold exempts
 *    every SBOM deletion (they may describe held project data);
 *    keepCount keeps the newest N by record age regardless of the
 *    days axis.
 *  - Attestations (Batch 39): attestation-<buildId>.json files live
 *    in the same directory as the SBOMs and are evaluated as their
 *    own category ('attestations'), mirroring the sboms semantics
 *    exactly — referenced-by-attestationRef association verified
 *    first, days OR keepCount axes, orphan sweep opt-in, hold
 *    exemption absolute, builds rows never rewritten (attestationRef
 *    dangles by design; the builds read surface reports the file
 *    status honestly instead of fabricating presence).
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
import { SBOM_FILE_RE, ATTESTATION_FILE_RE } from '@ai-factory/cicd';
import {
  RETENTION_CATEGORIES,
  type StoredBuildRecord,
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
  /**
   * Batch 20 — backups, sboms, and attestations: keep newest N
   * regardless of age; null = no count limit.
   */
  keepCount: number | null;
  /**
   * Batch 26 — sboms only (Batch 39: sboms and attestations):
   * whether the policy opts into deleting orphan sbom-*.json /
   * attestation-*.json files (no builds record references them).
   */
  deleteOrphans: boolean;
  candidates: number;
  sampleIds: string[];
  heldExempt: number;
  unknownRefExempt: number;
  /**
   * Batch 26 — sboms only (Batch 39: sboms and attestations):
   * sbom-*.json / attestation-*.json files present in the directory
   * that no builds record references AND that were not deleted
   * (deleteOrphans off, or a hold is active). The operator sees the
   * accumulation instead of it happening silently.
   */
  orphanFiles?: number;
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

interface FileCategoryArgs {
  /** 'sboms' | 'attestations' — which builds-table ref field to follow. */
  isSbom: boolean;
  dir: string;
  /** Basenames present in dir; the fileRe guard below does the protecting. */
  listFiles: () => string[];
  fileRe: RegExp;
  refOf: (rec: StoredBuildRecord) => string | null;
  /** 'sbom' | 'attestation' — used in human-facing notes. */
  noun: string;
  days: number | null;
  cutoffIso: string;
  keepCount: number | null;
  deleteOrphans: boolean;
  anyHold: boolean;
  builds: StoredBuildRecord[];
}

interface FileCategoryResult {
  ids: string[];
  candidates: number;
  sampleIds: string[];
  heldExempt: number;
  unknownRefExempt: number;
  orphanFiles?: number;
  note?: string;
}

/**
 * Batch 26/39 — shared evaluator for the file-based retention
 * categories ('sboms', 'attestations'). Both live in the sbom
 * directory; files on disk are associated to builds records via the
 * record's ref (absolute path). The association is verified BEFORE
 * anything is a candidate: the referenced set is built from the live
 * builds table, and a file is only ever deleted when it is (a)
 * referenced by an expired record, or (b) an orphan AND the policy
 * opted into orphan sweeping. Deletion axes mirror backups: a
 * referenced file is a candidate when it is BOTH (a) older than the
 * days policy (if set) and (b) beyond the newest keepCount (if
 * set) — OR semantics across the two axes, hold exemption applied
 * last and absolutely. ANY active legal hold exempts every deletion
 * (the files may describe held project data — same posture as
 * whole-database backup snapshots).
 *
 * Age of a file = its builds record's completedAt (falling back to
 * builtAt for records that never ran a build — those have the ref
 * null anyway, so this is defensive).
 *
 * NOTE: deleting a file leaves the builds record's ref dangling by
 * design — builds rows are insert-only history and are never
 * rewritten. Readers must treat a missing file as "retained away",
 * not as corruption.
 */
function evaluateFileCategory(args: FileCategoryArgs): FileCategoryResult {
  const {
    dir,
    listFiles,
    fileRe,
    refOf,
    noun,
    days,
    cutoffIso,
    keepCount,
    deleteOrphans,
    anyHold,
    builds,
  } = args;
  const referenced = new Map<string, { recordId: string; ageIso: string }>();
  for (const rec of builds) {
    const ref = refOf(rec);
    if (!ref) continue;
    const abs = path.resolve(ref);
    if (referenced.has(abs)) continue; // first record wins; refs are unique per build anyway
    referenced.set(abs, {
      recordId: rec.id,
      ageIso: rec.completedAt ?? rec.builtAt,
    });
  }
  const orphanNames: string[] = [];
  const items: { name: string; abs: string; ageIso: string }[] = [];
  for (const name of listFiles()) {
    if (!fileRe.test(name) || name.includes('..')) continue; // never deletes blind
    const abs = path.resolve(dir, name);
    const ref = referenced.get(abs);
    if (!ref) {
      orphanNames.push(name);
      continue;
    }
    items.push({ name, abs, ageIso: ref.ageIso });
  }
  // Newest first — keepCount protects the newest N regardless of age.
  items.sort((a, b) => b.ageIso.localeCompare(a.ageIso));
  const overCount = new Set<string>();
  if (keepCount !== null) {
    for (const it of items.slice(keepCount)) overCount.add(it.name);
  }
  const ids: string[] = [];
  const sampleIds: string[] = [];
  let held = 0;
  let orphansKept = 0;
  for (const it of items) {
    const expiredByDays = days !== null && it.ageIso < cutoffIso;
    if (!expiredByDays && !overCount.has(it.name)) continue;
    if (anyHold) {
      held++;
      continue;
    }
    ids.push(it.name);
    if (sampleIds.length < SAMPLE_LIMIT) sampleIds.push(it.name);
  }
  // Orphans: only swept when the policy explicitly opts in, and
  // never under a hold. Their builds record is gone (or never
  // existed — e.g. the process died between writing the file and
  // markSucceeded), so no age axis applies.
  if (deleteOrphans && !anyHold) {
    for (const name of orphanNames) {
      ids.push(name);
      if (sampleIds.length < SAMPLE_LIMIT) sampleIds.push(name);
    }
  } else {
    orphansKept = orphanNames.length;
  }
  const notes: string[] = [];
  if (anyHold) {
    notes.push(
      `any active legal hold exempts all ${noun} deletions (they may describe held project data)`,
    );
  }
  if (keepCount !== null) {
    notes.push(`keeping newest ${keepCount} ${noun}(s) regardless of age`);
  }
  if (deleteOrphans) {
    notes.push(`orphan ${noun} files (no builds record references them) are swept`);
  } else if (orphanNames.length > 0) {
    notes.push(
      `${orphanNames.length} orphan ${noun} file(s) kept: deleteOrphans is off (unknown references block cleanup, §47)`,
    );
  }
  return {
    ids,
    candidates: ids.length,
    sampleIds,
    heldExempt: held,
    unknownRefExempt: 0,
    orphanFiles: orphansKept > 0 ? orphansKept : undefined,
    note: notes.length > 0 ? notes.join('; ') : undefined,
  };
}

function evaluateAll(ctx: RouteContext, now: Date): EvaluationReport {
  const store = ctx.fdb.retention;
  const policies = new Map(store.listPolicies().map((p) => [p.category, p]));
  const holds = store.activeHolds();
  const anyHold = holds.length > 0;
  const nowMs = now.getTime();
  const categories: CategoryReport[] = [];
  const candidateIds: EvaluationReport['_candidateIds'] = {};

  for (const category of RETENTION_CATEGORIES) {
    const policy = policies.get(category);
    const days = effectiveDays(policy?.retentionDays ?? null);
    // Batch 20/26/39 — the count axis exists for the filesystem
    // categories ('backups', 'sboms', 'attestations'); the PUT route
    // rejects it for the DB categories, so a non-null value here
    // always belongs to one of those three.
    const keepCount =
      (category === 'backups' ||
        category === 'sboms' ||
        category === 'attestations') &&
      policy?.keepCount !== null &&
      policy?.keepCount !== undefined &&
      policy.keepCount > 0
        ? policy.keepCount
        : null;
    // Batch 26/39 — sboms and attestations orphan sweep opt-in, read
    // straight from the policy (default false: never sweep
    // unassociated files unless the operator says so).
    const deleteOrphans =
      (category === 'sboms' || category === 'attestations') &&
      policy?.deleteOrphans === true;
    if (days === null && keepCount === null && !deleteOrphans) {
      categories.push({
        category,
        retentionDays: policy?.retentionDays ?? null,
        keepCount: null,
        deleteOrphans: false,
        candidates: 0,
        sampleIds: [],
        heldExempt: 0,
        unknownRefExempt: 0,
        note: 'keep forever (no retention policy)',
      });
      continue;
    }
    const cutoffMs = days === null ? 0 : nowMs - days * DAY_MS;
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
          keepCount,
          deleteOrphans: false,
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
      // Deletion axes (Batch 20): a backup is a candidate when it is
      // BOTH (a) older than the days policy (if set) and (b) beyond
      // the newest keepCount (if set) — OR semantics across the two
      // axes, hold exemption applied last and absolutely.
      const staged = access.stagedRestoreBackupId();
      const manifests = [...access.list()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      const overCount = new Set<string>();
      if (keepCount !== null) {
        for (const m of manifests.slice(keepCount)) overCount.add(m.backupId);
      }
      let candidates = 0;
      let held = 0;
      const sampleIds: string[] = [];
      const ids: string[] = [];
      for (const m of manifests) {
        const expiredByDays = days !== null && m.createdAt < cutoffIso;
        if (!expiredByDays && !overCount.has(m.backupId)) continue;
        if (anyHold || m.backupId === staged) {
          held++;
          continue;
        }
        candidates++;
        ids.push(m.backupId);
        if (sampleIds.length < SAMPLE_LIMIT) sampleIds.push(m.backupId);
      }
      candidateIds[category] = ids;
      const notes: string[] = [];
      if (anyHold) {
        notes.push(
          'backups are whole-database snapshots: any active legal hold exempts all of them',
        );
      }
      if (keepCount !== null) {
        notes.push(`keeping newest ${keepCount} backup(s) regardless of age`);
      }
      categories.push({
        category,
        retentionDays: days,
        keepCount,
        deleteOrphans: false,
        candidates,
        sampleIds,
        heldExempt: held,
        unknownRefExempt: 0,
        note: notes.length > 0 ? notes.join('; ') : undefined,
      });
      continue;
    }

    // Batch 26/39 — the file-based categories share one evaluator.
    // 'sboms' follows sbomRef; 'attestations' follows attestationRef.
    // Both live in the sbom directory the build runner writes to.
    if (category === 'sboms' || category === 'attestations') {
      const access = ctx.sbomAccess;
      if (!access) {
        // No SBOM directory wired in this process: report honestly
        // and delete nothing — retention never deletes blind.
        candidateIds[category] = [];
        categories.push({
          category,
          retentionDays: days,
          keepCount,
          deleteOrphans,
          candidates: 0,
          sampleIds: [],
          heldExempt: 0,
          unknownRefExempt: 0,
          note: 'sbom directory not wired in this process; nothing will be deleted',
        });
        continue;
      }
      const dir = access.dir();
      const isSbom = category === 'sboms';
      const result = evaluateFileCategory({
        isSbom,
        dir,
        listFiles: isSbom
          ? () => access.list() // basenames, sbom-*.json regular files only
          : () => {
              // Attestations share the directory; filter for the
              // attestation shape here (the helper's fileRe guard
              // double-checks — retention never deletes blind).
              let entries: string[];
              try {
                entries = fs.readdirSync(dir);
              } catch {
                return [];
              }
              return entries.filter((name) => {
                if (!ATTESTATION_FILE_RE.test(name)) return false;
                try {
                  return fs.statSync(path.join(dir, name)).isFile();
                } catch {
                  return false;
                }
              });
            },
        fileRe: isSbom ? SBOM_FILE_RE : ATTESTATION_FILE_RE,
        refOf: (rec) => (isSbom ? rec.sbomRef : rec.attestationRef),
        noun: isSbom ? 'sbom' : 'attestation',
        days,
        cutoffIso,
        keepCount,
        deleteOrphans,
        anyHold,
        builds: ctx.fdb.builds.list(),
      });
      candidateIds[category] = result.ids;
      categories.push({
        category,
        retentionDays: days,
        keepCount,
        deleteOrphans,
        candidates: result.candidates,
        sampleIds: result.sampleIds,
        heldExempt: result.heldExempt,
        unknownRefExempt: result.unknownRefExempt,
        orphanFiles: result.orphanFiles,
        note: result.note,
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
      keepCount: null,
      deleteOrphans: false,
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
        error:
          'body must be { policies: { <category>: <days|null> | { days, keepCount, deleteOrphans } } }',
      });
      return true;
    }
    const entries = Object.entries(policies as Record<string, unknown>);
    // Batch 20/26/39 — per-category values accept the legacy
    // <days|null> shape or { days, keepCount, deleteOrphans };
    // keepCount (keep newest N regardless of age) is only meaningful
    // for the filesystem categories 'backups', 'sboms', and
    // 'attestations'; deleteOrphans (sweep unreferenced files) is
    // sboms/attestations-only.
    const parsed: {
      category: RetentionCategory;
      days: number | null;
      keepCount: number | null;
      deleteOrphans: boolean;
    }[] = [];
    for (const [category, value] of entries) {
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
      let days: unknown = value;
      let keepCount: unknown = null;
      let deleteOrphans: unknown = false;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        days = (value as Record<string, unknown>)['days'] ?? null;
        keepCount = (value as Record<string, unknown>)['keepCount'] ?? null;
        deleteOrphans = (value as Record<string, unknown>)['deleteOrphans'] ?? false;
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
      if (
        keepCount !== null &&
        (typeof keepCount !== 'number' ||
          !Number.isInteger(keepCount) ||
          keepCount < 1)
      ) {
        json(res, 400, {
          error: `keepCount for '${category}' must be a positive integer or null`,
        });
        return true;
      }
      if (
        keepCount !== null &&
        category !== 'backups' &&
        category !== 'sboms' &&
        category !== 'attestations'
      ) {
        json(res, 400, {
          error: `keepCount is only supported for the 'backups', 'sboms', and 'attestations' categories`,
        });
        return true;
      }
      if (typeof deleteOrphans !== 'boolean') {
        json(res, 400, {
          error: `deleteOrphans for '${category}' must be a boolean`,
        });
        return true;
      }
      if (deleteOrphans && category !== 'sboms' && category !== 'attestations') {
        json(res, 400, {
          error: `deleteOrphans is only supported for the 'sboms' and 'attestations' categories`,
        });
        return true;
      }
      parsed.push({
        category: category as RetentionCategory,
        days: days as number | null,
        keepCount: keepCount as number | null,
        deleteOrphans: deleteOrphans as boolean,
      });
    }
    const actor = actorOf(b);
    const nowIso = new Date().toISOString();
    const updated = parsed.map((p) =>
      store.setPolicy(p.category, p.days, actor, nowIso, p.keepCount, p.deleteOrphans),
    );
    audit.record(actor, 'RETENTION_POLICY_UPDATED', 'retention_policy', 'policies', {
      policies: Object.fromEntries(
        updated.map((u) => [
          u.category,
          {
            retentionDays: u.retentionDays,
            keepCount: u.keepCount,
            deleteOrphans: u.deleteOrphans,
          },
        ]),
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
    // Batch 26 — SBOMs: single files under the sbom dir (id validated
    // against the same shape the build runner writes). The dir is
    // resolved only when this request's evaluation produced sbom
    // candidates — which already implies the accessors worked above.
    // The builds records themselves are insert-only history and are
    // NOT touched: their sbomRef may dangle afterwards, which
    // readers must treat as "retained away", not corruption.
    let sbomsDeleted = 0;
    const sbomIds = ids['sboms'] ?? [];
    if (sbomIds.length > 0 && ctx.sbomAccess) {
      const dir = ctx.sbomAccess.dir();
      for (const name of sbomIds) {
        if (!SBOM_FILE_RE.test(name) || name.includes('..')) continue;
        const target = path.join(dir, name);
        try {
          if (fs.statSync(target).isFile()) {
            fs.rmSync(target, { force: true });
            sbomsDeleted++;
          }
        } catch {
          // Already gone (or unreadable): not a failure of the sweep.
        }
      }
    }
    deleted['sboms'] = sbomsDeleted;
    // Batch 39 — attestations: single files under the sbom dir (id
    // validated against the same shape the build runner writes).
    // The builds records themselves are insert-only history and are
    // NOT touched: their attestationRef may dangle afterwards, which
    // the builds read surface reports honestly (attestationFile:
    // 'missing') instead of fabricating presence.
    let attestationsDeleted = 0;
    const attestationIds = ids['attestations'] ?? [];
    if (attestationIds.length > 0 && ctx.sbomAccess) {
      const dir = ctx.sbomAccess.dir();
      for (const name of attestationIds) {
        if (!ATTESTATION_FILE_RE.test(name) || name.includes('..')) continue;
        const target = path.join(dir, name);
        try {
          if (fs.statSync(target).isFile()) {
            fs.rmSync(target, { force: true });
            attestationsDeleted++;
          }
        } catch {
          // Already gone (or unreadable): not a failure of the sweep.
        }
      }
    }
    deleted['attestations'] = attestationsDeleted;
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
