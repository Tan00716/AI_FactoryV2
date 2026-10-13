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

/**
 * One row per launched MCP stdio server process — §46 launch history
 * (Batch 26). Only metadata is persisted: server identity, launch
 * parameters (names only — credentialRefs and secretEnvVars are ref
 * NAMES by construction, never secret values), and lifecycle state.
 *
 * Lifecycle honesty: RUNNING means "this launcher spawned it and has
 * not seen it exit". STOPPED = the operator stopped it via /stop.
 * EXITED = the child exited on its own (exit code / signal recorded).
 * ORPHANED = the owning launcher process is gone (server restart);
 * the child process's real fate is UNKNOWN — it may still be running
 * as an orphan or it may be dead. We never pretend it is still
 * managed. ORPHANED is terminal: a new launch gets a new row.
 */
export type McpLaunchStatus = 'RUNNING' | 'STOPPED' | 'EXITED' | 'ORPHANED';

export interface McpLaunchDbRecord {
  id: string;
  name: string;
  version: string;
  /** Server boot that owns this row (randomUUID per boot). */
  bootId: string;
  pid: number | null;
  command: string;
  /** JSON array of argv strings. */
  argsJson: string;
  cwd: string | null;
  /** JSON array of credential ref NAMES (never values). */
  credentialRefsJson: string;
  /** JSON array of injected ENV_VAR NAMES (never values). */
  secretEnvVarsJson: string;
  status: McpLaunchStatus;
  launchedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  /** Why this row is ORPHANED (honest note, never a guess at fate). */
  orphanNote: string | null;
  updatedAt: string;
}

export interface McpServerStore {
  saveServer(rec: McpServerDbRecord): McpServerDbRecord;
  getServer(name: string, version: string): McpServerDbRecord | undefined;
  listServers(): McpServerDbRecord[];
  /**
   * Explicit delete (server /remove); also removes the install row.
   *
   * The two deletes are one atomic unit (Batch 28): the SQLite
   * implementation wraps them in a BEGIN IMMEDIATE … COMMIT
   * transaction so a concurrent process's saveInstall cannot land
   * between the two deletes and silently lose a write, and a
   * mid-remove crash cannot leave the registration gone with its
   * install row still behind. The optional `opts.afterServerDelete`
   * hook is a fault-injection seam for tests: it runs between the
   * two deletes so a test can simulate cross-process interleaving
   * (a throw or a concurrent saveInstall) and verify the unit
   * rolls back or commits whole. Production callers never pass it.
   */
  removeServer(
    name: string,
    version: string,
    opts?: { afterServerDelete?: () => void },
  ): boolean;
  markHealthStale(name: string, version: string): void;
  saveInstall(rec: McpInstallDbRecord): McpInstallDbRecord;
  getInstall(name: string, version: string): McpInstallDbRecord | undefined;
  listInstalls(): McpInstallDbRecord[];
  removeInstall(name: string, version: string): boolean;
  /**
   * Defensive scan (Batch 28): delete every install row that has no
   * matching server row and return the removed "name@version" keys.
   * Installs always die with their registration inside removeServer's
   * atomic unit; any row found here is an orphan from a crashed or
   * racing writer (e.g. a saveInstall that landed after a remove
   * committed). Never called silently — the caller audits the
   * removals so the cleanup stays loud.
   */
  removeOrphanInstalls(): string[];
  /**
   * Launch-record history (Batch 26). One row per spawn; the row
   * outlives the launcher process so a restart can report what was
   * launched and mark it ORPHANED honestly instead of forgetting it.
   */
  saveLaunch(rec: McpLaunchDbRecord): McpLaunchDbRecord;
  getLaunch(id: string): McpLaunchDbRecord | undefined;
  /** Newest first (by launched_at, then rowid). */
  listLaunches(): McpLaunchDbRecord[];
  /**
   * Partial update of a launch row (status transitions, exit
   * details). Unknown ids throw loudly — a launch record is never
   * silently dropped.
   */
  updateLaunch(
    id: string,
    patch: Partial<
      Pick<
        McpLaunchDbRecord,
        'status' | 'endedAt' | 'exitCode' | 'signal' | 'orphanNote' | 'updatedAt'
      >
    >,
  ): McpLaunchDbRecord;
  /**
   * Hydration step: every row still RUNNING from a DIFFERENT boot is
   * marked ORPHANED — the launcher that owned it is gone, so the
   * child's real fate is unknown and this server does not manage it.
   * Rows owned by this boot are untouched. Returns the orphaned count.
   */
  orphanRunningLaunches(bootId: string): number;
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

function copyLaunch(r: McpLaunchDbRecord): McpLaunchDbRecord {
  return { ...r };
}

/** In-memory reference implementation — the behavior pin. */
export class MemoryMcpServerStore implements McpServerStore {
  private readonly servers = new Map<string, McpServerDbRecord>();
  private readonly installs = new Map<string, McpInstallDbRecord>();
  private readonly launches = new Map<string, McpLaunchDbRecord>();

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

  removeServer(
    name: string,
    version: string,
    // Fault-injection seam for tests (signature parity with the sqlite
    // implementation). The memory store is single-threaded and
    // synchronous: the two deletes below are already one indivisible
    // step — there is no between for a fault to land in, and no
    // rollback machinery is needed (the cross-process crash window
    // the sqlite transaction closes does not exist here). The hook
    // runs after the deletes; a throwing hook propagates, with the
    // deletion already complete.
    opts?: { afterServerDelete?: () => void },
  ): boolean {
    const k = MemoryMcpServerStore.key(name, version);
    const existed = this.servers.delete(k);
    opts?.afterServerDelete?.();
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

  removeOrphanInstalls(): string[] {
    const removed: string[] = [];
    for (const k of this.installs.keys()) {
      if (!this.servers.has(k)) {
        this.installs.delete(k);
        removed.push(k);
      }
    }
    return removed.sort();
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

  saveLaunch(rec: McpLaunchDbRecord): McpLaunchDbRecord {
    const stored = copyLaunch({ ...rec, updatedAt: rec.updatedAt ?? nowIso() });
    this.launches.set(rec.id, stored);
    return copyLaunch(stored);
  }

  getLaunch(id: string): McpLaunchDbRecord | undefined {
    const r = this.launches.get(id);
    return r ? copyLaunch(r) : undefined;
  }

  listLaunches(): McpLaunchDbRecord[] {
    return [...this.launches.values()]
      .sort((a, b) => (a.launchedAt < b.launchedAt ? 1 : a.launchedAt > b.launchedAt ? -1 : 0))
      .map(copyLaunch);
  }

  updateLaunch(
    id: string,
    patch: Partial<
      Pick<
        McpLaunchDbRecord,
        'status' | 'endedAt' | 'exitCode' | 'signal' | 'orphanNote' | 'updatedAt'
      >
    >,
  ): McpLaunchDbRecord {
    const current = this.launches.get(id);
    if (!current) {
      throw new Error(`mcp: cannot update unknown launch record ${id}`);
    }
    const next = copyLaunch({ ...current, ...patch, updatedAt: patch.updatedAt ?? nowIso() });
    this.launches.set(id, next);
    return copyLaunch(next);
  }

  orphanRunningLaunches(bootId: string): number {
    let n = 0;
    const now = nowIso();
    for (const [id, r] of this.launches) {
      if (r.status === 'RUNNING' && r.bootId !== bootId) {
        this.launches.set(
          id,
          copyLaunch({
            ...r,
            status: 'ORPHANED',
            orphanNote:
              'owning launcher process is gone (server restart); the child ' +
              'process may still be running as an orphan or may be dead — ' +
              'its real fate is unknown and this server does not manage it',
            updatedAt: now,
          }),
        );
        n++;
      }
    }
    return n;
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

  removeServer(
    name: string,
    version: string,
    opts?: { afterServerDelete?: () => void },
  ): boolean {
    // Batch 28: both deletes are one atomic unit. BEGIN IMMEDIATE
    // takes the write lock up front, so a concurrent process's
    // saveInstall either waits for the commit (and then lands on a
    // removed registration — picked up by removeOrphanInstalls) or
    // ran before the lock (and is deleted together with the
    // registration). Either way no write is silently lost between
    // the two deletes, and a crash between them cannot leave the
    // registration gone with its install row still behind.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const gone = this.db
        .prepare('DELETE FROM mcp_servers WHERE name = ? AND version = ?')
        .run(name, version).changes as number;
      // Fault-injection seam for tests: simulates a cross-process
      // interleaving between the two deletes. A throw here rolls
      // the whole unit back (verified in tests).
      opts?.afterServerDelete?.();
      this.db
        .prepare('DELETE FROM mcp_installs WHERE name = ? AND version = ?')
        .run(name, version);
      this.db.exec('COMMIT');
      return gone > 0;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* Already rolled back — the original error is what matters. */
      }
      throw e;
    }
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

  removeOrphanInstalls(): string[] {
    const rows = this.db
      .prepare(
        `DELETE FROM mcp_installs
         WHERE NOT EXISTS (
           SELECT 1 FROM mcp_servers s
           WHERE s.name = mcp_installs.name AND s.version = mcp_installs.version
         )
         RETURNING name, version`,
      )
      .all() as Array<{ name: string; version: string }>;
    return rows.map((r) => `${r.name}@${r.version}`).sort();
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

  saveLaunch(rec: McpLaunchDbRecord): McpLaunchDbRecord {
    const stored = copyLaunch({ ...rec, updatedAt: rec.updatedAt ?? nowIso() });
    this.db
      .prepare(
        `INSERT INTO mcp_launch_records
           (id, name, version, boot_id, pid, command, args_json, cwd,
            credential_refs_json, secret_env_vars_json, status,
            launched_at, ended_at, exit_code, signal, orphan_note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           boot_id = excluded.boot_id,
           pid = excluded.pid,
           command = excluded.command,
           args_json = excluded.args_json,
           cwd = excluded.cwd,
           credential_refs_json = excluded.credential_refs_json,
           secret_env_vars_json = excluded.secret_env_vars_json,
           status = excluded.status,
           launched_at = excluded.launched_at,
           ended_at = excluded.ended_at,
           exit_code = excluded.exit_code,
           signal = excluded.signal,
           orphan_note = excluded.orphan_note,
           updated_at = excluded.updated_at`,
      )
      .run(
        stored.id,
        stored.name,
        stored.version,
        stored.bootId,
        stored.pid,
        stored.command,
        stored.argsJson,
        stored.cwd,
        stored.credentialRefsJson,
        stored.secretEnvVarsJson,
        stored.status,
        stored.launchedAt,
        stored.endedAt,
        stored.exitCode,
        stored.signal,
        stored.orphanNote,
        stored.updatedAt,
      );
    return stored;
  }

  getLaunch(id: string): McpLaunchDbRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_launch_records WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? launchRowToRecord(row) : undefined;
  }

  listLaunches(): McpLaunchDbRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_launch_records ORDER BY launched_at DESC, rowid DESC')
      .all() as Record<string, unknown>[];
    return rows.map(launchRowToRecord);
  }

  updateLaunch(
    id: string,
    patch: Partial<
      Pick<
        McpLaunchDbRecord,
        'status' | 'endedAt' | 'exitCode' | 'signal' | 'orphanNote' | 'updatedAt'
      >
    >,
  ): McpLaunchDbRecord {
    const current = this.getLaunch(id);
    if (!current) {
      throw new Error(`mcp: cannot update unknown launch record ${id}`);
    }
    const next = copyLaunch({
      ...current,
      status: patch.status ?? current.status,
      endedAt: patch.endedAt !== undefined ? patch.endedAt : current.endedAt,
      exitCode: patch.exitCode !== undefined ? patch.exitCode : current.exitCode,
      signal: patch.signal !== undefined ? patch.signal : current.signal,
      orphanNote: patch.orphanNote !== undefined ? patch.orphanNote : current.orphanNote,
      updatedAt: patch.updatedAt ?? nowIso(),
    });
    const changes = this.db
      .prepare(
        `UPDATE mcp_launch_records
         SET status = ?, ended_at = ?, exit_code = ?, signal = ?,
             orphan_note = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.status, next.endedAt, next.exitCode, next.signal, next.orphanNote, next.updatedAt, id)
      .changes as number;
    if (changes === 0) {
      throw new Error(`mcp: cannot update unknown launch record ${id}`);
    }
    return next;
  }

  orphanRunningLaunches(bootId: string): number {
    const now = nowIso();
    const note =
      'owning launcher process is gone (server restart); the child ' +
      'process may still be running as an orphan or may be dead — ' +
      'its real fate is unknown and this server does not manage it';
    const res = this.db
      .prepare(
        `UPDATE mcp_launch_records
         SET status = 'ORPHANED', orphan_note = ?, updated_at = ?
         WHERE status = 'RUNNING' AND boot_id != ?`,
      )
      .run(note, now, bootId);
    return Number(res.changes ?? 0);
  }
}

function launchRowToRecord(row: Record<string, unknown>): McpLaunchDbRecord {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    version: row['version'] as string,
    bootId: row['boot_id'] as string,
    pid: (row['pid'] as number) ?? null,
    command: row['command'] as string,
    argsJson: (row['args_json'] as string) ?? '[]',
    cwd: (row['cwd'] as string) ?? null,
    credentialRefsJson: (row['credential_refs_json'] as string) ?? '[]',
    secretEnvVarsJson: (row['secret_env_vars_json'] as string) ?? '[]',
    status: row['status'] as McpLaunchStatus,
    launchedAt: row['launched_at'] as string,
    endedAt: (row['ended_at'] as string) ?? null,
    exitCode: (row['exit_code'] as number) ?? null,
    signal: (row['signal'] as string) ?? null,
    orphanNote: (row['orphan_note'] as string) ?? null,
    updatedAt: row['updated_at'] as string,
  };
}
