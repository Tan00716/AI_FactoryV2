/**
 * Durable versioned policy documents — SPEC v2 §48.2 Authorization
 * domain (`policy_documents`, `policy_versions`), Batch 34.
 *
 * AUDIT (stated honestly, no invented wiring): SPEC v2 lists
 * `policy_documents` / `policy_versions` in the Authorization domain
 * alongside capabilities, capability_revocations and exception_grants —
 * a versioned record of the policy documents themselves (important
 * versions immutable, per the §48.2 trailing note). Until Batch 34 no
 * such entity existed anywhere in the codebase. The codebase HAS four
 * `policy_version`-flavoured STRINGS, and none of them is this entity:
 *
 *  1. `approvals.policy_version` (§23.3, packages/approvals): a
 *     per-approval string field — "the policy version the evaluation
 *     ran against" — default 'v1'. Already persisted as a TEXT column
 *     on the approvals row. It is a label, not a document reference.
 *  2. `escalations.authPolicyVersion` (packages/autonomy): a
 *     per-escalation string field.
 *  3. `projects.policy_version` (Batch 33, packages/db): a per-project
 *     string field (§6.1 record field).
 *  4. `deployments.policySnapshot` (packages/cicd): an opaque `unknown`
 *     evaluation snapshot embedded in the deployment spec and
 *     persisted with the deployment (§41 deploy spec).
 *
 * These are four independent shapes — labels, not documents — and this
 * store does NOT rewire them. The approval/project/escalation string
 * fields keep their meaning as-is; this table is the authoritative
 * record of policy documents and their versions going forward. Any
 * cross-reference between them would be invented, so none is claimed.
 *
 * Record semantics (pinned by tests):
 *  - registerPolicyVersion appends the next version for a policy
 *    document: version = max(existing versions) + 1, computed inside
 *    one BEGIN IMMEDIATE…COMMIT transaction; a UNIQUE(policy_id,
 *    version) index arbitrates concurrent writers (bounded retry on
 *    conflict). Versions start at 1 and are integers — honest,
 *    deterministic, human-readable ordering ("版本递增" per the task).
 *  - Rows are append-only and immutable: there is NO update API and NO
 *    delete API. "CURRENT" is derived, not stored — the highest version
 *    of a policy is current, all lower ones are SUPERSEDED. No old row
 *    is ever rewritten, not even its status.
 *  - content is opaque to the store (a JSON string); contentHash is a
 *    sha256 over the exact bytes, so a reader can verify integrity.
 *  - listPolicyVersions returns newest-first (version DESC).
 *  - Corrupt rows fail loudly: version must be an integer ≥ 1 and the
 *    required columns must be present; anything else throws.
 *
 * Copy contract: every read returns a fresh deep copy (structuredClone
 * in memory, fresh objects in SQLite).
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface PolicyVersionRecord {
  policyId: string;
  /** Per-policy monotonic integer, starting at 1. */
  version: number;
  /** Opaque policy document content (JSON string, byte-exact). */
  contentJson: string;
  /** sha256 hex over the exact contentJson bytes. */
  contentHash: string;
  createdBy: string;
  createdAt: number;
}

export type PolicyVersionStatus = 'CURRENT' | 'SUPERSEDED';

export interface PolicyVersionView extends PolicyVersionRecord {
  /** Derived: 'CURRENT' iff this is the highest version of its policy. */
  status: PolicyVersionStatus;
}

export interface RegisterPolicyVersionInput {
  policyId: string;
  contentJson: string;
  createdBy: string;
  createdAt: number;
}

export interface PolicyVersionStore {
  /**
   * Append the next version for the policy document. Returns the stored
   * record (with its assigned version). Never edits or removes rows.
   */
  registerPolicyVersion(input: RegisterPolicyVersionInput): PolicyVersionRecord;
  getPolicyVersion(policyId: string, version: number): PolicyVersionRecord | undefined;
  /** Newest-first (version DESC); optionally scoped to one policy. */
  listPolicyVersions(policyId?: string): PolicyVersionRecord[];
}

const copy = <T>(v: T): T => structuredClone(v);

export function hashPolicyContent(contentJson: string): string {
  return createHash('sha256').update(contentJson, 'utf8').digest('hex');
}

function checkInput(input: RegisterPolicyVersionInput): void {
  if (typeof input.policyId !== 'string' || input.policyId.length === 0) {
    throw new Error('policyId must be a non-empty string');
  }
  if (typeof input.contentJson !== 'string' || input.contentJson.length === 0) {
    throw new Error('contentJson must be a non-empty string');
  }
  if (typeof input.createdBy !== 'string' || input.createdBy.length === 0) {
    throw new Error('createdBy must be a non-empty string');
  }
  if (!Number.isInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error('createdAt must be a non-negative integer');
  }
}

/** In-memory implementation: the behavior reference. */
export class InMemoryPolicyVersionStore implements PolicyVersionStore {
  private readonly rows: PolicyVersionRecord[] = [];

  registerPolicyVersion(input: RegisterPolicyVersionInput): PolicyVersionRecord {
    checkInput(input);
    const maxVersion = this.rows.reduce(
      (m, r) => (r.policyId === input.policyId && r.version > m ? r.version : m),
      0,
    );
    const record: PolicyVersionRecord = {
      policyId: input.policyId,
      version: maxVersion + 1,
      contentJson: input.contentJson,
      contentHash: hashPolicyContent(input.contentJson),
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    };
    this.rows.push(record);
    return copy(record);
  }

  getPolicyVersion(policyId: string, version: number): PolicyVersionRecord | undefined {
    const r = this.rows.find((r) => r.policyId === policyId && r.version === version);
    return r === undefined ? undefined : copy(r);
  }

  listPolicyVersions(policyId?: string): PolicyVersionRecord[] {
    return this.rows
      .filter((r) => policyId === undefined || r.policyId === policyId)
      .sort((a, b) => {
        if (a.policyId !== b.policyId) return a.policyId < b.policyId ? -1 : 1;
        return b.version - a.version;
      })
      .map((r) => copy(r));
  }
}

function rowToPolicyVersion(row: Record<string, unknown>): PolicyVersionRecord {
  // Corrupt rows fail loudly — Batch 31 convention, never guess.
  const policyId = row['policy_id'];
  const version = row['version'];
  const contentJson = row['content_json'];
  const contentHash = row['content_hash'];
  const createdBy = row['created_by'];
  const createdAt = row['created_at'];
  if (typeof policyId !== 'string' || policyId.length === 0) {
    throw new Error(`corrupt policy_versions row: bad policy_id ${String(policyId)}`);
  }
  if (!Number.isInteger(version) || (version as number) < 1) {
    throw new Error(
      `corrupt policy_versions row: bad version ${String(version)} for policy ${policyId}`,
    );
  }
  if (typeof contentJson !== 'string' || typeof contentHash !== 'string') {
    throw new Error(`corrupt policy_versions row: bad content for policy ${policyId}`);
  }
  if (typeof createdBy !== 'string' || createdBy.length === 0) {
    throw new Error(`corrupt policy_versions row: bad created_by for policy ${policyId}`);
  }
  if (!Number.isInteger(createdAt) || (createdAt as number) < 0) {
    throw new Error(`corrupt policy_versions row: bad created_at for policy ${policyId}`);
  }
  return {
    policyId,
    version: version as number,
    contentJson,
    contentHash,
    createdBy,
    createdAt: createdAt as number,
  };
}

const MAX_REGISTER_ATTEMPTS = 8;

/** SQLite implementation. Tables are created by SCHEMA (IF NOT EXISTS). */
export class SqlitePolicyVersionStore implements PolicyVersionStore {
  constructor(private readonly db: DatabaseSync) {}

  registerPolicyVersion(input: RegisterPolicyVersionInput): PolicyVersionRecord {
    checkInput(input);
    // Per-policy monotonic version: max+1 inside one BEGIN IMMEDIATE
    // transaction; UNIQUE(policy_id, version) arbitrates concurrent
    // writers with a bounded retry (Batch 26 merge-queue pattern).
    for (let attempt = 1; attempt <= MAX_REGISTER_ATTEMPTS; attempt++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const maxRow = this.db
          .prepare('SELECT MAX(version) AS m FROM policy_versions WHERE policy_id = ?')
          .get(input.policyId) as { m: number | null };
        const version = (maxRow.m ?? 0) + 1;
        const contentHash = hashPolicyContent(input.contentJson);
        this.db
          .prepare(
            `INSERT INTO policy_versions
               (policy_id, version, content_json, content_hash, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.policyId,
            version,
            input.contentJson,
            contentHash,
            input.createdBy,
            input.createdAt,
          );
        this.db.exec('COMMIT');
        return {
          policyId: input.policyId,
          version,
          contentJson: input.contentJson,
          contentHash,
          createdBy: input.createdBy,
          createdAt: input.createdAt,
        };
      } catch (e) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* already rolled back / no transaction */
        }
        if (isUniqueViolation(e) && attempt < MAX_REGISTER_ATTEMPTS) {
          continue; // another writer won the race; retry with a fresh max
        }
        throw e;
      }
    }
    throw new Error(
      `policy_versions: concurrent registration for ${input.policyId} failed after ${MAX_REGISTER_ATTEMPTS} attempts`,
    );
  }

  getPolicyVersion(policyId: string, version: number): PolicyVersionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM policy_versions WHERE policy_id = ? AND version = ?')
      .get(policyId, version) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToPolicyVersion(row);
  }

  listPolicyVersions(policyId?: string): PolicyVersionRecord[] {
    const rows =
      policyId === undefined
        ? (this.db
            .prepare('SELECT * FROM policy_versions ORDER BY policy_id ASC, version DESC')
            .all() as Record<string, unknown>[])
        : (this.db
            .prepare(
              'SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version DESC',
            )
            .all(policyId) as Record<string, unknown>[]);
    return rows.map(rowToPolicyVersion);
  }
}

/**
 * Status is derived, not stored: the highest version of a policy is
 * CURRENT, all lower versions are SUPERSEDED. Deriving keeps old rows
 * immutable — no UPDATE ever touches a published version.
 */
export function statusOf(
  record: PolicyVersionRecord,
  versions: readonly PolicyVersionRecord[],
): PolicyVersionStatus {
  for (const v of versions) {
    if (v.policyId === record.policyId && v.version > record.version) {
      return 'SUPERSEDED';
    }
  }
  return 'CURRENT';
}

function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // SQLite UNIQUE errors name the violated columns, not the index
  // (Batch 26 pitfall — see ~/AGENTS.md).
  return /UNIQUE constraint failed/i.test(e.message);
}
