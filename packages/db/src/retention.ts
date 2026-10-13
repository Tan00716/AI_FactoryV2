/**
 * Retention policies + legal holds — SPEC v2 §47 (Batch 14).
 *
 * §47: "Retention 分类任务、Audit、Trace、Evidence、Artifact、Memory、
 * Temporary Workspace；可配置期限和 Legal Hold" and the §48 platform
 * table list names `retention_policies`. This store is the durable
 * home of the policies and holds; the server routes in
 * apps/server/src/routes/retention.ts own evaluation/enforcement and
 * the audit writes (the §32 rule: deletions happen through controlled
 * Retention events — the RETENTION_ENFORCED audit record — never by
 * silently rewriting history).
 *
 * Safety posture, in order of precedence:
 *   1. No policy (or retention_days NULL/0) = keep forever. Retention
 *      deletes NOTHING unless a policy says otherwise AND the enforce
 *      endpoint is explicitly invoked (dry-run is a separate call).
 *   2. An active legal hold exempts its scope absolutely: GLOBAL
 *      covers every record; PROJECT covers records resolvable to that
 *      project. Backups are whole-database snapshots — the server
 *      exempts them while ANY hold is active (they may contain held
 *      project data).
 *   3. §47: "未知引用阻止清理" — a record whose project cannot be
 *      resolved (run/task row gone) is NEVER deleted; it is counted
 *      as unknown-ref-exempt so the operator sees it. Resolution has
 *      two paths (Batch 15): the live chain run → task → project, and
 *      the retention tombstone — when enforcement deletes a run row,
 *      deleteRuntimeRuns first records run_id → project_id in
 *      retention_tombstones, so the run's leftover intents/checkpoints
 *      keep resolving to that project (and keep honoring its holds
 *      and policies) instead of becoming permanent orphans. A record
 *      with NEITHER path — a true orphan — stays exempt forever.
 *      Tombstones hold only the id pair and the deletion time (no
 *      record content) and never expire on their own: expiring one
 *      would recreate the orphan problem it exists to solve.
 *   4. Live state is never a candidate: RUNNING runs and PENDING step
 *      intents (a dead process's unreconciled intents are the startup
 *      scan's input, §28.3) are structurally excluded by the queries.
 *   5. The audit log is NOT a category here at all: it is the
 *      accountability root (hash-chained, §32), and this store offers
 *      no way to select or delete its rows.
 *
 * Categories managed in the database (filesystem backups are handled
 * by the server module against the same policies/holds):
 *   runtime_runs — terminal runs by finished_at (ISO text)
 *   step_intents — terminal intents by persisted_at (epoch ms)
 *   checkpoints  — captures by captured_at (epoch ms)
 *   backups      — policy only; rows live on disk, not in this store
 *   sboms        — policy only; SBOM files live on disk (FACTORY_SBOM_DIR),
 *                  associated to builds records via the record's sbomRef.
 *                  Batch 26: keepCount applies (keep newest N by
 *                  completedAt/builtAt); deleteOrphans (opt-in, default
 *                  off) additionally sweeps sbom-*.json files no builds
 *                  record references. Orphans are NEVER swept by default:
 *                  §47's "unknown references block cleanup" caution —
 *                  a file we cannot associate might belong to an
 *                  in-flight build whose markSucceeded has not landed.
 */

import { DatabaseSync } from 'node:sqlite';

export const RETENTION_CATEGORIES = [
  'runtime_runs',
  'step_intents',
  'checkpoints',
  'backups',
  'sboms',
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

/** The DB-backed subset (everything except filesystem backups). */
export const DB_RETENTION_CATEGORIES = [
  'runtime_runs',
  'step_intents',
  'checkpoints',
] as const;
export type DbRetentionCategory = (typeof DB_RETENTION_CATEGORIES)[number];

export interface RetentionPolicy {
  category: RetentionCategory;
  /** Days to keep; null = keep forever (unset or explicitly cleared). */
  retentionDays: number | null;
  /**
   * Batch 20 — keep newest N regardless of age; null = no count
   * limit. Only the 'backups' and 'sboms' categories evaluate this
   * column (the server route rejects it for the DB categories).
   */
  keepCount: number | null;
  /**
   * Batch 26 — sboms only: when true, enforcement also deletes
   * sbom-*.json files that no builds record references (orphans).
   * Default false: an unassociated file might belong to an in-flight
   * build, so retention never sweeps it unless the operator opts in.
   */
  deleteOrphans: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface LegalHold {
  id: string;
  scope: 'GLOBAL' | 'PROJECT';
  projectId: string | null;
  reason: string;
  setBy: string;
  setAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

/**
 * Deletion-time memory of a run's project (Batch 15). Written only
 * when retention enforcement actually deletes a runtime_runs row;
 * consulted by evaluation when the live run → task chain is gone.
 */
export interface RetentionTombstone {
  runId: string;
  projectId: string;
  /** ISO timestamp of the deletion that created this tombstone. */
  deletedAt: string;
  /** Why the row was deleted; currently always 'retention'. */
  reason: string;
}

export interface CategoryEvaluation {
  /** Ids that enforcement would delete right now. */
  candidates: string[];
  /** Expired but exempt because an active hold covers them. */
  heldExempt: number;
  /** Expired but exempt because their project cannot be resolved (§47). */
  unknownRefExempt: number;
}

function rowToHold(r: Record<string, unknown>): LegalHold {
  return {
    id: r['id'] as string,
    scope: r['scope'] as LegalHold['scope'],
    projectId: (r['project_id'] as string) ?? null,
    reason: r['reason'] as string,
    setBy: r['set_by'] as string,
    setAt: r['set_at'] as string,
    releasedAt: (r['released_at'] as string) ?? null,
    releasedBy: (r['released_by'] as string) ?? null,
  };
}

export class SqliteRetentionStore {
  constructor(private db: DatabaseSync) {}

  // ------------------------------------------------------------ policies --

  getPolicy(category: RetentionCategory): RetentionPolicy {
    const r = this.db
      .prepare('SELECT * FROM retention_policies WHERE category = ?')
      .get(category) as Record<string, unknown> | undefined;
    if (!r) {
      return {
        category,
        retentionDays: null,
        keepCount: null,
        deleteOrphans: false,
        updatedAt: null,
        updatedBy: null,
      };
    }
    return {
      category,
      retentionDays:
        r['retention_days'] === null ? null : Number(r['retention_days']),
      // Rows from a not-yet-migrated DB have no keep_count column —
      // the SELECT would throw, so migrateRetentionTable runs at
      // open; this branch only guards a NULL value, never a missing
      // column. Same for delete_orphans (Batch 26).
      keepCount:
        r['keep_count'] === null || r['keep_count'] === undefined
          ? null
          : Number(r['keep_count']),
      deleteOrphans:
        r['delete_orphans'] === null || r['delete_orphans'] === undefined
          ? false
          : Number(r['delete_orphans']) !== 0,
      updatedAt: r['updated_at'] as string,
      updatedBy: r['updated_by'] as string,
    };
  }

  listPolicies(): RetentionPolicy[] {
    return RETENTION_CATEGORIES.map((c) => this.getPolicy(c));
  }

  /**
   * retentionDays null or 0 both mean keep-forever; stored verbatim.
   * keepCount (Batch 20) is the "keep newest N" axis for the
   * filesystem categories ('backups', 'sboms'); the server route
   * rejects it for the DB categories, so this store simply persists
   * it. deleteOrphans (Batch 26) is the sboms-only orphan sweep
   * opt-in; persisted verbatim for every category but only the
   * sboms evaluation reads it.
   */
  setPolicy(
    category: RetentionCategory,
    retentionDays: number | null,
    actor: string,
    nowIso: string,
    keepCount: number | null = null,
    deleteOrphans: boolean = false,
  ): RetentionPolicy {
    this.db
      .prepare(
        `INSERT INTO retention_policies (category, retention_days, keep_count, delete_orphans, updated_at, updated_by)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(category) DO UPDATE SET
           retention_days = excluded.retention_days,
           keep_count = excluded.keep_count,
           delete_orphans = excluded.delete_orphans,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(category, retentionDays, keepCount, deleteOrphans ? 1 : 0, nowIso, actor);
    return this.getPolicy(category);
  }

  // --------------------------------------------------------------- holds --

  addHold(h: LegalHold): LegalHold {
    this.db
      .prepare(
        `INSERT INTO legal_holds
           (id, scope, project_id, reason, set_by, set_at, released_at, released_by)
         VALUES (?,?,?,?,?,?,NULL,NULL)`,
      )
      .run(h.id, h.scope, h.projectId, h.reason, h.setBy, h.setAt);
    return this.getHold(h.id)!;
  }

  getHold(id: string): LegalHold | undefined {
    const r = this.db
      .prepare('SELECT * FROM legal_holds WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? rowToHold(r) : undefined;
  }

  listHolds(): LegalHold[] {
    return (
      this.db
        .prepare('SELECT * FROM legal_holds ORDER BY set_at DESC, rowid DESC')
        .all() as Record<string, unknown>[]
    ).map(rowToHold);
  }

  activeHolds(): LegalHold[] {
    return this.listHolds().filter((h) => h.releasedAt === null);
  }

  /** The active hold already covering this exact scope, if any. */
  findActiveHold(
    scope: LegalHold['scope'],
    projectId: string | null,
  ): LegalHold | undefined {
    return this.activeHolds().find(
      (h) => h.scope === scope && h.projectId === projectId,
    );
  }

  releaseHold(id: string, actor: string, nowIso: string): LegalHold | undefined {
    const res = this.db
      .prepare(
        `UPDATE legal_holds SET released_at = ?, released_by = ?
         WHERE id = ? AND released_at IS NULL`,
      )
      .run(nowIso, actor, id);
    if (Number(res.changes) === 0) return undefined;
    return this.getHold(id);
  }

  projectExists(projectId: string): boolean {
    const r = this.db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId);
    return r !== undefined;
  }

  // ----------------------------------------------------------- tombstones --

  getRunTombstone(runId: string): RetentionTombstone | undefined {
    const r = this.db
      .prepare('SELECT * FROM retention_tombstones WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      runId: r['run_id'] as string,
      projectId: r['project_id'] as string,
      deletedAt: r['deleted_at'] as string,
      reason: r['reason'] as string,
    };
  }

  listRunTombstones(): RetentionTombstone[] {
    return (
      this.db
        .prepare('SELECT * FROM retention_tombstones ORDER BY deleted_at, run_id')
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      runId: r['run_id'] as string,
      projectId: r['project_id'] as string,
      deletedAt: r['deleted_at'] as string,
      reason: r['reason'] as string,
    }));
  }

  /**
   * Record (first writer wins) that `runId` belonged to `projectId`
   * at deletion time. Called by deleteRuntimeRuns only, and only for
   * rows that actually disappeared with a resolvable project.
   */
  recordRunTombstone(
    runId: string,
    projectId: string,
    deletedAtIso: string,
    reason = 'retention',
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO retention_tombstones
           (run_id, project_id, deleted_at, reason)
         VALUES (?,?,?,?)`,
      )
      .run(runId, projectId, deletedAtIso, reason);
  }

  // ---------------------------------------------------------- evaluation --

  /**
   * Expired rows of one DB category, split into deletable candidates
   * vs hold/unknown-ref exemptions. `holds` is the caller's snapshot
   * of active holds (one evaluation = one consistent hold view).
   */
  evaluateCategory(
    category: DbRetentionCategory,
    cutoffIso: string,
    cutoffMs: number,
    holds: LegalHold[],
  ): CategoryEvaluation {
    const rows = this.expiredRows(category, cutoffIso, cutoffMs);
    const globalHold = holds.some((h) => h.scope === 'GLOBAL');
    const heldProjects = new Set(
      holds
        .filter((h) => h.scope === 'PROJECT' && h.projectId !== null)
        .map((h) => h.projectId as string),
    );
    const out: CategoryEvaluation = {
      candidates: [],
      heldExempt: 0,
      unknownRefExempt: 0,
    };
    for (const row of rows) {
      if (globalHold) {
        out.heldExempt++;
      } else if (row.projectId !== null && heldProjects.has(row.projectId)) {
        out.heldExempt++;
      } else if (row.projectId === null) {
        // §47: unknown references block cleanup — never deleted.
        out.unknownRefExempt++;
      } else {
        out.candidates.push(row.id);
      }
    }
    return out;
  }

  private expiredRows(
    category: DbRetentionCategory,
    cutoffIso: string,
    cutoffMs: number,
  ): { id: string; projectId: string | null }[] {
    type Row = { id: string; project_id: string | null };
    let rows: Row[];
    switch (category) {
      case 'runtime_runs':
        // Terminal runs only: a RUNNING row is live state (possibly a
        // dead process's honest record), never a retention candidate.
        rows = this.db
          .prepare(
            `SELECT rr.id AS id, t.project_id AS project_id
             FROM runtime_runs rr
             LEFT JOIN tasks t ON t.id = rr.task_id
             WHERE rr.status != 'RUNNING'
               AND rr.finished_at IS NOT NULL
               AND rr.finished_at < ?`,
          )
          .all(cutoffIso) as Row[];
        break;
      case 'step_intents':
        // Terminal intents only: PENDING rows are a dead process's
        // unreconciled intents — the startup scan's input (§28.3) —
        // never swept away by retention.
        // Project resolution: live chain run → task first; when the
        // run row is gone, the retention tombstone (Batch 15) still
        // maps the run to its project. Neither → project_id NULL →
        // unknown-ref-exempt in evaluateCategory.
        rows = this.db
          .prepare(
            `SELECT si.id AS id,
                    COALESCE(t.project_id, tb.project_id) AS project_id
             FROM step_intents si
             LEFT JOIN runtime_runs rr ON rr.id = si.run_id
             LEFT JOIN tasks t ON t.id = rr.task_id
             LEFT JOIN retention_tombstones tb ON tb.run_id = si.run_id
             WHERE si.status != 'PENDING'
               AND si.persisted_at < ?`,
          )
          .all(cutoffMs) as Row[];
        break;
      case 'checkpoints':
        // Identity is (run_id, step_position); encode as 'runId#pos'.
        rows = (
          this.db
            .prepare(
              `SELECT c.run_id AS run_id, c.step_position AS pos,
                      COALESCE(t.project_id, tb.project_id) AS project_id
               FROM checkpoints c
               LEFT JOIN runtime_runs rr ON rr.id = c.run_id
               LEFT JOIN tasks t ON t.id = rr.task_id
               LEFT JOIN retention_tombstones tb ON tb.run_id = c.run_id
               WHERE c.captured_at < ?`,
            )
            .all(cutoffMs) as {
            run_id: string;
            pos: number;
            project_id: string | null;
          }[]
        ).map((r) => ({
          id: `${r.run_id}#${r.pos}`,
          project_id: r.project_id,
        }));
        break;
    }
    return rows.map((r) => ({ id: r.id, projectId: r.project_id }));
  }

  // ------------------------------------------------------------ deletion --

  /**
   * Delete run rows (retention enforcement only — the server's
   * enforce route is the sole caller). Before the rows disappear,
   * each one's project is resolved through its task and remembered
   * as a tombstone, so the run's leftover intents/checkpoints keep a
   * project resolution path in later evaluations (Batch 15). A row
   * whose project cannot be resolved even now gets NO tombstone —
   * there is no mapping to remember — and its leftovers stay
   * unknown-ref-exempt, exactly as §47 demands.
   */
  deleteRuntimeRuns(ids: string[]): number {
    if (ids.length === 0) return 0;
    const resolved = new Map<string, string>();
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const placeholders = part.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT rr.id AS id, t.project_id AS project_id
           FROM runtime_runs rr
           LEFT JOIN tasks t ON t.id = rr.task_id
           WHERE rr.id IN (${placeholders})`,
        )
        .all(...part) as { id: string; project_id: string | null }[];
      for (const r of rows) {
        if (r.project_id !== null) resolved.set(r.id, r.project_id);
      }
    }
    const n = this.deleteByIds('runtime_runs', 'id', ids);
    if (n > 0 && resolved.size > 0) {
      const deletedAt = new Date().toISOString();
      const stillThere = this.db.prepare(
        'SELECT id FROM runtime_runs WHERE id = ?',
      );
      for (const [runId, projectId] of resolved) {
        // Tombstone only rows that actually disappeared.
        if (stillThere.get(runId) === undefined) {
          this.recordRunTombstone(runId, projectId, deletedAt);
        }
      }
    }
    return n;
  }

  deleteStepIntents(ids: string[]): number {
    return this.deleteByIds('step_intents', 'id', ids);
  }

  /** Checkpoint identity is composite: ids are encoded 'runId#stepPosition'. */
  deleteCheckpoints(ids: string[]): number {
    let n = 0;
    const stmt = this.db.prepare(
      'DELETE FROM checkpoints WHERE run_id = ? AND step_position = ?',
    );
    for (const id of ids) {
      const hash = id.lastIndexOf('#');
      if (hash < 0) continue;
      const res = stmt.run(id.slice(0, hash), Number(id.slice(hash + 1)));
      n += Number(res.changes);
    }
    return n;
  }

  private deleteByIds(table: string, column: string, ids: string[]): number {
    if (ids.length === 0) return 0;
    let n = 0;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const placeholders = part.map(() => '?').join(',');
      const res = this.db
        .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`)
        .run(...part);
      n += Number(res.changes);
    }
    return n;
  }
}
