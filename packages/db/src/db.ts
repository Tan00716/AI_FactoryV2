/**
 * SQLite-backed persistence for the core domain stores.
 * Implements the store interfaces from @ai-factory/core on top of
 * node:sqlite (DatabaseSync). JSON columns are (de)serialized here so the
 * domain layer keeps working with plain objects.
 */

import { DatabaseSync } from 'node:sqlite';
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
import type { MemoryEntry } from '@ai-factory/memory';
import { SCHEMA } from './schema';

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
        status, current_agent_id, assigned_agents, subtask_ids, dependencies,
        risk, created_at, updated_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
        parent_task_id=excluded.parent_task_id, title=excluded.title, goal=excluded.goal,
        description=excluded.description, priority=excluded.priority, severity=excluded.severity,
        acceptance_criteria=excluded.acceptance_criteria, constraints=excluded.constraints,
        workspace=excluded.workspace, creator=excluded.creator, status=excluded.status,
        current_agent_id=excluded.current_agent_id, assigned_agents=excluded.assigned_agents,
        subtask_ids=excluded.subtask_ids, dependencies=excluded.dependencies,
        risk=excluded.risk, updated_at=excluded.updated_at, completed_at=excluded.completed_at`,
    ).run(
      t.id, t.projectId, t.parentTaskId, t.title, t.goal, t.description,
      t.priority, t.severity, J.stringify(t.acceptanceCriteria), J.stringify(t.constraints),
      t.workspace, t.creator, t.status, t.currentAgentId, J.stringify(t.assignedAgentIds),
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
  };
}

export class SqliteEvidenceStore implements EvidenceStore {
  constructor(private db: DatabaseSync) {}
  save(ev: Evidence): void {
    this.db.prepare(
      `INSERT INTO evidence (id, task_id, type, title, payload, status, created_by, created_at, sealed_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, payload=excluded.payload,
        status=excluded.status, sealed_at=excluded.sealed_at`,
    ).run(ev.id, ev.taskId, ev.type, ev.title, J.stringify(ev.payload), ev.status, ev.createdBy, ev.createdAt, ev.sealedAt);
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
 * Spec §69 columns added after the approvals table first shipped
 * (agent_id, required_approver, evidence_ids, expires_at). Existing local
 * DBs are migrated in place: only missing columns are added.
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
  add(`agent_id TEXT DEFAULT ''`, 'agent_id');
  add(`required_approver TEXT DEFAULT 'human'`, 'required_approver');
  add(`evidence_ids TEXT DEFAULT '[]'`, 'evidence_ids');
  add(`expires_at TEXT`, 'expires_at');
  db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id)');
}

function rowToApproval(r: Record<string, unknown>): Approval {
  const s = (k: string) => r[k] as string;
  return {
    id: s('id'),
    action: s('action'),
    requestedBy: s('requested_by') ?? '',
    agentId: s('agent_id') ?? '',
    taskId: s('task_id') ?? '',
    riskLevel: (s('risk_level') ?? 'MEDIUM') as Approval['riskLevel'],
    evidenceIds: J.parse<string[]>(r['evidence_ids'] as string, []),
    requiredApprover: s('required_approver') ?? 'human',
    status: (s('status') ?? 'PENDING') as Approval['status'],
    decision: (s('decision') ?? '') as Approval['decision'],
    decidedBy: s('decided_by') ?? '',
    createdAt: s('created_at'),
    decidedAt: (r['decided_at'] as string) ?? null,
    expiresAt: (r['expires_at'] as string) ?? null,
  };
}

export class SqliteApprovalStore implements ApprovalStore {
  constructor(private db: DatabaseSync) {}
  save(a: Approval): void {
    this.db.prepare(
      `INSERT INTO approvals (id, task_id, action, requested_by, agent_id, risk_level,
        evidence_ids, required_approver, status, decision, decided_by,
        created_at, decided_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, action=excluded.action,
        requested_by=excluded.requested_by, agent_id=excluded.agent_id,
        risk_level=excluded.risk_level, evidence_ids=excluded.evidence_ids,
        required_approver=excluded.required_approver, status=excluded.status,
        decision=excluded.decision, decided_by=excluded.decided_by,
        decided_at=excluded.decided_at, expires_at=excluded.expires_at`,
    ).run(
      a.id, a.taskId, a.action, a.requestedBy, a.agentId, a.riskLevel,
      J.stringify(a.evidenceIds), a.requiredApprover, a.status, a.decision,
      a.decidedBy, a.createdAt, a.decidedAt, a.expiresAt,
    );
  }
  get(id: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
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
export class SqliteAuditStore implements AuditStore {
  constructor(private db: DatabaseSync) {}
  append(r: AuditRecord): void {
    this.db.prepare(
      `INSERT INTO audit_logs (id, ts, actor, action, entity_type, entity_id, details)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(r.id, r.ts, r.actor, r.action, r.entityType, r.entityId, J.stringify(r.details));
  }
  list(): AuditRecord[] {
    return (this.db.prepare('SELECT * FROM audit_logs ORDER BY ts').all() as Record<string, unknown>[]).map(
      (r) => ({
        id: r['id'] as string,
        ts: r['ts'] as string,
        actor: r['actor'] as string,
        action: r['action'] as string,
        entityType: r['entity_type'] as string,
        entityId: r['entity_id'] as string,
        details: J.parse<Record<string, unknown>>(r['details'] as string, {}),
      }),
    );
  }
}

// ---------------------------------------------------------------- memory ---
// Structured memory entries (spec §54–§56). The lifecycle logic (dedup,
// decay, verify) lives in @ai-factory/memory's MemoryStore; this store is
// the durable SQL backing with the same row mapping.
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
    confidence: Number(r['confidence'] ?? 0),
    createdBy: s('created_by'),
    evidenceIds: J.parse<string[]>(r['evidence_ids'] as string, []),
    lastVerifiedAt: s('last_verified_at'),
    applicableScope: s('applicable_scope'),
    expiresAt: (r['expires_at'] as string) ?? null,
    status: s('status') as MemoryEntry['status'],
    createdAt: s('created_at'),
    updatedAt: s('updated_at'),
  };
}

export class SqliteMemoryStore {
  constructor(private db: DatabaseSync) {}
  upsert(e: MemoryEntry): void {
    this.db.prepare(
      `INSERT INTO memory_entries
         (id, scope, scope_id, type, title, content, source, confidence,
          created_by, evidence_ids, last_verified_at, applicable_scope,
          expires_at, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, content=excluded.content, source=excluded.source,
         confidence=excluded.confidence, evidence_ids=excluded.evidence_ids,
         last_verified_at=excluded.last_verified_at,
         applicable_scope=excluded.applicable_scope, expires_at=excluded.expires_at,
         status=excluded.status, updated_at=excluded.updated_at`,
    ).run(
      e.id, e.scope, e.scopeId, e.type, e.title, e.content, e.source, e.confidence,
      e.createdBy, J.stringify(e.evidenceIds), e.lastVerifiedAt, e.applicableScope,
      e.expiresAt, e.status, e.createdAt, e.updatedAt,
    );
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
    if (!f.includeExpired) { where.push("status != 'EXPIRED'"); }
    const sql = `SELECT * FROM memory_entries${where.length ? ' WHERE ' + where.join(' AND ') : ''}
      ORDER BY confidence DESC, updated_at DESC`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToMemoryEntry);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n;
  }
}

// --------------------------------------------------------------- database ---
export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  path: string;
  created_at: string;
  updated_at: string;
}

export class FactoryDatabase {
  readonly db: DatabaseSync;
  readonly tasks: SqliteTaskStore;
  readonly evidence: SqliteEvidenceStore;
  readonly agents: SqliteAgentStore;
  readonly audit: SqliteAuditStore;
  readonly approvals: SqliteApprovalStore;
  readonly memory: SqliteMemoryStore;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    migrateApprovalsTable(this.db);
    this.tasks = new SqliteTaskStore(this.db);
    this.evidence = new SqliteEvidenceStore(this.db);
    this.agents = new SqliteAgentStore(this.db);
    this.audit = new SqliteAuditStore(this.db);
    this.approvals = new SqliteApprovalStore(this.db);
    this.memory = new SqliteMemoryStore(this.db);
  }

  // -- projects -------------------------------------------------------------
  createProject(p: Omit<ProjectRow, 'created_at' | 'updated_at'>): ProjectRow {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO projects (id, name, description, path, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run(p.id, p.name, p.description, p.path, now, now);
    return { ...p, created_at: now, updated_at: now };
  }

  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}
