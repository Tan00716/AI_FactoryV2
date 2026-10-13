/**
 * Versioned org-graph snapshot history — SPEC v2 §9.4 (Batch 35).
 *
 * §9.4: "图变更为事务和版本…删除/退休使用引用保留与 tombstone，
 * 历史 Run 继续能解析当时的组织版本。" Until Batch 35 the only
 * versioned history was `OrgGraphV2`'s in-memory `Snapshot[]` — a
 * run-local query convenience, rebuilt per request and lost on
 * restart (Batch 34 persisted only the CURRENT graph). This file is
 * the record layer: `org_version_snapshots` — one append-only row per
 * persisted graph mutation. Every row carries the full graph (nodes +
 * edges) as of that version, so a historical run can resolve the org
 * exactly as it was — the durable equivalent of
 * `OrgGraphV2.resolveAt(version)`.
 *
 * Record semantics (pinned by tests):
 *  - append-only: there is no update or delete API. graph_version is a
 *    per-database monotonic counter (first row = 1), assigned inside a
 *    single BEGIN IMMEDIATE…COMMIT transaction; UNIQUE(graph_version)
 *    arbitrates concurrent writers (bounded retry — Batch 26 pattern).
 *  - GENESIS: the first-ever row may snapshot the real current state
 *    of an older database (change = 'GENESIS') — it records what is
 *    there, it never invents rows.
 *  - copy contract: every read returns a fresh deep copy.
 *  - corrupt rows fail loudly: graph_json that is not JSON throws
 *    rather than guessing (Batch 31口径).
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type OrgGraphChange = 'GENESIS' | 'NODE_ADDED' | 'EDGE_ADDED' | 'EDGE_REMOVED';

export interface OrgSnapshotRecord {
  snapshotId: string;
  /** Per-database monotonic version; the first snapshot ever is 1. */
  graphVersion: number;
  change: OrgGraphChange;
  nodeId: string | null;
  edgeId: string | null;
  /** Caller-asserted actor (HUMAN/AI/SERVICE), same honesty as the authority registry. */
  actor: string;
  createdAt: string;
  /** JSON of { nodes: [...], edges: [...] } — the full graph as of this version. */
  graphJson: string;
}

export interface OrgVersionSnapshotStore {
  append(
    input: {
      change: OrgGraphChange;
      nodeId?: string | null;
      edgeId?: string | null;
      actor: string;
      graphJson: string;
    },
    opts?: { snapshotId?: string; now?: () => string },
  ): OrgSnapshotRecord;
  get(snapshotId: string): OrgSnapshotRecord | undefined;
  /** Newest first (graph_version descending). */
  list(): OrgSnapshotRecord[];
  /** Snapshot ids newest-first — never parses graph_json, so it never
   *  throws on corrupt rows. Used by readers that skip bad rows loudly. */
  listSnapshotIds(): string[];
  maxVersion(): number;
}

const copy = <T>(v: T): T => structuredClone(v);

const CHANGES: readonly string[] = ['GENESIS', 'NODE_ADDED', 'EDGE_ADDED', 'EDGE_REMOVED'];

function checkParsedGraph(rec: OrgSnapshotRecord): OrgSnapshotRecord {
  // Fail loudly on corrupt rows — never guess at the historical graph.
  JSON.parse(rec.graphJson);
  return rec;
}

/** In-memory implementation: the behavior reference. */
export class InMemoryOrgVersionSnapshotStore implements OrgVersionSnapshotStore {
  private readonly rows = new Map<string, OrgSnapshotRecord>();
  private version = 0;

  append(
    input: {
      change: OrgGraphChange;
      nodeId?: string | null;
      edgeId?: string | null;
      actor: string;
      graphJson: string;
    },
    opts?: { snapshotId?: string; now?: () => string },
  ): OrgSnapshotRecord {
    if (!CHANGES.includes(input.change)) throw new Error(`unknown change ${input.change}`);
    if (typeof input.actor !== 'string' || !input.actor.trim()) throw new Error('actor is required');
    if (typeof input.graphJson !== 'string') throw new Error('graphJson must be a string');
    const rec: OrgSnapshotRecord = {
      snapshotId: opts?.snapshotId ?? `orgsnap-${randomUUID()}`,
      graphVersion: ++this.version,
      change: input.change,
      nodeId: input.nodeId ?? null,
      edgeId: input.edgeId ?? null,
      actor: input.actor,
      createdAt: opts?.now ? opts.now() : new Date().toISOString(),
      graphJson: input.graphJson,
    };
    if (this.rows.has(rec.snapshotId)) throw new Error(`snapshot ${rec.snapshotId} already exists`);
    this.rows.set(rec.snapshotId, copy(rec));
    return copy(rec);
  }

  get(snapshotId: string): OrgSnapshotRecord | undefined {
    const r = this.rows.get(snapshotId);
    return r === undefined ? undefined : checkParsedGraph(copy(r));
  }

  list(): OrgSnapshotRecord[] {
    return [...this.rows.values()].sort((a, b) => b.graphVersion - a.graphVersion).map((r) => checkParsedGraph(copy(r)));
  }

  listSnapshotIds(): string[] {
    return [...this.rows.values()]
      .sort((a, b) => b.graphVersion - a.graphVersion)
      .map((r) => r.snapshotId);
  }

  maxVersion(): number {
    return this.version;
  }
}

/** SQLite implementation over node:sqlite. */
export class SqliteOrgVersionSnapshotStore implements OrgVersionSnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  private rowToRec(row: Record<string, unknown>): OrgSnapshotRecord {
    return {
      snapshotId: String(row['snapshot_id']),
      graphVersion: Number(row['graph_version']),
      change: String(row['change']) as OrgGraphChange,
      nodeId: row['node_id'] === null ? null : String(row['node_id']),
      edgeId: row['edge_id'] === null ? null : String(row['edge_id']),
      actor: String(row['actor']),
      createdAt: String(row['created_at']),
      graphJson: String(row['graph_json']),
    };
  }

  append(
    input: {
      change: OrgGraphChange;
      nodeId?: string | null;
      edgeId?: string | null;
      actor: string;
      graphJson: string;
    },
    opts?: { snapshotId?: string; now?: () => string },
  ): OrgSnapshotRecord {
    if (!CHANGES.includes(input.change)) throw new Error(`unknown change ${input.change}`);
    if (typeof input.actor !== 'string' || !input.actor.trim()) throw new Error('actor is required');
    if (typeof input.graphJson !== 'string') throw new Error('graphJson must be a string');
    const snapshotId = opts?.snapshotId ?? `orgsnap-${randomUUID()}`;
    const createdAt = opts?.now ? opts.now() : new Date().toISOString();
    // Bounded retry on the UNIQUE(graph_version) arbiter — two processes
    // appending at once race for the same next version; the loser retries
    // against the fresh max (Batch 26 pattern).
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        const maxRow = this.db
          .prepare('SELECT MAX(graph_version) AS m FROM org_version_snapshots')
          .get() as { m: number | null } | undefined;
        const version = (maxRow?.m ?? 0) + 1;
        this.db
          .prepare(
            `INSERT INTO org_version_snapshots
             (snapshot_id, graph_version, change, node_id, edge_id, actor, created_at, graph_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(snapshotId, version, input.change, input.nodeId ?? null, input.edgeId ?? null, input.actor, createdAt, input.graphJson);
        this.db.exec('COMMIT');
        return {
          snapshotId,
          graphVersion: version,
          change: input.change,
          nodeId: input.nodeId ?? null,
          edgeId: input.edgeId ?? null,
          actor: input.actor,
          createdAt,
          graphJson: input.graphJson,
        };
      } catch (e) {
        lastError = e;
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        const msg = e instanceof Error ? e.message : String(e);
        // UNIQUE(graph_version) lost the race — retry against the fresh max.
        if (/UNIQUE constraint failed: org_version_snapshots\.graph_version/.test(msg)) continue;
        throw e;
      }
    }
    throw lastError;
  }

  get(snapshotId: string): OrgSnapshotRecord | undefined {
    const row = this.db.prepare('SELECT * FROM org_version_snapshots WHERE snapshot_id = ?').get(snapshotId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return checkParsedGraph(this.rowToRec(row));
  }

  list(): OrgSnapshotRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM org_version_snapshots ORDER BY graph_version DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => checkParsedGraph(this.rowToRec(r)));
  }

  listSnapshotIds(): string[] {
    const rows = this.db
      .prepare('SELECT snapshot_id FROM org_version_snapshots ORDER BY graph_version DESC')
      .all() as { snapshot_id: string }[];
    return rows.map((r) => r.snapshot_id);
  }

  maxVersion(): number {
    const row = this.db.prepare('SELECT MAX(graph_version) AS m FROM org_version_snapshots').get() as
      | { m: number | null }
      | undefined;
    return row?.m ?? 0;
  }
}
