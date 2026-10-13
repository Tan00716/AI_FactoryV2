/**
 * Durable MCP server registrations + install records — SPEC v2 §46, §34.1 (Batch 21).
 *
 * Until Batch 21 the McpRegistry / McpManager were process memory only:
 * a restart sent every approved server back to BLOCKED. This file is
 * the record layer only: one row per (name, version) registration with
 * the full McpServer JSON (lossless) plus indexable projections, one
 * row per install record, and the trust assessment as JSON on the
 * server row. The mapping between the live @ai-factory/mcp shapes and
 * these rows (including secret-value stripping) lives in the server
 * layer (apps/server/src/mcp-persistence.ts), which can see both
 * packages — this file stays dependency-free of @ai-factory/mcp.
 *
 * Record semantics (pinned by tests):
 *  - saveServer is an upsert keyed by (name, version); rows are never
 *    implicitly deleted. /api/mcp/remove deletes explicitly (cascade
 *    to the install row).
 *  - listServers returns rows in first-registration order so hydration
 *    replays the same order the registry saw.
 *  - health is point-in-time data: it is stored for the record, but
 *    hydration marks it stale (healthStale) and the live registry
 *    does NOT inherit it — a restart must not pretend a fresh health
 *    check happened. A new recordHealth overwrites with healthStale=0.
 *  - credentialRefs are names only — the store has no values field,
 *    but the row also passes through the server layer's
 *    stripSecretValues() so even a smuggled runtimePolicy.stdioEnvFixed
 *    value can never reach disk.
 */

import { DatabaseSync } from 'node:sqlite';

export interface McpServerDbRecord {
  name: string;
  version: string;
  trustLevel: string;
  approvalPolicy: string;
  /** A health report exists on the row but belongs to a dead process. */
  healthStale: boolean;
  /** Full McpServer JSON (lossless: tools, prompts, history, …). */
  recordJson: string;
  /** TrustAssessment JSON, when one was recorded. */
  assessmentJson: string | null;
  updatedAt: string;
  /**
   * Optimistic-concurrency generation (Batch 25). Bumped by every
   * applied write; applyServerOp serializes writers so a version is
   * never skipped.
   */
  rowVersion: number;
}

export interface McpInstallDbRecord {
  name: string;
  version: string;
  status: string;
  installedAt: string | null;
  /** JSON object of per-scope enable flags. */
  scopeEnabledJson: string;
  lastUsedVersion: string | null;
}

export interface McpServerStore {
  saveServer(rec: McpServerDbRecord): McpServerDbRecord;
  getServer(name: string, version: string): McpServerDbRecord | undefined;
  listServers(): McpServerDbRecord[];
  /** Explicit delete (server /remove); also removes the install row. */
  removeServer(name: string, version: string): boolean;
  markHealthStale(name: string, version: string): void;
  saveInstall(rec: McpInstallDbRecord): McpInstallDbRecord;
  getInstall(name: string, version: string): McpInstallDbRecord | undefined;
  listInstalls(): McpInstallDbRecord[];
  removeInstall(name: string, version: string): boolean;
  /**
   * Atomically apply a mutation to a server row (Batch 25, cross-process
   * write mutual exclusion).
   *
   * The callback receives the CURRENT row (or undefined when absent) and
   * returns the replacement record (or null for a no-op). Read, callback
   * and write run inside one BEGIN IMMEDIATE transaction, so two
   * processes racing on the same row serialize: the loser's callback
   * sees the winner's committed row instead of blindly overwriting it
   * with stale state. row_version is bumped on every applied write.
   * A throwing callback rolls the transaction back and the error
   * propagates loudly — mutations are never silently dropped.
   */
  applyServerOp(
    name: string,
    version: string,
    apply: (current: McpServerDbRecord | undefined) => McpServerDbRecord | null,
  ): { applied: boolean; rowVersion: number };
}

function nowIso(): string {
  return new Date().toISOString();
}

function copyServer(r: McpServerDbRecord): McpServerDbRecord {
  return { ...r };
}

function copyInstall(r: McpInstallDbRecord): McpInstallDbRecord {
  return { ...r };
}

/** In-memory reference implementation — the behavior pin. */
export class MemoryMcpServerStore implements McpServerStore {
  private readonly servers = new Map<string, McpServerDbRecord>();
  private readonly installs = new Map<string, McpInstallDbRecord>();

  private static key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  saveServer(rec: McpServerDbRecord): McpServerDbRecord {
    const k = MemoryMcpServerStore.key(rec.name, rec.version);
    const prev = this.servers.get(k);
    const stored = copyServer({ ...rec, updatedAt: rec.updatedAt ?? nowIso() });
    stored.rowVersion = (prev?.rowVersion ?? 0) + 1;
    this.servers.set(k, stored);
    return copyServer(stored);
  }

  getServer(name: string, version: string): McpServerDbRecord | undefined {
    const r = this.servers.get(MemoryMcpServerStore.key(name, version));
    return r ? copyServer(r) : undefined;
  }

  listServers(): McpServerDbRecord[] {
    return [...this.servers.values()].map(copyServer);
  }

  removeServer(name: string, version: string): boolean {
    const k = MemoryMcpServerStore.key(name, version);
    const existed = this.servers.delete(k);
    this.installs.delete(k);
    return existed;
  }

  markHealthStale(name: string, version: string): void {
    const r = this.servers.get(MemoryMcpServerStore.key(name, version));
    if (r) r.healthStale = true;
  }

  saveInstall(rec: McpInstallDbRecord): McpInstallDbRecord {
    const stored = copyInstall(rec);
    this.installs.set(MemoryMcpServerStore.key(rec.name, rec.version), stored);
    return copyInstall(stored);
  }

  getInstall(name: string, version: string): McpInstallDbRecord | undefined {
    const r = this.installs.get(MemoryMcpServerStore.key(name, version));
    return r ? copyInstall(r) : undefined;
  }

  listInstalls(): McpInstallDbRecord[] {
    return [...this.installs.values()].map(copyInstall);
  }

  removeInstall(name: string, version: string): boolean {
    return this.installs.delete(MemoryMcpServerStore.key(name, version));
  }

  applyServerOp(
    name: string,
    version: string,
    apply: (current: McpServerDbRecord | undefined) => McpServerDbRecord | null,
  ): { applied: boolean; rowVersion: number } {
    const k = MemoryMcpServerStore.key(name, version);
    const current = this.servers.get(k);
    const next = apply(current ? copyServer(current) : undefined);
    if (!next) return { applied: false, rowVersion: current?.rowVersion ?? 0 };
    const stored = copyServer({ ...next, name, version, updatedAt: next.updatedAt ?? nowIso() });
    stored.rowVersion = (current?.rowVersion ?? 0) + 1;
    this.servers.set(k, stored);
    return { applied: true, rowVersion: stored.rowVersion };
  }
}

function serverRowToRecord(row: Record<string, unknown>): McpServerDbRecord {
  return {
    name: row['name'] as string,
    version: row['version'] as string,
    trustLevel: row['trust_level'] as string,
    approvalPolicy: row['approval_policy'] as string,
    healthStale: (row['health_stale'] as number) === 1,
    recordJson: row['record_json'] as string,
    assessmentJson: (row['assessment_json'] as string) ?? null,
    updatedAt: row['updated_at'] as string,
    rowVersion: (row['row_version'] as number) ?? 1,
  };
}

function installRowToRecord(row: Record<string, unknown>): McpInstallDbRecord {
  return {
    name: row['name'] as string,
    version: row['version'] as string,
    status: row['status'] as string,
    installedAt: (row['installed_at'] as string) ?? null,
    scopeEnabledJson: (row['scope_enabled_json'] as string) ?? '{}',
    lastUsedVersion: (row['last_used_version'] as string) ?? null,
  };
}

/** SQLite implementation, pinned against the memory reference. */
export class SqliteMcpServerStore implements McpServerStore {
  constructor(private readonly db: DatabaseSync) {
    // Cross-process writers serialize on BEGIN IMMEDIATE below; a busy
    // timeout (instead of fail-fast SQLITE_BUSY) keeps a contended
    // write waiting briefly rather than erroring. It is set on the
    // shared connection, so every store on this FactoryDatabase
    // benefits; 5s is far above a microsecond-scale upsert.
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  saveServer(rec: McpServerDbRecord): McpServerDbRecord {
    const stored = copyServer({ ...rec, updatedAt: rec.updatedAt ?? nowIso() });
    this.db
      .prepare(
        `INSERT INTO mcp_servers
           (name, version, trust_level, approval_policy, health_stale,
            record_json, assessment_json, updated_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (name, version) DO UPDATE SET
           trust_level = excluded.trust_level,
           approval_policy = excluded.approval_policy,
           health_stale = excluded.health_stale,
           record_json = excluded.record_json,
           assessment_json = excluded.assessment_json,
           updated_at = excluded.updated_at,
           row_version = mcp_servers.row_version + 1`,
      )
      .run(
        stored.name,
        stored.version,
        stored.trustLevel,
        stored.approvalPolicy,
        stored.healthStale ? 1 : 0,
        stored.recordJson,
        stored.assessmentJson,
        stored.updatedAt,
      );
    const vrow = this.db
      .prepare('SELECT row_version FROM mcp_servers WHERE name = ? AND version = ?')
      .get(stored.name, stored.version) as { row_version: number };
    stored.rowVersion = vrow.row_version;
    return stored;
  }

  getServer(name: string, version: string): McpServerDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE name = ? AND version = ?')
      .get(name, version) as Record<string, unknown> | undefined;
    return row ? serverRowToRecord(row) : undefined;
  }

  listServers(): McpServerDbRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_servers ORDER BY rowid ASC')
      .all() as Record<string, unknown>[];
    return rows.map(serverRowToRecord);
  }

  removeServer(name: string, version: string): boolean {
    const gone = this.db
      .prepare('DELETE FROM mcp_servers WHERE name = ? AND version = ?')
      .run(name, version).changes as number;
    this.db
      .prepare('DELETE FROM mcp_installs WHERE name = ? AND version = ?')
      .run(name, version);
    return gone > 0;
  }

  markHealthStale(name: string, version: string): void {
    this.db
      .prepare('UPDATE mcp_servers SET health_stale = 1 WHERE name = ? AND version = ?')
      .run(name, version);
  }

  saveInstall(rec: McpInstallDbRecord): McpInstallDbRecord {
    const stored = copyInstall(rec);
    this.db
      .prepare(
        `INSERT INTO mcp_installs
           (name, version, status, installed_at, scope_enabled_json, last_used_version)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name, version) DO UPDATE SET
           status = excluded.status,
           installed_at = excluded.installed_at,
           scope_enabled_json = excluded.scope_enabled_json,
           last_used_version = excluded.last_used_version`,
      )
      .run(
        stored.name,
        stored.version,
        stored.status,
        stored.installedAt,
        stored.scopeEnabledJson,
        stored.lastUsedVersion,
      );
    return stored;
  }

  getInstall(name: string, version: string): McpInstallDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_installs WHERE name = ? AND version = ?')
      .get(name, version) as Record<string, unknown> | undefined;
    return row ? installRowToRecord(row) : undefined;
  }

  listInstalls(): McpInstallDbRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_installs ORDER BY rowid ASC')
      .all() as Record<string, unknown>[];
    return rows.map(installRowToRecord);
  }

  removeInstall(name: string, version: string): boolean {
    const gone = this.db
      .prepare('DELETE FROM mcp_installs WHERE name = ? AND version = ?')
      .run(name, version).changes as number;
    return gone > 0;
  }

  applyServerOp(
    name: string,
    version: string,
    apply: (current: McpServerDbRecord | undefined) => McpServerDbRecord | null,
  ): { applied: boolean; rowVersion: number } {
    // BEGIN IMMEDIATE takes the write lock up front: the read/callback/
    // write below is atomic across processes. A second process blocks
    // on the busy timeout (set in the constructor) instead of failing
    // with SQLITE_BUSY; if the timeout expires the error propagates
    // loudly — a mutation is never silently dropped.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT * FROM mcp_servers WHERE name = ? AND version = ?')
        .get(name, version) as Record<string, unknown> | undefined;
      const current = row ? serverRowToRecord(row) : undefined;
      const next = apply(current);
      if (!next) {
        this.db.exec('ROLLBACK');
        return { applied: false, rowVersion: current?.rowVersion ?? 0 };
      }
      const newVersion = (current?.rowVersion ?? 0) + 1;
      const stored: McpServerDbRecord = {
        ...copyServer(next),
        name,
        version,
        updatedAt: next.updatedAt ?? nowIso(),
        rowVersion: newVersion,
      };
      this.db
        .prepare(
          `INSERT INTO mcp_servers
             (name, version, trust_level, approval_policy, health_stale,
              record_json, assessment_json, updated_at, row_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (name, version) DO UPDATE SET
             trust_level = excluded.trust_level,
             approval_policy = excluded.approval_policy,
             health_stale = excluded.health_stale,
             record_json = excluded.record_json,
             assessment_json = excluded.assessment_json,
             updated_at = excluded.updated_at,
             row_version = excluded.row_version`,
        )
        .run(
          stored.name,
          stored.version,
          stored.trustLevel,
          stored.approvalPolicy,
          stored.healthStale ? 1 : 0,
          stored.recordJson,
          stored.assessmentJson,
          stored.updatedAt,
          newVersion,
        );
      this.db.exec('COMMIT');
      return { applied: true, rowVersion: newVersion };
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back / no transaction — the original error
        // is what matters.
      }
      throw e;
    }
  }
}
