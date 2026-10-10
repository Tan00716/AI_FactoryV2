/**
 * SQLite DDL for the memory engine (SPEC v2 §43.2) — paste into
 * `packages/db/src/schema.ts`.
 *
 * Conventions mirror the db package: TEXT primary key, TEXT columns,
 * JSON-in-TEXT for arrays (`evidence_ids` holds a JSON string array),
 * ISO-8601 TEXT timestamps, and a plain index on the hot query path
 * (scope + scope_id).
 *
 * Row-mapping notes for the coordinator:
 *  - `evidence_ids` / `source_refs` / `task_refs` / `access_scope` /
 *    `supersedes` / `contradicts`  TEXT  <->  string[]   (JSON.parse / JSON.stringify)
 *  - `cross_project_reusable`       TEXT  <->  CrossProjectReusable (JSON)
 *  - `expires_at`    TEXT|null  <->  string | null  (NULL = never expires)
 *  - `confidence`    REAL  <->  number              (0..1, the confidence_value)
 *  - `scope`, `type`, `status`, `data_classification`, `confidence_kind`
 *    are TEXT holding the union values verbatim.
 *  - `last_verified_at` doubles as the decay-clock anchor: the store
 *    advances it when applying the half-TTL −0.2 decay, so the decay is a
 *    one-time event per half-TTL window and needs no extra column.
 *  - `id` uses the `mem_<uuid>` format from MemoryStore.write; any unique
 *    TEXT id works for rows written directly in SQL.
 */
export const MEMORY_SCHEMA = `
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
`;
