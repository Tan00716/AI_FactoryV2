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
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TEXT,
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
  authorization_status TEXT NOT NULL DEFAULT 'AUTHORIZED',
  requirement_ref TEXT,
  policy_ceiling TEXT,
  budget_envelope TEXT,
  parent_relation TEXT,
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

-- SPEC v2 §28.2 (G-59): external operation ledger — PREPARED →
-- DISPATCHED → CONFIRMED_SUCCEEDED | CONFIRMED_FAILED | UNKNOWN.
-- Timestamps are epoch milliseconds (the runtime ExternalOperation
-- shape), not ISO text. Optional lifecycle fields stay NULL until the
-- state machine sets them; read-back keeps unset fields ABSENT.
-- Rows a dead process left non-terminal are the startup reconcile's
-- input (§28.2): classified at boot, never blindly replayed.
-- New table: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS external_operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  logical_action TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  environment TEXT NOT NULL,
  state TEXT NOT NULL,
  reversible INTEGER NOT NULL DEFAULT 0,
  prepared_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  confirmed_at INTEGER,
  ledger_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_external_operations_state
  ON external_operations (state);

-- SPEC v2 §28.3 (G-59): checkpoints — the resumption contract for a
-- run at a step position (§28.3 field set; structured data, not a chat
-- tail). Identity is (run_id, step_position): a re-capture at the same
-- position replaces the earlier capture. captured_at is epoch
-- milliseconds (the runtime CheckpointV2 shape). Optional fields stay
-- NULL until a capture sets them; read-back keeps unset fields ABSENT.
-- Composite fields (tool/process/approval lists, the budget-usage
-- record) are JSON text — lossless for string[] / number[] /
-- Record<string, number>.
-- New table: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL,
  step_position INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  task_version TEXT NOT NULL,
  context_manifest_hash TEXT NOT NULL,
  model_session_ref TEXT,
  workspace_snapshot_hash TEXT,
  git_base TEXT,
  git_candidate TEXT,
  active_tools TEXT NOT NULL,
  active_processes TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  fencing_token INTEGER NOT NULL,
  pending_approvals TEXT NOT NULL,
  budget_usage TEXT NOT NULL,
  pending_side_effects TEXT NOT NULL,
  resume_preconditions TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_position)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints (run_id);

-- SPEC v2 §16 (F2): requirements — the RequirementManager's durable
-- state. The manager used to be a process-wide in-memory singleton, so
-- a restart lost requirement versions and §16 compatibility
-- declarations (evidence pinned to a requirement version then failed
-- registration, and tasks caught mid-STALE-gate were stuck). The
-- tables below back the requirements package's RequirementStore seam:
--   requirements          — one row per requirement (id/status/created)
--   requirement_versions  — (above, §48.3) one immutable payload per
--                           version; payload is the RequirementVersion
--                           JSON, written once and never updated
--   requirement_links     — entity links per (requirement, version)
--   promotion_holds       — §16 G-05 holds, released ones included
--   evidence_compatibility — §16 compatibility declarations, append-only
--   requirement_store_meta — manager bookkeeping (the auto-id sequence)
-- Composite records are JSON text — lossless for these shapes, and
-- every read is a fresh parse, so the store's copy contract holds
-- structurally.
-- New tables: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirement_links (
  requirement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (requirement_id, version)
);
CREATE TABLE IF NOT EXISTS promotion_holds (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  requirement_version INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotion_holds_task ON promotion_holds (task_id);
CREATE TABLE IF NOT EXISTS evidence_compatibility (
  evidence_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  requirement_version INTEGER NOT NULL,
  compatible INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirement_store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- HTTP run records (apps/server §24–§27 routes, F4): the record a POST
-- /api/runtime/runs creates and GET /api/runtime/runs/:id returns. It
-- used to be a process-local Map, so a restart lost the record even
-- though its step intents and evidence side effects were durable. One
-- row per run, upserted at creation, on every evidence append, and at
-- the terminal write — a crashed process leaves its last persisted
-- state (possibly still RUNNING: the record of an interrupted run, not
-- a claim it finished). evidence / handoffs / trace are JSON text —
-- lossless for the plain-data entries the harness and loop produce.
-- Nullable columns (outcome, finished_at, error) stay NULL until the
-- run sets them; read-back keeps them null. created_at / finished_at
-- keep the record's ISO-string shape (TEXT, not epoch).
-- New table: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS runtime_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  steps INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  handoffs TEXT NOT NULL,
  trace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

-- Run manifests (Batch 15): the accountability record of one HTTP
-- run — one row per run, written at creation with the identity /
-- driver / grant / budget-limit snapshot and the context-manifest
-- hash (assembled exactly as the §28.3 checkpoint capture assembles
-- it), then replaced once at the run's terminal/error write with
-- the completion accounting (outcome, effective model, budget
-- usage, step intents bucketed by status, evidence count/types,
-- checkpoint step range). A run a dead process left mid-flight
-- keeps its creation snapshot: status RUNNING, completion columns
-- NULL — never retroactively finalized. Runs created before this
-- table existed have NO row: their manifest query answers 404
-- rather than fabricating a backfill. Composite blocks (driver,
-- granted tools, budget limits/usage, intents, evidence,
-- checkpoints) are JSON text — lossless for these plain shapes,
-- and NULL until finalization where the block is a completion
-- fact. created_at / finished_at keep the run record's ISO-string
-- shape (TEXT, not epoch).
-- New table: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS run_manifests (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  driver TEXT NOT NULL,
  granted_tools TEXT NOT NULL,
  budget_limits TEXT NOT NULL,
  context_manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  finished_at TEXT,
  error TEXT,
  steps INTEGER,
  model TEXT,
  model_source TEXT,
  budget_usage TEXT,
  intents TEXT,
  evidence TEXT,
  checkpoints TEXT
);

-- SPEC v2 §18/§19/§20.1 (Batch 13): task v2 engine state — the
-- WorkflowEngineV2 mirror (core's TaskV2State) itself. Until now the
-- mirror lived only in the server process: on restart the v2 service
-- re-seeded it approximately from the v1 task row (stage mapped from
-- the v1 status, condition guessed from exception statuses), and
-- everything the row cannot express was lost — recorded milestones,
-- milestone/release/completion histories, the outcome-gate validity
-- flag, the optimistic-concurrency taskVersion, and the §20.1 final
-- seal (a finalized task came back with finalSeal 0: walkthrough F1
-- residual). One row per task, upserted by the v2 transition service
-- after every engine-committed mutation and hydrated verbatim on
-- first access; only a task with NO row here still takes the legacy
-- approximate seed (and is then persisted immediately).
-- Every TaskV2State field is plain data — there are no live handles
-- to exclude. Composite fields (the §18.3 condition record, the §19
-- milestone map, the three history arrays) are JSON text, lossless
-- for these shapes, and every read is a fresh parse. The two flags
-- are 0/1 integers; requirement_ref stays NULL when the task carries
-- no requirement pin (read back as null, never invented).
-- New table: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS task_v2_state (
  task_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  condition TEXT NOT NULL,
  milestones TEXT NOT NULL,
  milestone_history TEXT NOT NULL,
  release_state TEXT NOT NULL,
  release_history TEXT NOT NULL,
  outcome_gate_valid INTEGER NOT NULL,
  final_seal INTEGER NOT NULL,
  task_version INTEGER NOT NULL,
  requirement_ref TEXT,
  completion_target TEXT NOT NULL,
  completion_history TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- SPEC v2 §47 (Batch 14): retention policies + legal holds. §47 names
-- the platform table retention_policies (§48 table list) and requires
-- configurable retention periods and Legal Hold per data category.
-- A MISSING policy row — or retention_days NULL/0 — means KEEP FOREVER:
-- retention never deletes by default, and nothing is enforced until a
-- policy exists AND an operator explicitly calls the enforce endpoint.
-- legal_holds: an active hold (released_at NULL) exempts its scope
-- from ALL retention deletion — scope GLOBAL covers everything, scope
-- PROJECT covers every record resolvable to that project. Released
-- holds stay as rows: the hold/release history is itself audit-grade
-- bookkeeping (the endpoints also write audit records).
-- New tables: CREATE TABLE IF NOT EXISTS covers old databases on open.
CREATE TABLE IF NOT EXISTS retention_policies (
  category TEXT PRIMARY KEY,
  retention_days INTEGER,
  -- Batch 20: keep newest N backups regardless of age (only the
  -- 'backups' category evaluates this column; NULL = no count limit).
  keep_count INTEGER,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_legal_holds_active
  ON legal_holds (released_at);
-- Backup schedules (Batch 20): operator-configured backup plans the
-- server's in-process scheduler executes. schedule_kind is 'interval'
-- (interval_ms, floor 60s) or 'cron' (5-field cron_expr, minute/hour/
-- day-of-month/month/day-of-week). next_run_at is the next planned
-- execution in ISO time; the scheduler advances it after every run and
-- marks missed executions MISSED on boot (no backfill).
CREATE TABLE IF NOT EXISTS backup_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schedule_kind TEXT NOT NULL,
  interval_ms INTEGER,
  cron_expr TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
-- Retention tombstones (Batch 15): when retention enforcement deletes
-- a runtime_runs row, the run → project resolution its leftover step
-- intents / checkpoints relied on disappears with it, and §47 would
-- exempt them forever as unknown references. The tombstone is the
-- deletion-time memory of that mapping: run_id → project_id, plus
-- when and why. It stores NO record content (no payloads, no args),
-- is written ONLY by the retention deletion path, and never expires
-- on its own — expiry would recreate the orphan problem it solves.
CREATE TABLE IF NOT EXISTS retention_tombstones (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'retention'
);

-- New table: CREATE TABLE IF NOT EXISTS covers old databases on open.
-- §17.2 (G-09, Batch 18) — Operational pre-authorization ticket
-- registry. A ticket is the recorded pre-authorization a POLICY
-- Worktree allocation records — §22.1 (G-37, Batch 19). One writable
-- workspace per task: at most one ACTIVE allocation per (repo, task),
-- enforced by the partial unique index below (RELEASED rows keep
-- history). worktree_path is globally unique so a leaked path can
-- never be silently reassigned. kind is 'git-worktree' (real
-- git worktree add) or 'dir-copy' (non-Git source, §22.1's
-- snapshot/working-copy clause — an honest, labeled downgrade).
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  branch TEXT,
  worktree_path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'git-worktree',
  task_id TEXT NOT NULL,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  released_at TEXT,
  release_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_active_task
  ON worktrees(repo_path, task_id) WHERE status = 'ACTIVE';

-- dispatch consumes: it names the triggering policy + Rule ID (the
-- spec's requirement), the scope it covers (project / task priorities
-- / actions), its issuer and validity window, and — once consumed —
-- the consumption record. Tickets are single-use: consumption moves
-- ACTIVE → USED and appends to the consumptions list. scope and
-- consumptions are JSON text (the lossless record), the columns are
-- the indexable projection — the same mapping style as outbox_events.
CREATE TABLE IF NOT EXISTS authorization_tickets (
  id TEXT PRIMARY KEY,
  policy_rule_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  issued_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  revoked_by TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  consumptions TEXT NOT NULL DEFAULT '[]'
);

-- Deployments (Batch 19): durable deployment records (§41/§77).
-- The spec_json column is the RECONSTRUCTABLE spec (environment,
-- rollback method, §41 approval descriptor + policy snapshot, §77
-- snapshot id/label/data, task binding, actor, secret REFERENCE
-- names only — the DeploymentSpec type has no values field, so no
-- secret value can ever be stored here by construction).
CREATE TABLE IF NOT EXISTS deployments (
  id            TEXT PRIMARY KEY,
  pipeline_id   TEXT NOT NULL,
  task_id       TEXT,
  project_id    TEXT,
  environment   TEXT NOT NULL,
  status        TEXT NOT NULL,
  spec_json     TEXT NOT NULL,
  approval_id   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  ended_at      TEXT,
  error         TEXT,
  rehydrated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployments_pipeline ON deployments (pipeline_id);

-- Merge Queue + PR persistence — §36 (Batch 20). The queue in
-- @ai-factory/git is operational in memory but writes every mutation
-- through here the moment it happens; hydrate() rebuilds it after a
-- restart. VERIFYING rows come back QUEUED (re-verified, never trusted);
-- MERGED/FAILED rows are history. One PR may hold at most one ACTIVE
-- (QUEUED/VERIFYING) entry — the partial unique index below makes
-- cross-process double-enqueue impossible even when two processes
-- race past the queue's in-memory check.
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN',
  commits TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  merged_at TEXT
);
CREATE TABLE IF NOT EXISTS merge_queue_entries (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  pr_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  position INTEGER NOT NULL,
  enqueued_by TEXT NOT NULL DEFAULT '',
  enqueued_at TEXT NOT NULL,
  processed_at TEXT,
  base_sha TEXT,
  candidate_sha TEXT,
  candidate_tree_oid TEXT,
  target_sha TEXT,
  diff_hash TEXT,
  artifact_digest TEXT,
  verification TEXT,
  failure_reason TEXT,
  merge_commit_sha TEXT,
  decision_audit_ref TEXT,
  claimed_by TEXT,
  claimed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS merge_queue_active_pr
  ON merge_queue_entries(pr_id) WHERE status IN ('QUEUED','VERIFYING');
CREATE INDEX IF NOT EXISTS idx_merge_queue_repo
  ON merge_queue_entries(repo_path, position);

-- Cross-process drain mutual exclusion (Batch 23). One lease row per
-- repo: the drainer holding it refreshes heartbeat_at at every drain
-- progress point; a contender whose heartbeat is older than the
-- queue's drainLockTtlMs may take the lock over (audited takeover).
-- A live heartbeat means "hands off" — contenders yield loudly.
CREATE TABLE IF NOT EXISTS merge_queue_drain_locks (
  repo_path TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

-- Build records (§40, Batch 23). Step one of the "minimal build-record
-- loop": one row per landed merge. The record is deliberately NOT a
-- fake build — merges never run a build, so status is NOT_EXECUTED and
-- digest/definition/sbom_ref/attestation_ref are null, each with a
-- *_note explaining the absence. The nulls record absence, not
-- placeholders; a future real build executor extends the status union
-- and fills the digest on the same row shape.
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  target_sha TEXT,
  base_sha TEXT,
  diff_hash TEXT,
  repo_path TEXT NOT NULL,
  pr_id TEXT NOT NULL,
  task_id TEXT,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOT_EXECUTED',
  digest TEXT,
  digest_note TEXT NOT NULL,
  definition_json TEXT,
  definition_note TEXT NOT NULL,
  sbom_ref TEXT,
  attestation_ref TEXT,
  built_by TEXT NOT NULL DEFAULT '',
  built_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builds_pr
  ON builds(pr_id);
CREATE INDEX IF NOT EXISTS idx_builds_revision
  ON builds(revision);

-- Durable MCP registry (§46, §34.1, Batch 21). Registrations and trust
-- were process memory until now: a restart sent every approved server
-- back to BLOCKED. One row per (name, version); the full McpServer
-- record travels as JSON (lossless), the columns are the indexable
-- projection. assessment_json holds the TrustAssessment (assessedAt /
-- assessedBy / notes); trust_level / approval_policy mirror the
-- record's live fields for cheap queries. health_stale marks a health
-- report that belongs to a dead process: hydration does NOT load it
-- into the live registry (a restart must not pretend a fresh health
-- check happened); the next recordHealth overwrites with health_stale=0.
-- credentialRefs are names only; the server layer strips any smuggled
-- runtimePolicy.stdioEnvFixed VALUES before the row is written, so
-- secret values structurally cannot reach disk through this table.
CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'UNKNOWN',
  approval_policy TEXT NOT NULL DEFAULT 'BLOCKED',
  health_stale INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL,
  assessment_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_trust
  ON mcp_servers(trust_level, approval_policy);

-- Install records for the same (name, version) keyspace. Status is the
-- InstallStatus enum text; uninstall deletes the row (history lives on
-- the server row's append-only history, never here).
CREATE TABLE IF NOT EXISTS mcp_installs (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  installed_at TEXT,
  scope_enabled_json TEXT NOT NULL DEFAULT '{}',
  last_used_version TEXT,
  PRIMARY KEY (name, version)
);
`;
