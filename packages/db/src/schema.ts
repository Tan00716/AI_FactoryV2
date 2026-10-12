/**
 * SQLite schema — spec §100 (core entities, local-first).
 * Uses the built-in node:sqlite (DatabaseSync); no native addons required.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  path TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  department TEXT DEFAULT 'Engineering',
  parent_agent_id TEXT REFERENCES agents(id),
  mission TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  skills TEXT DEFAULT '[]',
  rules TEXT DEFAULT '[]',
  model TEXT DEFAULT 'default',
  reasoning_level TEXT DEFAULT 'MEDIUM',
  tools TEXT DEFAULT '[]',
  permissions TEXT DEFAULT '[]',
  autonomy_level INTEGER DEFAULT 2,
  status TEXT DEFAULT 'IDLE',
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  goal TEXT DEFAULT '',
  description TEXT DEFAULT '',
  priority TEXT DEFAULT 'P2',
  severity TEXT DEFAULT 'MAJOR',
  acceptance_criteria TEXT DEFAULT '[]',
  constraints TEXT DEFAULT '[]',
  workspace TEXT DEFAULT '',
  creator TEXT DEFAULT 'human',
  status TEXT DEFAULT 'TODO',
  current_agent_id TEXT REFERENCES agents(id),
  assigned_agents TEXT DEFAULT '[]',
  subtask_ids TEXT DEFAULT '[]',
  dependencies TEXT DEFAULT '[]',
  risk TEXT DEFAULT 'MEDIUM',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  definition TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT REFERENCES agents(id),
  model TEXT DEFAULT '',
  status TEXT DEFAULT 'RUNNING',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_ref TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'DRAFT',
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  sealed_at TEXT,
  -- §16/§18.2 (Batch 8): requirement pin ref ('REQ-001@1') the evidence
  -- was collected against; NULL = never recorded. Older databases gain
  -- this column via migrateEvidenceTable in db.ts.
  requirement_version TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  action TEXT NOT NULL,
  action_digest TEXT DEFAULT '',
  requester TEXT DEFAULT '',
  risk_level TEXT DEFAULT 'MEDIUM',
  reversibility_ref TEXT DEFAULT '',
  requirement_version TEXT DEFAULT '',
  candidate_digest TEXT DEFAULT '',
  environment TEXT DEFAULT '',
  evidence_manifest_hash TEXT DEFAULT '',
  policy_version TEXT DEFAULT '',
  required_approvers TEXT DEFAULT '["human"]',
  status TEXT DEFAULT 'PENDING',
  decision TEXT DEFAULT '',
  decision_reason TEXT DEFAULT '',
  decided_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  deadline TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT DEFAULT '{}',
  reason TEXT,
  result TEXT,
  summary_hash TEXT,
  prev_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);

-- Structured memory engine (SPEC v2 §43.2). Row mapping notes live in
-- packages/memory/src/sql.ts (MEMORY_SCHEMA); this is the same DDL.
-- Older databases are migrated in place by migrateMemoryTable in db.ts.
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  source TEXT DEFAULT '',
  source_refs TEXT DEFAULT '[]',
  confidence REAL DEFAULT 0,
  confidence_kind TEXT DEFAULT 'model-self-assessed',
  created_by TEXT DEFAULT '',
  evidence_ids TEXT DEFAULT '[]',
  task_refs TEXT DEFAULT '[]',
  last_verified_at TEXT NOT NULL,
  applicable_scope TEXT DEFAULT '',
  access_scope TEXT DEFAULT '[]',
  data_classification TEXT DEFAULT 'internal',
  cross_project_reusable TEXT DEFAULT '{"allowed":false}',
  expires_at TEXT,
  status TEXT DEFAULT 'ACTIVE',
  supersedes TEXT DEFAULT '[]',
  contradicts TEXT DEFAULT '[]',
  index_version TEXT DEFAULT 'v1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
  ON memory_entries (scope, scope_id);

-- SPEC v2 §48.3: requirement (id, version) uniqueness; versions are immutable.
CREATE TABLE IF NOT EXISTS requirement_versions (
  requirement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (requirement_id, version)
);

-- SPEC v2 §21.4 / §48.3: budget reservations; settlement idempotency is
-- enforced by (reservation_id) primary key + state machine in code.
CREATE TABLE IF NOT EXISTS budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'RESERVED',
  created_at TEXT NOT NULL,
  settled_at TEXT
);

-- SPEC v2 §48.4: durable outbox — key state changes commit with their
-- outbox events in one transaction.
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_undispatched
  ON outbox_events (dispatched_at);

-- SPEC v2 §28.1 (G-59): step intents — persisted BEFORE tool execution,
-- result committed after. Rows left in PENDING by a dead process are the
-- startup scan's input (§28.3): they are reported, never auto-replayed.
-- New table: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS step_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  capability_ref TEXT,
  persisted_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  result_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_step_intents_run ON step_intents (run_id);
CREATE INDEX IF NOT EXISTS idx_step_intents_status ON step_intents (status);
`;
