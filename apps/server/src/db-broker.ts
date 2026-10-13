/**
 * Server-side database query execution surface — SPEC v2 §33 (Batch 29).
 *
 * This is the host wiring for the DbBroker that ships in-package
 * (@ai-factory/tools, Batches 27–28): the registry's fail-closed gate
 * (DatabaseEnvironmentRegistry) and the least-privilege Broker/Runbook
 * (DbBroker) live in the package; THIS module injects the one thing the
 * package cannot own — a real DbQueryEngine, derived here from the
 * server's own FactoryDatabase SQLite connection (host-injected mode).
 *
 * Deliberate layering (do not collapse):
 *   - `db.query` the TOOL stays definition-only: the tools route's
 *     implementationGate does NOT wire this service, so it keeps
 *     answering DENY. Tools and the HTTP broker surface are separate
 *     contracts.
 *   - The HTTP surface (routes/db.ts) runs every call through
 *     authorizeQuery gate → per-connection privilege whitelist → engine,
 *     in that order. A connection with no registered engine is refused
 *     LOUDLY (NO_ENGINE) — the broker never pretends it executed.
 *
 * Boot behavior (fail-closed, audited):
 *   - A connection named 'factory' is registered at boot with the
 *     environment identity from FACTORY_DB_ENVIRONMENT (dev|staging|prod,
 *     default dev; anything else refuses to start). kind 'sqlite',
 *     no credential refs (a local file needs none — said honestly).
 *   - The SQLite engine is bound to 'factory' at boot.
 *   - NO privilege policy is bound by default: ad-hoc execution is
 *     refused (PRIVILEGE_DENIED, loud reason) until an admin binds one
 *     via PUT /api/db/connections/factory/policy. Least privilege is
 *     the default, not a configuration step the operator might skip.
 *
 * Result limits: rows are capped at DB_QUERY_MAX_ROWS and columns at
 * DB_QUERY_MAX_COLS; truncation is always flagged in the response
 * (truncatedRows/truncatedColumns) — never silent. Binary values come
 * back as base64 strings (documented, not typed).
 *
 * Honest boundaries:
 *   - The engine executes raw SQL against the factory database file
 *     THROUGH the server's own SQLite connection. Writes skip the
 *     domain stores (TaskManager validation, archive guards, audit
 *     hash-chaining of the write itself) — the whitelist is the only
 *     thing between an operator and the tables, which is why policy
 *     writes are admin-only and every outcome lands in the audit log.
 *   - Single statements only: node:sqlite prepares one statement, so
 *     multi-statement strings are rejected before the broker (400),
 *     not half-executed.
 *   - Bound parameter VALUES are never audited, logged, or
 *     interpolated — audit carries the SQL text with placeholders only
 *     (the broker's own invariant, preserved here).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  DatabaseEnvironmentRegistry,
  DbBroker,
  operationOfKeyword,
  statementKeywords,
  type DbAuditIntent,
  type DbAuditSink,
  type DbEnvironment,
  type DbQueryEngine,
} from '@ai-factory/tools';
import type { AuditLog } from '@ai-factory/core';
import type { FactoryDatabase } from '@ai-factory/db';

/** Max rows returned per query; the total is still reported honestly. */
export const DB_QUERY_MAX_ROWS = 200;
/** Max columns per row; extra columns are dropped and flagged. */
export const DB_QUERY_MAX_COLS = 50;

/** The boot-registered connection over the factory's own database. */
export const DB_FACTORY_CONNECTION = 'factory';

/** Env var selecting the 'factory' connection's environment identity. */
export const DB_ENVIRONMENT_ENV = 'FACTORY_DB_ENVIRONMENT';

function resolveFactoryEnvironment(env: NodeJS.ProcessEnv = process.env): DbEnvironment {
  const raw = env[DB_ENVIRONMENT_ENV];
  if (raw === undefined || raw.trim() === '') return 'dev';
  const v = raw.trim().toLowerCase();
  if (v === 'dev' || v === 'staging' || v === 'prod') return v;
  throw new Error(
    `[ai-factory] refusing to start: invalid ${DB_ENVIRONMENT_ENV}=${JSON.stringify(raw)} ` +
      '(expected dev|staging|prod)',
  );
}

function isBinary(v: unknown): boolean {
  return (
    v instanceof Uint8Array ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
  );
}

function toJsonValue(v: unknown): unknown {
  if (isBinary(v)) {
    return Buffer.from(v as Uint8Array).toString('base64');
  }
  return v;
}

/**
 * Defense in depth: the broker already rejects non-scalar params
 * (INVALID_PARAMS) before the engine runs, but this engine never
 * trusts the interface type — anything that is not a SQLite-bindable
 * scalar is refused loudly instead of being coerced silently.
 */
function toBindParams(params: Record<string, unknown>): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      typeof v === 'bigint' ||
      isBinary(v)
    ) {
      out[k] = v as SQLInputValue;
    } else {
      throw new Error(`refusing to bind non-scalar param "${k}"`);
    }
  }
  return out;
}

/**
 * Host-injected engine over the server's own SQLite connection. Reads
 * use prepare().all(params); writes use prepare().run(params) and
 * report changes as rowCount. node:sqlite binds `:slot` named params
 * itself — this engine never interpolates values into SQL.
 */
export class SqliteDbQueryEngine implements DbQueryEngine {
  /** Truncation flags for the most recent execute() call. Set
   * synchronously inside execute(); the single-threaded broker chain
   * reads it right after, so it always describes that call. */
  lastTruncation: { truncatedRows: boolean; truncatedColumns: boolean } | null = null;

  constructor(private readonly db: DatabaseSync) {}

  async execute(input: {
    connectionName: string;
    sql: string;
    params: Record<string, unknown>;
    actor?: string;
  }): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number; durationMs?: number }> {
    const t0 = Date.now();
    const keywords = statementKeywords(input.sql);
    if (keywords.length !== 1) {
      throw new Error('only single-statement SQL is accepted by this engine');
    }
    const stmt = this.db.prepare(input.sql);
    const bound = toBindParams(input.params);
    let rows: Array<Record<string, unknown>>;
    let rowCount: number;
    let truncatedRows = false;
    let truncatedColumns = false;
    if (operationOfKeyword(keywords[0]) === 'read') {
      const raw = stmt.all(bound) as Array<Record<string, unknown>>;
      rowCount = raw.length;
      truncatedRows = raw.length > DB_QUERY_MAX_ROWS;
      const sliced = raw.slice(0, DB_QUERY_MAX_ROWS);
      rows = sliced.map((row) => {
        const keys = Object.keys(row);
        truncatedColumns = truncatedColumns || keys.length > DB_QUERY_MAX_COLS;
        const out: Record<string, unknown> = {};
        for (const k of keys.slice(0, DB_QUERY_MAX_COLS)) out[k] = toJsonValue(row[k]);
        return out;
      });
    } else {
      const info = stmt.run(bound);
      rows = [];
      rowCount = Number(info.changes);
    }
    this.lastTruncation = { truncatedRows, truncatedColumns };
    return { rows, rowCount, durationMs: Date.now() - t0 };
  }
}

export interface DbBrokerService {
  registry: DatabaseEnvironmentRegistry;
  broker: DbBroker;
  engine: SqliteDbQueryEngine;
}

/**
 * Build the server's database broker service. Throws (fail-closed, before
 * serving) on an invalid FACTORY_DB_ENVIRONMENT. Every broker/registry
 * audit intent is written into the server's hash-chained audit log under
 * its own action name (DB_CONNECTION_REGISTERED, DB_BROKER_EXECUTED,
 * …), with entityType 'db_connection'. SQL text in audit carries
 * placeholders only — bound values never reach the audit store.
 */
export function createDbBrokerService(
  fdb: FactoryDatabase,
  audit: AuditLog,
  env: NodeJS.ProcessEnv = process.env,
): DbBrokerService {
  const sink: DbAuditSink = (intent: DbAuditIntent) => {
    const details: Record<string, unknown> = { at: intent.at };
    if (intent.environment !== undefined) details['environment'] = intent.environment;
    if (intent.actor !== undefined) details['actor'] = intent.actor;
    if (intent.reason !== undefined) details['reason'] = intent.reason;
    if (intent.sql !== undefined) details['sql'] = intent.sql;
    if (intent.allowed !== undefined) details['allowed'] = intent.allowed;
    if (intent.rowCount !== undefined) details['rowCount'] = intent.rowCount;
    if (intent.detail !== undefined) details['detail'] = intent.detail;
    if (intent.templateName !== undefined) details['templateName'] = intent.templateName;
    audit.record(
      intent.actor ?? 'system',
      intent.type,
      'db_connection',
      intent.connectionName === '' ? '-' : intent.connectionName,
      details,
    );
  };

  const registry = new DatabaseEnvironmentRegistry({ auditSink: sink });
  const broker = new DbBroker(registry, { auditSink: sink });
  const engine = new SqliteDbQueryEngine(fdb.db);

  const environment = resolveFactoryEnvironment(env);
  registry.registerConnection({
    name: DB_FACTORY_CONNECTION,
    kind: 'sqlite',
    environment,
    credentialRefs: [],
  });
  broker.registerEngine(DB_FACTORY_CONNECTION, engine, 'system');
  return { registry, broker, engine };
}
