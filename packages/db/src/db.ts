/**
 * SQLite-backed persistence for the core domain stores.
 * Implements the store interfaces from @ai-factory/core on top of
 * node:sqlite (DatabaseSync). JSON columns are (de)serialized here so the
 * domain layer keeps working with plain objects.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import {
  Agent,
  AgentStore,
  AuditRecord,
  AuditStore,
  Evidence,
  EvidenceStore,
  Task,
  TaskStore,
} from '@ai-factory/core';
import type { Approval, ApprovalStore } from '@ai-factory/approvals';
import type { CrossProjectReusable, MemoryEntry } from '@ai-factory/memory';
import { SCHEMA } from './schema';
import { SqliteStepIntentStore } from './step-intents';
import { SqliteOperationStore } from './operations';
import { SqliteCheckpointStore } from './checkpoints';
import { SqliteRequirementStore } from './requirements';
import { SqliteRuntimeRunStore } from './runs';
import { SqliteRunManifestStore } from './run-manifests';
import { SqliteTaskV2StateStore } from './task-v2-state';
import { SqliteOutboxStore } from './outbox';
import { SqliteRetentionStore } from './retention';
import { SqliteBackupScheduleStore } from './backup-schedules';
import { SqliteAuthorizationTicketStore } from './authorization-tickets';
import { SqliteMergeQueueEntryStore, SqliteMergeQueueDrainLock, SqlitePrStore } from './merge-queue';
import { NO_SBOM_NOTE, SqliteBuildRecordStore } from './builds';
import { SqliteDeploymentStore } from './deployments';
import { SqlitePipelineRecordStore } from './pipelines';
import { SqliteWorktreeStore } from './worktrees';
import { SqliteMcpServerStore } from './mcp-servers';
import { SqliteGateStore } from './gates';
import { SqliteDelegationStore } from './delegations';

const J = {
  parse<T>(s: string | null, fallback: T): T {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  },
  stringify(v: unknown): string {
    return JSON.stringify(v ?? null);
  },
};

// ---------------------------------------------------------------- tasks ---
function rowToTask(r: Record<string, unknown>): Task {
  const s = (k: string) => r[k] as string;
  return {
    id: s('id'),
    projectId: s('project_id'),
    parentTaskId: (r['parent_task_id'] as string) ?? null,
    title: s('title'),
    goal: s('goal'),
    description: s('description'),
    priority: s('priority') as Task['priority'],
    severity: s('severity') as Task['severity'],
    acceptanceCriteria: J.parse<string[]>(r['acceptance_criteria'] as string, []),
    constraints: J.parse<string[]>(r['constraints'] as string, []),
    workspace: s('workspace'),
    creator: s('creator'),
    // §17.2 (Batch 17) — pre-existing rows in a not-yet-migrated DB read
    // AUTHORIZED, the behaviour they always had; migrateTasksTable adds
    // the column with that same default at open (see below).
    authorizationStatus: (r['authorization_status'] as Task['authorizationStatus']) ?? 'AUTHORIZED',
    // §17.4 (Batch 18) — inheritance carriers. All optional on the
    // Task type; rows from a not-yet-migrated DB (or rows that never
    // set them) read back with the field ABSENT, never with an
    // invented value — "not recorded" and "recorded empty" stay
    // distinguishable, exactly like the authorization column above.
    ...(typeof r['requirement_ref'] === 'string'
      ? { requirementRef: r['requirement_ref'] as string }
      : {}),
    ...(typeof r['policy_ceiling'] === 'string'
      ? { policyCeiling: J.parse<string[]>(r['policy_ceiling'] as string, []) }
      : {}),
    ...(typeof r['budget_envelope'] === 'string'
      ? {
          budgetEnvelope: J.parse<Record<string, number>>(
            r['budget_envelope'] as string,
            {},
          ),
        }
      : {}),
    ...(typeof r['parent_relation'] === 'string'
      ? { parentRelation: r['parent_relation'] as string }
      : {}),
    status: s('status') as Task['status'],
    currentAgentId: (r['current_agent_id'] as string) ?? null,
    assignedAgentIds: J.parse<string[]>(r['assigned_agents'] as string, []),
    subtaskIds: J.parse<string[]>(r['subtask_ids'] as string, []),
    dependencies: J.parse<Task['dependencies']>(r['dependencies'] as string, []),
    risk: s('risk') as Task['risk'],
    createdAt: s('created_at'),
    updatedAt: s('updated_at'),
    completedAt: (r['completed_at'] as string) ?? null,
  };
}

export class SqliteTaskStore implements TaskStore {
  constructor(private db: DatabaseSync) {}
  save(t: Task): void {
    this.db.prepare(
      `INSERT INTO tasks (id, project_id, parent_task_id, title, goal, description,
        priority, severity, acceptance_criteria, constraints, workspace, creator,
        authorization_status, requirement_ref, policy_ceiling, budget_envelope,
        parent_relation, status, current_agent_id, assigned_agents, subtask_ids,
        dependencies, risk, created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
        parent_task_id=excluded.parent_task_id, title=excluded.title, goal=excluded.goal,
        description=excluded.description, priority=excluded.priority, severity=excluded.severity,
        acceptance_criteria=excluded.acceptance_criteria, constraints=excluded.constraints,
        workspace=excluded.workspace, creator=excluded.creator,
        authorization_status=excluded.authorization_status,
        requirement_ref=excluded.requirement_ref, policy_ceiling=excluded.policy_ceiling,
        budget_envelope=excluded.budget_envelope, parent_relation=excluded.parent_relation,
        status=excluded.status,
        current_agent_id=excluded.current_agent_id, assigned_agents=excluded.assigned_agents,
        subtask_ids=excluded.subtask_ids, dependencies=excluded.dependencies,
        risk=excluded.risk, updated_at=excluded.updated_at, completed_at=excluded.completed_at`,
    ).run(
      t.id, t.projectId, t.parentTaskId, t.title, t.goal, t.description,
      t.priority, t.severity, J.stringify(t.acceptanceCriteria), J.stringify(t.constraints),
      t.workspace, t.creator, t.authorizationStatus ?? 'AUTHORIZED',
      t.requirementRef ?? null,
      t.policyCeiling !== undefined ? J.stringify(t.policyCeiling) : null,
      t.budgetEnvelope !== undefined ? J.stringify(t.budgetEnvelope) : null,
      t.parentRelation ?? null,
      t.status, t.currentAgentId,
      J.stringify(t.assignedAgentIds),
      J.stringify(t.subtaskIds), J.stringify(t.dependencies), t.risk,
      t.createdAt, t.updatedAt, t.completedAt,
    );
  }
  get(id: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToTask(r) : undefined;
  }
  list(): Task[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToTask);
  }
  listByProject(projectId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at').all(projectId) as Record<string, unknown>[]).map(rowToTask);
  }
}

// -------------------------------------------------------------- evidence ---
/**
 * §16/§18.2 (Batch 8) column. Existing local DBs are migrated in place:
 * only the missing column is added (see migrateApprovalsTable). Pre-Batch-8
 * rows read back with requirementVersion null — never recorded, never
 * backfilled with an invented version.
 */
export function migrateEvidenceTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(evidence)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  if (!cols.has('requirement_version')) {
    db.exec(`ALTER TABLE evidence ADD COLUMN requirement_version TEXT`);
  }
}

function rowToEvidence(r: Record<string, unknown>): Evidence {
  const s = (k: string) => r[k] as string;
  return {
    id: s('id'),
    taskId: s('task_id'),
    type: s('type') as Evidence['type'],
    title: s('title'),
    payload: J.parse<Record<string, unknown>>(r['payload'] as string, {}),
    status: s('status') as Evidence['status'],
    createdBy: s('created_by'),
    createdAt: s('created_at'),
    sealedAt: (r['sealed_at'] as string) ?? null,
    requirementVersion: (r['requirement_version'] as string) ?? null,
  };
}

export class SqliteEvidenceStore implements EvidenceStore {
  constructor(private db: DatabaseSync) {}
  save(ev: Evidence): void {
    this.db.prepare(
      `INSERT INTO evidence (id, task_id, type, title, payload, status, created_by, created_at, sealed_at, requirement_version)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, payload=excluded.payload,
        status=excluded.status, sealed_at=excluded.sealed_at,
        requirement_version=excluded.requirement_version`,
    ).run(ev.id, ev.taskId, ev.type, ev.title, J.stringify(ev.payload), ev.status, ev.createdBy, ev.createdAt, ev.sealedAt, ev.requirementVersion ?? null);
  }
  get(id: string): Evidence | undefined {
    const r = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToEvidence(r) : undefined;
  }
  listByTask(taskId: string): Evidence[] {
    return (this.db.prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at').all(taskId) as Record<string, unknown>[]).map(rowToEvidence);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------- agents ---
function rowToAgent(r: Record<string, unknown>): Agent {
  const s = (k: string) => r[k] as string;
  return {
    id: s('id'),
    name: s('name'),
    displayName: s('display_name'),
    jobTitle: s('job_title'),
    department: s('department'),
    parentAgentId: (r['parent_agent_id'] as string) ?? null,
    mission: s('mission'),
    instructions: s('instructions'),
    skills: J.parse<string[]>(r['skills'] as string, []),
    rules: J.parse<string[]>(r['rules'] as string, []),
    model: s('model'),
    reasoningLevel: s('reasoning_level') as Agent['reasoningLevel'],
    tools: J.parse<string[]>(r['tools'] as string, []),
    permissions: J.parse<Agent['permissions']>(r['permissions'] as string, []),
    autonomyLevel: Number(r['autonomy_level']) as Agent['autonomyLevel'],
    status: s('status') as Agent['status'],
    version: Number(r['version']),
    createdAt: s('created_at'),
    updatedAt: s('updated_at'),
  };
}

export class SqliteAgentStore implements AgentStore {
  constructor(private db: DatabaseSync) {}
  save(a: Agent): void {
    this.db.prepare(
      `INSERT INTO agents (id, name, display_name, job_title, department, parent_agent_id,
        mission, instructions, skills, rules, model, reasoning_level, tools, permissions,
        autonomy_level, status, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, job_title=excluded.job_title,
        department=excluded.department, parent_agent_id=excluded.parent_agent_id, mission=excluded.mission,
        instructions=excluded.instructions, skills=excluded.skills, rules=excluded.rules,
        model=excluded.model, reasoning_level=excluded.reasoning_level, tools=excluded.tools,
        permissions=excluded.permissions, autonomy_level=excluded.autonomy_level,
        status=excluded.status, version=excluded.version, updated_at=excluded.updated_at`,
    ).run(
      a.id, a.name, a.displayName, a.jobTitle, a.department, a.parentAgentId, a.mission,
      a.instructions, J.stringify(a.skills), J.stringify(a.rules), a.model, a.reasoningLevel,
      J.stringify(a.tools), J.stringify(a.permissions), a.autonomyLevel, a.status, a.version,
      a.createdAt, a.updatedAt,
    );
  }
  get(id: string): Agent | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToAgent(r) : undefined;
  }
  list(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToAgent);
  }
}

// ------------------------------------------------------------- approvals ---
/**
 * Adds the Batch 23 drain-claim columns (claimed_by / claimed_at) to
 * pre-existing merge_queue_entries tables. Fresh databases get them
 * from SCHEMA; only the missing columns are added here.
 */
export function migrateMergeQueueTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(merge_queue_entries)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  if (!cols.has('claimed_by')) db.exec('ALTER TABLE merge_queue_entries ADD COLUMN claimed_by TEXT');
  if (!cols.has('claimed_at')) db.exec('ALTER TABLE merge_queue_entries ADD COLUMN claimed_at TEXT');
  // Batch 26 — (repo_path, position) is the arbiter for cross-process
  // enqueue position allocation, so it must be unique. Pre-existing
  // duplicates (two processes enqueueing on old code) are repaired
  // deterministically first: keep the earliest-enqueued row at the
  // collided position, bump the rest past the current max — relative
  // order is preserved, no entry is dropped.
  // NOTE: this lives here and NOT in SCHEMA — SCHEMA runs before the
  // migrations, and a dirty old DB must be repaired before the unique
  // index can exist.
  const dupes = db
    .prepare(
      `SELECT repo_path AS repo, position FROM merge_queue_entries
       GROUP BY repo_path, position HAVING COUNT(*) > 1`,
    )
    .all() as { repo: string; position: number }[];
  if (dupes.length > 0) {
    const maxStmt = db.prepare(
      'SELECT MAX(position) AS m FROM merge_queue_entries WHERE repo_path = ?',
    );
    const rowsStmt = db.prepare(
      `SELECT id FROM merge_queue_entries
       WHERE repo_path = ? AND position = ?
       ORDER BY enqueued_at ASC, id ASC`,
    );
    const bumpStmt = db.prepare(
      'UPDATE merge_queue_entries SET position = ? WHERE id = ?',
    );
    for (const { repo, position } of dupes) {
      const rows = rowsStmt.all(repo, position) as { id: string }[];
      let next = (maxStmt.get(repo) as { m: number }).m;
      for (const r of rows.slice(1)) {
        next += 1;
        bumpStmt.run(next, r.id);
      }
    }
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS merge_queue_repo_position ON merge_queue_entries(repo_path, position)',
  );
}
/**
 * Batch 25 — cross-process write mutual exclusion for MCP
 * registrations. Older databases have mcp_servers without the
 * row_version generation column; add it in place (existing rows
 * start at 1, which is a valid base for the first applyServerOp).
 */
export function migrateMcpServersTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(mcp_servers)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  if (!cols.has('row_version')) db.exec('ALTER TABLE mcp_servers ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1');
}
/**
 * SPEC v2 §23.3 columns. Existing local DBs are migrated in place: only
 * missing columns are added. rowToApproval falls back to the v1 column names
 * (id, requested_by, required_approver, expires_at) so pre-v2 databases keep
 * working read-only.
 */
export function migrateApprovalsTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(approvals)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  const add = (ddl: string, name: string): void => {
    if (!cols.has(name)) db.exec(`ALTER TABLE approvals ADD COLUMN ${ddl}`);
  };
  add(`approval_id TEXT`, 'approval_id');
  add(`action_digest TEXT DEFAULT ''`, 'action_digest');
  add(`requester TEXT DEFAULT ''`, 'requester');
  add(`reversibility_ref TEXT DEFAULT ''`, 'reversibility_ref');
  add(`requirement_version TEXT DEFAULT ''`, 'requirement_version');
  add(`candidate_digest TEXT DEFAULT ''`, 'candidate_digest');
  add(`environment TEXT DEFAULT ''`, 'environment');
  add(`evidence_manifest_hash TEXT DEFAULT ''`, 'evidence_manifest_hash');
  add(`policy_version TEXT DEFAULT ''`, 'policy_version');
  add(`required_approvers TEXT DEFAULT '["human"]'`, 'required_approvers');
  add(`decision_reason TEXT DEFAULT ''`, 'decision_reason');
  add(`deadline TEXT`, 'deadline');
  // v1 leftovers kept for read fallback:
  add(`requested_by TEXT DEFAULT ''`, 'requested_by');
  add(`required_approver TEXT DEFAULT 'human'`, 'required_approver');
  add(`expires_at TEXT`, 'expires_at');
  db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id)');
}

function rowToApproval(r: Record<string, unknown>): Approval {
  const s = (k: string) => r[k] as string;
  const first = (...ks: string[]): string => {
    for (const k of ks) {
      const v = r[k];
      if (typeof v === 'string' && v !== '') return v;
    }
    return '';
  };
  let requiredApprovers: string[] = ['human'];
  const rawApprovers = r['required_approvers'] as string | undefined;
  if (typeof rawApprovers === 'string' && rawApprovers !== '') {
    try {
      const parsed: unknown = JSON.parse(rawApprovers);
      if (Array.isArray(parsed) && parsed.every((e) => typeof e === 'string')) {
        requiredApprovers = parsed as string[];
      }
    } catch {
      // fall through to default
    }
  } else if (typeof r['required_approver'] === 'string' && r['required_approver'] !== '') {
    requiredApprovers = [r['required_approver'] as string]; // v1 fallback
  }
  return {
    approval_id: first('approval_id', 'id'),
    action_digest: s('action_digest') ?? '',
    action: s('action'),
    task_id: s('task_id') ?? '',
    requirement_version: s('requirement_version') ?? '',
    candidate_digest: s('candidate_digest') ?? '',
    environment: s('environment') ?? '',
    risk_level: (s('risk_level') ?? 'MEDIUM') as Approval['risk_level'],
    reversibility_ref: s('reversibility_ref') ?? '',
    evidence_manifest_hash: s('evidence_manifest_hash') ?? '',
    policy_version: s('policy_version') ?? '',
    requester: first('requester', 'requested_by'),
    required_approvers: requiredApprovers,
    status: (s('status') ?? 'PENDING') as Approval['status'],
    decision: (s('decision') ?? '') as Approval['decision'],
    decision_reason: s('decision_reason') ?? '',
    decided_by: s('decided_by') ?? '',
    created_at: s('created_at'),
    decided_at: (r['decided_at'] as string) ?? null,
    deadline: (r['deadline'] as string) ?? (r['expires_at'] as string) ?? null,
  };
}

export class SqliteApprovalStore implements ApprovalStore {
  constructor(private db: DatabaseSync) {}
  save(a: Approval): void {
    this.db.prepare(
      `INSERT INTO approvals (approval_id, task_id, action, action_digest, requester,
        risk_level, reversibility_ref, requirement_version, candidate_digest,
        environment, evidence_manifest_hash, policy_version, required_approvers,
        status, decision, decision_reason, decided_by, created_at, decided_at, deadline)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(approval_id) DO UPDATE SET task_id=excluded.task_id, action=excluded.action,
        action_digest=excluded.action_digest, requester=excluded.requester,
        risk_level=excluded.risk_level, reversibility_ref=excluded.reversibility_ref,
        requirement_version=excluded.requirement_version,
        candidate_digest=excluded.candidate_digest, environment=excluded.environment,
        evidence_manifest_hash=excluded.evidence_manifest_hash,
        policy_version=excluded.policy_version,
        required_approvers=excluded.required_approvers, status=excluded.status,
        decision=excluded.decision, decision_reason=excluded.decision_reason,
        decided_by=excluded.decided_by, decided_at=excluded.decided_at,
        deadline=excluded.deadline`,
    ).run(
      a.approval_id, a.task_id, a.action, a.action_digest, a.requester,
      a.risk_level, a.reversibility_ref, a.requirement_version, a.candidate_digest,
      a.environment, a.evidence_manifest_hash, a.policy_version,
      J.stringify(a.required_approvers), a.status, a.decision, a.decision_reason,
      a.decided_by, a.created_at, a.decided_at, a.deadline,
    );
  }
  get(id: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToApproval(r) : undefined;
  }
  list(status?: Approval['status']): Approval[] {
    const rows = (
      status === undefined
        ? this.db.prepare('SELECT * FROM approvals ORDER BY created_at').all()
        : this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at').all(status)
    ) as Record<string, unknown>[];
    return rows.map(rowToApproval);
  }
  listByTask(taskId: string): Approval[] {
    return (
      this.db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at').all(taskId) as Record<string, unknown>[]
    ).map(rowToApproval);
  }
}

// ----------------------------------------------------------------- audit ---
/**
 * §32 (Batch 9) hash-chain columns. Existing local DBs are migrated in
 * place: only the missing columns are added (see migrateEvidenceTable).
 * The four columns are nullable ON PURPOSE: pre-chain rows have no
 * reason/result and no hashes, and must read back as legacy AuditRecords
 * (fields absent), never backfilled with invented values — core's
 * verifyAuditChain counts them as legacy and skips them.
 */
export function migrateAuditTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(audit_logs)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  const add = (ddl: string, name: string): void => {
    if (!cols.has(name)) db.exec(`ALTER TABLE audit_logs ADD COLUMN ${ddl}`);
  };
  add(`reason TEXT`, 'reason');
  add(`result TEXT`, 'result');
  add(`summary_hash TEXT`, 'summary_hash');
  add(`prev_hash TEXT`, 'prev_hash');
}

function rowToAuditRecord(r: Record<string, unknown>): AuditRecord {
  const rec: AuditRecord = {
    id: r['id'] as string,
    ts: r['ts'] as string,
    actor: r['actor'] as string,
    action: r['action'] as string,
    entityType: r['entity_type'] as string,
    entityId: r['entity_id'] as string,
    details: J.parse<Record<string, unknown>>(r['details'] as string, {}),
  };
  // Optional §32 fields are set ONLY when the column carries a value:
  // a legacy row must come back without the keys at all, exactly like a
  // record written before chaining existed (core hashes reason/result
  // with ?? null, so absence — not a stored '' — is the faithful form).
  if (typeof r['reason'] === 'string') rec.reason = r['reason'];
  if (typeof r['result'] === 'string') rec.result = r['result'];
  if (typeof r['summary_hash'] === 'string') rec.summaryHash = r['summary_hash'];
  if (typeof r['prev_hash'] === 'string') rec.prevHash = r['prev_hash'];
  return rec;
}

export class SqliteAuditStore implements AuditStore {
  constructor(private db: DatabaseSync) {}
  append(r: AuditRecord): void {
    this.db.prepare(
      `INSERT INTO audit_logs (id, ts, actor, action, entity_type, entity_id, details,
        reason, result, summary_hash, prev_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      r.id, r.ts, r.actor, r.action, r.entityType, r.entityId, J.stringify(r.details),
      r.reason ?? null, r.result ?? null, r.summaryHash ?? null, r.prevHash ?? null,
    );
  }
  list(): AuditRecord[] {
    // ORDER BY ts is the historical read order; the rowid tiebreak makes
    // it deterministic for same-millisecond appends, which is exactly
    // the append order the §32 hash chain commits to — verifyAuditChain
    // over a reloaded list must see the chain in the order it was written.
    return (this.db.prepare('SELECT * FROM audit_logs ORDER BY ts, rowid').all() as Record<string, unknown>[]).map(
      rowToAuditRecord,
    );
  }
}

// ---------------------------------------------------------------- memory ---
// Structured memory entries (spec §54–§56). The lifecycle logic (dedup,
// decay, verify) lives in @ai-factory/memory's MemoryStore; this store is
// the durable SQL backing with the same row mapping.
/**
 * SPEC v2 §43.2 columns. Existing local DBs are migrated in place: only
 * missing columns are added (see migrateMemoryTable). Pre-v2 rows read
 * back with secure defaults (internal classification, empty ACL).
 */
/**
 * Batch 20 — retention_policies gains keep_count (keep newest N
 * backups regardless of age). Existing databases are migrated in
 * place: only the missing column is added.
 */
export function migrateRetentionTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(retention_policies)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  if (!cols.has('keep_count')) {
    db.exec(`ALTER TABLE retention_policies ADD COLUMN keep_count INTEGER`);
  }
  if (!cols.has('delete_orphans')) {
    db.exec(`ALTER TABLE retention_policies ADD COLUMN delete_orphans INTEGER NOT NULL DEFAULT 0`);
  }
}

export function migrateMemoryTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(memory_entries)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  const add = (ddl: string, name: string): void => {
    if (!cols.has(name)) db.exec(`ALTER TABLE memory_entries ADD COLUMN ${ddl}`);
  };
  add(`source_refs TEXT DEFAULT '[]'`, 'source_refs');
  add(`confidence_kind TEXT DEFAULT 'model-self-assessed'`, 'confidence_kind');
  add(`task_refs TEXT DEFAULT '[]'`, 'task_refs');
  add(`access_scope TEXT DEFAULT '[]'`, 'access_scope');
  add(`data_classification TEXT DEFAULT 'internal'`, 'data_classification');
  add(`cross_project_reusable TEXT DEFAULT '{"allowed":false}'`, 'cross_project_reusable');
  add(`supersedes TEXT DEFAULT '[]'`, 'supersedes');
  add(`contradicts TEXT DEFAULT '[]'`, 'contradicts');
  add(`index_version TEXT DEFAULT 'v1'`, 'index_version');
}

function rowToMemoryEntry(r: Record<string, unknown>): MemoryEntry {
  const s = (k: string) => r[k] as string;
  return {
    id: s('id'),
    scope: s('scope') as MemoryEntry['scope'],
    scopeId: s('scope_id'),
    type: s('type') as MemoryEntry['type'],
    title: s('title'),
    content: s('content'),
    source: s('source'),
    sourceRefs: J.parse<string[]>((r['source_refs'] as string) ?? null, []),
    confidence: Number(r['confidence'] ?? 0),
    confidenceKind:
      (r['confidence_kind'] as MemoryEntry['confidenceKind']) ?? 'model-self-assessed',
    createdBy: s('created_by'),
    evidenceIds: J.parse<string[]>(r['evidence_ids'] as string, []),
    taskRefs: J.parse<string[]>((r['task_refs'] as string) ?? null, []),
    lastVerifiedAt: s('last_verified_at'),
    applicableScope: s('applicable_scope'),
    accessScope: J.parse<string[]>((r['access_scope'] as string) ?? null, []),
    dataClassification: (r['data_classification'] as MemoryEntry['dataClassification']) ?? 'internal',
    crossProjectReusable: J.parse<CrossProjectReusable>(
      (r['cross_project_reusable'] as string) ?? null,
      { allowed: false },
    ),
    expiresAt: (r['expires_at'] as string) ?? null,
    status: s('status') as MemoryEntry['status'],
    supersedes: J.parse<string[]>((r['supersedes'] as string) ?? null, []),
    contradicts: J.parse<string[]>((r['contradicts'] as string) ?? null, []),
    indexVersion: (r['index_version'] as string) ?? 'v1',
    createdAt: s('created_at'),
    updatedAt: s('updated_at'),
  };
}

export class SqliteMemoryStore {
  constructor(private db: DatabaseSync) {}
  upsert(e: MemoryEntry): void {
    this.db.prepare(
      `INSERT INTO memory_entries
         (id, scope, scope_id, type, title, content, source, source_refs,
          confidence, confidence_kind, created_by, evidence_ids, task_refs,
          last_verified_at, applicable_scope, access_scope, data_classification,
          cross_project_reusable, expires_at, status, supersedes, contradicts,
          index_version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, content=excluded.content, source=excluded.source,
         source_refs=excluded.source_refs, confidence=excluded.confidence,
         confidence_kind=excluded.confidence_kind, evidence_ids=excluded.evidence_ids,
         task_refs=excluded.task_refs, last_verified_at=excluded.last_verified_at,
         applicable_scope=excluded.applicable_scope, access_scope=excluded.access_scope,
         data_classification=excluded.data_classification,
         cross_project_reusable=excluded.cross_project_reusable,
         expires_at=excluded.expires_at, status=excluded.status,
         supersedes=excluded.supersedes, contradicts=excluded.contradicts,
         index_version=excluded.index_version, updated_at=excluded.updated_at`,
    ).run(
      e.id, e.scope, e.scopeId, e.type, e.title, e.content, e.source,
      J.stringify(e.sourceRefs), e.confidence, e.confidenceKind,
      e.createdBy, J.stringify(e.evidenceIds), J.stringify(e.taskRefs),
      e.lastVerifiedAt, e.applicableScope, J.stringify(e.accessScope),
      e.dataClassification, J.stringify(e.crossProjectReusable),
      e.expiresAt, e.status, J.stringify(e.supersedes), J.stringify(e.contradicts),
      e.indexVersion, e.createdAt, e.updatedAt,
    );
  }
  /**
   * §43.3 purge support: delete every row of one scope. Returns the number
   * of rows removed. Used by the server purge endpoint alongside the
   * in-memory store purge + registry cleanup.
   */
  deleteByScopeId(scopeId: string): number {
    const r = this.db.prepare('DELETE FROM memory_entries WHERE scope_id = ?').run(scopeId);
    return Number(r.changes ?? 0);
  }
  get(id: string): MemoryEntry | undefined {
    const r = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToMemoryEntry(r) : undefined;
  }
  query(f: { scope?: string; scopeId?: string; type?: string; includeExpired?: boolean }): MemoryEntry[] {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (f.scope) { where.push('scope = ?'); params.push(f.scope); }
    if (f.scopeId) { where.push('scope_id = ?'); params.push(f.scopeId); }
    if (f.type) { where.push('type = ?'); params.push(f.type); }
    if (!f.includeExpired) { where.push("status != 'RETIRED'"); }
    const sql = `SELECT * FROM memory_entries${where.length ? ' WHERE ' + where.join(' AND ') : ''}
      ORDER BY confidence DESC, updated_at DESC`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToMemoryEntry);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n;
  }
}

// --------------------------------------------------------------- database ---
/**
 * Project lifecycle (Batch 14) — archive is a STATUS, never a deletion:
 * 'active' projects accept new facts; 'archived' projects are closed out
 * (read-only history — tasks, evidence, reports all stay put and stay
 * readable) until explicitly unarchived back to 'active'.
 */
export type ProjectStatus = 'active' | 'archived';

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  path: string;
  status: ProjectStatus;
  /** ISO timestamp of the latest archive; null while active. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListProjectsOptions {
  /** Include archived projects alongside active ones. @default false */
  includeArchived?: boolean;
  /** Exact lifecycle filter; wins over includeArchived when set. */
  status?: ProjectStatus;
}

/**
 * Batch 24 columns on the builds table (Batch 23 created it without
 * execution fields). Same in-place migration pattern: only the missing
 * columns are added. Pre-existing NOT_EXECUTED rows read back with
 * exitCode/failureReason/completedAt null — exactly the semantics they
 * always had, nothing backfilled.
 *
 * Batch 25 adds sbom_note: pre-existing rows never had SBOMs, so they
 * are backfilled with the absence note — that IS their semantics, not
 * invented history. (SQLite forbids ADD COLUMN ... NOT NULL without a
 * default on a non-empty table, so the column is added nullable and
 * backfilled in the same migration; rowToRecord also defaults null to
 * the note for readers that skip the migration.)
 */
export function migrateBuildsTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(builds)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  if (!cols.has('exit_code')) {
    db.exec(`ALTER TABLE builds ADD COLUMN exit_code INTEGER`);
  }
  if (!cols.has('failure_reason')) {
    db.exec(`ALTER TABLE builds ADD COLUMN failure_reason TEXT`);
  }
  if (!cols.has('completed_at')) {
    db.exec(`ALTER TABLE builds ADD COLUMN completed_at TEXT`);
  }
  if (!cols.has('sbom_note')) {
    db.exec(`ALTER TABLE builds ADD COLUMN sbom_note TEXT`);
    // Single-quoted literal with '' escaping — SQLite treats
    // double quotes as identifiers.
    const lit = `'${NO_SBOM_NOTE.replace(/'/g, "''")}'`;
    db.exec(`UPDATE builds SET sbom_note = ${lit} WHERE sbom_note IS NULL`);
  }
}

/**
 * Pre-Batch-14 databases lack the lifecycle columns. Same in-place
 * migration as migrateEvidenceTable: only the missing columns are added.
 * The status column carries a constant DEFAULT, so SQLite fills every
 * existing row 'active' — pre-existing projects are active by exactly
 * the semantics they always had, nothing is backfilled with an invented
 * archive stamp (archived_at stays NULL).
 */
export function migrateProjectsTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  if (!cols.has('status')) {
    db.exec(`ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!cols.has('archived_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN archived_at TEXT`);
  }
}

/**
 * §17.2 (Batch 17) column. Pre-Batch-17 databases lack
 * tasks.authorization_status. Same in-place migration as
 * migrateProjectsTable: the column is added with the constant DEFAULT
 * 'AUTHORIZED', so SQLite fills every existing row AUTHORIZED — the
 * behaviour those tasks always had (nothing gated on authorization
 * before the axis existed). No row is rewritten to a waiting state by
 * a schema upgrade; only tasks created afterwards can start as
 * DRAFT / WAITING_HUMAN_DISPATCH, by explicit caller choice.
 */
export function migrateTasksTable(db: DatabaseSync): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (cols.size === 0) return; // table missing entirely — SCHEMA creates it fresh
  if (!cols.has('authorization_status')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN authorization_status TEXT NOT NULL DEFAULT 'AUTHORIZED'`,
    );
  }
  // §17.4 (Batch 18) — the inheritance carriers. Plain nullable
  // columns with no default: existing rows read NULL = "never
  // recorded", which rowToTask surfaces as the field being absent —
  // an upgrade must not fabricate a requirement pin, a policy ceiling
  // or a budget envelope for work that never had one recorded.
  if (!cols.has('requirement_ref')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN requirement_ref TEXT`);
  }
  if (!cols.has('policy_ceiling')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN policy_ceiling TEXT`);
  }
  if (!cols.has('budget_envelope')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN budget_envelope TEXT`);
  }
  if (!cols.has('parent_relation')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN parent_relation TEXT`);
  }
}

export class FactoryDatabase {
  readonly db: DatabaseSync;
  readonly tasks: SqliteTaskStore;
  readonly evidence: SqliteEvidenceStore;
  readonly agents: SqliteAgentStore;
  readonly audit: SqliteAuditStore;
  readonly approvals: SqliteApprovalStore;
  readonly memory: SqliteMemoryStore;
  /** §28.1 (G-59) — durable step intents; runtime's StepIntentStore on SQLite. */
  readonly stepIntents: SqliteStepIntentStore;
  /**
   * §28.2 (G-59) — durable external-operation records; the OperationStore
   * a runtime OperationLedger is constructed over, so operations survive
   * restarts and the startup reconcile has something to read.
   */
  readonly operations: SqliteOperationStore;
  /**
   * §28.3 (G-59) — durable checkpoints; the CheckpointStore a runtime
   * CheckpointLog is constructed over, so a captured checkpoint (the
   * resumption contract) survives the restart it exists for.
   */
  readonly checkpoints: SqliteCheckpointStore;
  /**
   * §16 (F2) — durable requirement state; the RequirementStore a
   * RequirementManager is constructed over, so requirement versions,
   * compatibility declarations, holds and links survive restarts.
   */
  readonly requirements: SqliteRequirementStore;
  /**
   * HTTP run records (apps/server §24–§27 routes, F4) — the
   * RuntimeRunStore the server's run registry is installed over, so a
   * run's record survives the restart its step intents already did.
   */
  readonly runs: SqliteRuntimeRunStore;
  /**
   * Run manifests (Batch 15) — the RunManifestStore the server's
   * runtime route writes each run's accountability record to:
   * creation snapshot (identity, driver, grant, budget limits,
   * context hash) plus completion accounting at the terminal write.
   * Runs from before this wiring have no row and answer 404.
   */
  readonly runManifests: SqliteRunManifestStore;
  /**
   * §18/§19/§20.1 (Batch 13) — durable v2 engine state; the
   * TaskV2StateStore the server's V2TransitionService persists its
   * WorkflowEngineV2 mirror to after every committed mutation and
   * hydrates from on first access, so a restart restores the exact
   * stage/milestones/finalSeal/taskVersion instead of re-seeding
   * approximately from the v1 task row.
   */
  readonly taskV2States: SqliteTaskV2StateStore;
  /**
   * §47 (Batch 14) — retention policies + legal holds; the store the
   * server's retention routes evaluate against. Holds no deletion
   * policy of its own: no policy row = keep forever, and only the
   * explicit enforce endpoint deletes (see retention.ts docstring).
   */
  readonly retention: SqliteRetentionStore;
  /**
   * Batch 20 — backup schedules (§47): operator-configured backup
   * plans the server's in-process scheduler executes; durable so a
   * restart loses nothing (reconciled at boot).
   */
  readonly backupSchedules: SqliteBackupScheduleStore;
  /**
   * §18.2 (G-17) / §48.4 (Batch 17) — durable workflow outbox; the
   * OutboxSink the server wires into WorkflowEngineV2, so every
   * committed v2 stage change appends its event to outbox_events in
   * the same step and undispatched events survive restarts until a
   * consumer drains them (drain stamps dispatched_at, never deletes).
   */
  readonly outbox: SqliteOutboxStore;
  /**
   * §17.2 (G-09, Batch 18) — Operational pre-authorization ticket
   * registry; the ticket book the server's POLICY dispatch consumes
   * from, so a pre-authorized dispatch points at a recorded ticket
   * (policy + Rule ID + scope + consumption record) instead of a bare
   * Rule ID string. Single-use tickets, effective expiry on read.
   */
  readonly authorizationTickets: SqliteAuthorizationTicketStore;
  /**
   * §41/§77 (Batch 19) — durable deployment records: the
   * reconstructable spec for every deployment (parked jobs included),
   * so a restarted server can REBUILD a parked job from its spec
   * instead of 404ing it. Specs carry secret REFERENCE names only,
   * never values (the type has no values field).
   */
  readonly deployments: SqliteDeploymentStore;
  readonly pipelineRecords: SqlitePipelineRecordStore;
  /**
   * §22.1 (G-37, Batch 19) — worktree allocation records: one ACTIVE
   * worktree per (repo, task) at a time (partial unique index), paths
   * globally unique, RELEASED rows retained as history.
   */
  readonly worktrees: SqliteWorktreeStore;
  /**
   * §36 (Batch 20) — durable PR records: the PRs the merge queue
   * consumes were in-memory like the queue itself; a restarted server
   * must still find the PR an entry points at.
   */
  readonly prStore: SqlitePrStore;
  /**
   * §36 (Batch 20) — durable merge-queue entry backing: every queue
   * mutation is written through here the moment it happens, so
   * MergeQueue.hydrate() rebuilds the queue after a restart instead of
   * losing it. VERIFYING rows are demoted to QUEUED on hydrate (never
   * trusted); MERGED/FAILED rows are history.
   */
  readonly mergeQueueEntries: SqliteMergeQueueEntryStore;
  /**
   * §46 / §34.1 (Batch 21) — durable MCP registrations: the registry
   * and the trust assessments were process memory; a restart used to
   * send every approved server back to BLOCKED. Registrations, trust
   * level/policy, assessments and install records are all written
   * through here; health reports are stored but marked stale on
   * hydrate (never trusted as fresh).
   */
  readonly mcpServers: SqliteMcpServerStore;
  /**
   * §39.3 (Batch 32) — durable gate definitions + append-only
   * evaluation log. Verdicts are computed by the deterministic
   * evaluator in @ai-factory/core; this store never invents one.
   */
  readonly gates: SqliteGateStore;
  /**
   * §12.2 (Batch 32) — durable delegation records: one row per
   * delegation_id with the full Delegation JSON. Rows that were
   * ACTIVE when the owning process died are demoted to INTERRUPTED
   * on hydrate (honest: no supervision is held, fate UNKNOWN, never
   * auto-resumed).
   */
  readonly delegations: SqliteDelegationStore;
  /**
   * §40 (Batch 23) — build records: one row per landed merge. The
   * record is deliberately NOT a fake build — merges never run a
   * build, so status is NOT_EXECUTED and digest/definition/sbom_ref/
   * attestation_ref are null with notes explaining the absence.
   */
  readonly builds: SqliteBuildRecordStore;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // SPEC §48 — foreign keys are declared in SCHEMA but SQLite does not
    // enforce them unless this pragma is on for every connection.
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    migrateProjectsTable(this.db);
    migrateTasksTable(this.db);
    migrateApprovalsTable(this.db);
    migrateMemoryTable(this.db);
    migrateEvidenceTable(this.db);
    migrateAuditTable(this.db);
    migrateRetentionTable(this.db);
    migrateMergeQueueTable(this.db);
    migrateBuildsTable(this.db);
    migrateMcpServersTable(this.db);
    this.tasks = new SqliteTaskStore(this.db);
    this.evidence = new SqliteEvidenceStore(this.db);
    this.agents = new SqliteAgentStore(this.db);
    this.audit = new SqliteAuditStore(this.db);
    this.approvals = new SqliteApprovalStore(this.db);
    this.memory = new SqliteMemoryStore(this.db);
    this.stepIntents = new SqliteStepIntentStore(this.db);
    this.operations = new SqliteOperationStore(this.db);
    this.checkpoints = new SqliteCheckpointStore(this.db);
    this.requirements = new SqliteRequirementStore(this.db);
    this.runs = new SqliteRuntimeRunStore(this.db);
    this.runManifests = new SqliteRunManifestStore(this.db);
    this.taskV2States = new SqliteTaskV2StateStore(this.db);
    this.outbox = new SqliteOutboxStore(this.db);
    this.retention = new SqliteRetentionStore(this.db);
    this.backupSchedules = new SqliteBackupScheduleStore(this.db);
    this.authorizationTickets = new SqliteAuthorizationTicketStore(this.db);
    this.deployments = new SqliteDeploymentStore(this.db);
    this.pipelineRecords = new SqlitePipelineRecordStore(this.db);
    this.worktrees = new SqliteWorktreeStore(this.db);
    this.prStore = new SqlitePrStore(this.db);
    this.mergeQueueEntries = new SqliteMergeQueueEntryStore(
      this.db,
      // Batch 23: cross-process drain mutual exclusion — one drainer
      // per repo across processes sharing this DB file.
      new SqliteMergeQueueDrainLock(this.db),
    );
    this.mcpServers = new SqliteMcpServerStore(this.db);
    this.gates = new SqliteGateStore(this.db);
    this.delegations = new SqliteDelegationStore(this.db);
    this.builds = new SqliteBuildRecordStore(this.db);
  }

  // -- projects -------------------------------------------------------------
  createProject(
    p: Omit<ProjectRow, 'created_at' | 'updated_at' | 'status' | 'archived_at'>,
  ): ProjectRow {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO projects (id, name, description, path, status, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(p.id, p.name, p.description, p.path, 'active', null, now, now);
    return { ...p, status: 'active', archived_at: null, created_at: now, updated_at: now };
  }

  /**
   * Default listing EXCLUDES archived projects — the archive lifecycle
   * exists so closed-out projects leave the working set. Callers opt
   * back in explicitly (includeArchived, or an exact status filter).
   */
  listProjects(opts: ListProjectsOptions = {}): ProjectRow[] {
    if (opts.status) {
      return this.db
        .prepare('SELECT * FROM projects WHERE status = ? ORDER BY created_at')
        .all(opts.status) as unknown as ProjectRow[];
    }
    if (opts.includeArchived) {
      return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as ProjectRow[];
    }
    return this.db
      .prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY created_at")
      .all() as unknown as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  /**
   * Move a project through its lifecycle. Archiving stamps archived_at;
   * unarchiving clears it. Returns the updated row, or undefined when no
   * such project exists. Setting the status the project already has is
   * a no-op write that still returns the current row (callers layer
   * their own idempotency semantics on top).
   */
  setProjectStatus(id: string, status: ProjectStatus): ProjectRow | undefined {
    const now = new Date().toISOString();
    const archivedAt = status === 'archived' ? now : null;
    const r = this.db
      .prepare('UPDATE projects SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
      .run(status, archivedAt, now, id);
    if (Number(r.changes) === 0) return undefined;
    return this.getProject(id);
  }

  close(): void {
    this.db.close();
  }

  // -- backup support -------------------------------------------------------
  /**
   * Write a transactionally consistent snapshot of this database to
   * destPath via VACUUM INTO. VACUUM reads only committed state (WAL
   * included), so the snapshot is a complete standalone database file —
   * never a raw copy of a live file mid-write. destPath must NOT exist
   * yet (SQLite refuses to overwrite, and so do we: a backup target is
   * always a fresh path).
   */
  snapshotTo(destPath: string): void {
    if (existsSync(destPath)) {
      throw new Error(`snapshot target already exists: ${destPath}`);
    }
    const escaped = destPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  /** Row counts for every user table (sqlite internals excluded). */
  tableCounts(): Record<string, number> {
    const tables = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`)
        .get() as { n: number };
      counts[name] = Number(row.n);
    }
    return counts;
  }
}
