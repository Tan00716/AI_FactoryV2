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
  sealed_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  action TEXT NOT NULL,
  requested_by TEXT DEFAULT '',
  agent_id TEXT DEFAULT '',
  risk_level TEXT DEFAULT 'MEDIUM',
  evidence_ids TEXT DEFAULT '[]',
  required_approver TEXT DEFAULT 'human',
  status TEXT DEFAULT 'PENDING',
  decision TEXT DEFAULT '',
  decided_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
`;
