/**
 * SQLite-backed RequirementStore — SPEC v2 §16 (first-run walkthrough F2).
 *
 * The RequirementManager behind /api/requirements used to be a bare
 * process-wide singleton: requirements, their immutable versions, §16
 * evidence-compatibility declarations, promotion holds and entity
 * links all vanished on restart — registering evidence with a
 * requirement pin then failed with "unknown requirement version", and
 * a task caught mid-STALE-gate could only proceed after an operator
 * recreated the requirement, its versions, and the declarations in the
 * new process. This store keeps the RequirementStore contract (the
 * seam in @ai-factory/requirements) on top of the requirements tables:
 * same record shapes, same ordering — only the backing changes.
 *
 * Why `implements RequirementStore` (not `extends` anything): the
 * manager takes the store as an interface — exactly like
 * OperationLedger / SqliteOperationStore and CheckpointLog /
 * SqliteCheckpointStore — so the requirements package keeps sole
 * ownership of the §16 gates and lifecycle semantics, and this class
 * is pure persistence.
 *
 * Storage layout: a requirement row (id / status / created_at) plus
 * one requirement_versions row per version whose payload is the full
 * RequirementVersion JSON. Versions are immutable (§16), so a version
 * row is written once — INSERT ... ON CONFLICT DO NOTHING — and never
 * updated; putRequirement only ever adds rows for versions the store
 * has not seen. Links, holds, compatibility declarations and the
 * auto-id sequence live in their own tables (see schema.ts); composite
 * records are JSON text, which is lossless for these shapes, and every
 * read is a fresh parse — so the seam's deep-copy contract holds
 * structurally.
 */

import { DatabaseSync } from 'node:sqlite';
import type {
  EntityLinks,
  EvidenceCompatibility,
  PromotionHold,
  Requirement,
  RequirementStore,
  RequirementVersion,
} from '@ai-factory/requirements';

export class SqliteRequirementStore implements RequirementStore {
  constructor(private readonly db: DatabaseSync) {}

  listRequirements(): Requirement[] {
    const rows = this.db
      .prepare('SELECT * FROM requirements ORDER BY rowid')
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const versions = (
        this.db
          .prepare(
            'SELECT payload FROM requirement_versions WHERE requirement_id = ? ORDER BY version',
          )
          .all(r['id'] as string) as unknown as Array<Record<string, unknown>>
      ).map((v) => JSON.parse(v['payload'] as string) as RequirementVersion);
      return {
        id: r['id'] as string,
        status: r['status'] as Requirement['status'],
        createdAt: r['created_at'] as string,
        versions,
      };
    });
  }

  putRequirement(requirement: Requirement): void {
    this.db
      .prepare(
        `INSERT INTO requirements (id, status, created_at) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status`,
      )
      .run(requirement.id, requirement.status, requirement.createdAt);
    // Versions are immutable: a version row is written once and never
    // updated — a re-put of the same requirement only adds the rows
    // for versions appended since the last put.
    const insertVersion = this.db.prepare(
      `INSERT INTO requirement_versions (requirement_id, version, payload, created_at)
       VALUES (?,?,?,?)
       ON CONFLICT(requirement_id, version) DO NOTHING`,
    );
    for (const v of requirement.versions) {
      insertVersion.run(requirement.id, v.version, JSON.stringify(v), v.createdAt);
    }
  }

  listLinks(): Array<{ requirementId: string; version: number; links: EntityLinks }> {
    const rows = this.db
      .prepare('SELECT * FROM requirement_links ORDER BY rowid')
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      requirementId: r['requirement_id'] as string,
      version: Number(r['version']),
      links: JSON.parse(r['payload'] as string) as EntityLinks,
    }));
  }

  putLinks(requirementId: string, version: number, links: EntityLinks): void {
    this.db
      .prepare(
        `INSERT INTO requirement_links (requirement_id, version, payload) VALUES (?,?,?)
         ON CONFLICT(requirement_id, version) DO UPDATE SET payload=excluded.payload`,
      )
      .run(requirementId, version, JSON.stringify(links));
  }

  listHolds(): PromotionHold[] {
    const rows = this.db
      .prepare('SELECT payload FROM promotion_holds ORDER BY rowid')
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => JSON.parse(r['payload'] as string) as PromotionHold);
  }

  putHold(hold: PromotionHold): void {
    this.db
      .prepare(
        `INSERT INTO promotion_holds (id, task_id, requirement_id, requirement_version, payload)
         VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
      )
      .run(
        hold.id,
        hold.taskId,
        hold.requirementId,
        hold.requirementVersion,
        JSON.stringify(hold),
      );
  }

  listCompatibility(): EvidenceCompatibility[] {
    const rows = this.db
      .prepare('SELECT payload FROM evidence_compatibility ORDER BY rowid')
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => JSON.parse(r['payload'] as string) as EvidenceCompatibility);
  }

  addCompatibility(record: EvidenceCompatibility): void {
    this.db
      .prepare(
        `INSERT INTO evidence_compatibility
           (evidence_id, requirement_id, requirement_version, compatible, payload)
         VALUES (?,?,?,?,?)`,
      )
      .run(
        record.evidenceId,
        record.requirementId,
        record.requirementVersion,
        record.compatible ? 1 : 0,
        JSON.stringify(record),
      );
  }

  getSeq(): number {
    const r = this.db
      .prepare("SELECT value FROM requirement_store_meta WHERE key = 'seq'")
      .get() as Record<string, unknown> | undefined;
    return r ? Number(r['value']) : 0;
  }

  setSeq(seq: number): void {
    this.db
      .prepare(
        `INSERT INTO requirement_store_meta (key, value) VALUES ('seq', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(String(seq));
  }
}
