/**
 * Database environment identities — SPEC v2 §33.
 *
 * The only normative sentence on this (SPEC v2 §33): "Database 分开 DEV/UAT/PROD
 * 身份；生产写仅经最小权限 Broker/Runbook。" ("Database" keeps separate
 * DEV/UAT/PROD identities; production writes go only through a
 * least-privilege Broker/Runbook.)
 *
 * This module ships the identity layer and the fail-closed production-write
 * gate that the broker will sit behind:
 *
 *  - Every database connection carries an EXPLICIT environment identity:
 *    'dev' | 'staging' | 'prod'. SPEC says DEV/UAT/PROD; 'staging' here is
 *    SPEC's UAT (the pre-production acceptance environment).
 *  - Registration without an environment defaults to 'dev'. The default is
 *    deliberately the least-privileged identity — this module never guesses
 *    'prod'.
 *  - Environment identity is IMMUTABLE. Re-registering the same connection
 *    name with a different environment is refused; register a new name
 *    instead. A silent env flip (dev → prod) is exactly the accident this
 *    layer exists to prevent.
 *  - Statement classification is conservative: only statements whose first
 *    keyword is in the read set (SELECT/WITH/EXPLAIN/VALUES/SHOW/DESCRIBE/
 *    DESC) count as reads; everything else — including PRAGMA, DDL, and any
 *    unrecognized statement — counts as a write (fail-closed).
 *  - Reads are authorized on any environment (the capability/approval gates
 *    upstream still apply); writes on dev/staging are authorized; writes on
 *    prod require an explicit `prodWriteConfirmed === true` on the call —
 *    otherwise DENIED. A truthy non-true value ('yes', 1) does NOT count.
 *  - Connection switches are audited via an explicit previous-connection
 *    pointer: this gate keeps no hidden session state, so a caller that
 *    tracks an active connection passes `previousConnectionName` and a
 *    switch is emitted as DB_CONNECTION_SWITCHED.
 *  - Secret values are NEVER stored here — `credentialRefs` holds reference
 *    names only (same rule as MCP `credentialRefs`).
 *
 * Honest boundary (also stated in the db.query builtin gap note): this is
 * NOT the spec's least-privilege Broker/Runbook, no query engine ships
 * (db.query stays definition-only), and no physical isolation is provided —
 * connections are descriptors, and every future executor (host-injected or
 * otherwise) must authorize through this gate first. Production writes are
 * gated by explicit confirmation + audit, not by a broker, until the broker
 * is built.
 */

export type DbEnvironment = 'dev' | 'staging' | 'prod';

/** The three environment identities, in increasing order of privilege. */
export const DB_ENVIRONMENTS: readonly DbEnvironment[] = ['dev', 'staging', 'prod'];

export function isDbEnvironment(value: unknown): value is DbEnvironment {
  return typeof value === 'string' && (DB_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Remote/driver kind of the connection. Descriptive only — no socket is opened here. */
export type DbConnectionKind = 'sqlite' | 'postgres' | 'mysql' | 'other';

export interface DbConnectionDescriptor {
  /** Unique connection name, e.g. 'orders-staging'. */
  name: string;
  /** Explicit environment identity. Immutable after registration. */
  environment: DbEnvironment;
  kind: DbConnectionKind;
  /**
   * Credential REFERENCE names only (e.g. ['DB_PASSWORD_REF']).
   * Secret values are never accepted or stored by this registry.
   */
  credentialRefs: string[];
  /** ISO timestamp of registration (injected clock for tests). */
  registeredAt: string;
}

export interface RegisterConnectionInput {
  name: string;
  kind?: DbConnectionKind;
  credentialRefs?: string[];
  /**
   * Explicit environment identity. When omitted the connection is
   * registered as 'dev' — the module never guesses a higher-privilege
   * identity.
   */
  environment?: DbEnvironment;
}

/** Audit intents emitted by the registry and the gate. */
export type DbAuditIntentType =
  | 'DB_CONNECTION_REGISTERED'
  | 'DB_CONNECTION_DEREGISTERED'
  | 'DB_CONNECTION_SWITCHED'
  | 'DB_PROD_WRITE_ATTEMPT'
  | 'DB_PROD_WRITE_CONFIRMED'
  | 'DB_PROD_WRITE_DENIED'
  | 'DB_QUERY_DENIED'
  // Batch 28: least-privilege Broker/Runbook intents (see db-broker.ts).
  | 'DB_BROKER_POLICY_SET'
  | 'DB_BROKER_ENGINE_REGISTERED'
  | 'DB_BROKER_ENGINE_DEREGISTERED'
  | 'DB_BROKER_EXECUTED'
  | 'DB_BROKER_DENIED'
  | 'DB_BROKER_NO_ENGINE'
  | 'DB_BROKER_EXECUTION_FAILED'
  | 'DB_RUNBOOK_REGISTERED'
  | 'DB_RUNBOOK_DEREGISTERED'
  | 'DB_RUNBOOK_EXECUTED'
  | 'DB_RUNBOOK_DENIED';

export interface DbAuditIntent {
  type: DbAuditIntentType;
  /** ISO timestamp. */
  at: string;
  connectionName: string;
  environment?: DbEnvironment;
  /** Who asked (principal id), when the caller bothers to say. */
  actor?: string;
  /** Machine-readable reason for denials and switches. */
  reason?: string;
  /** Free-form detail; never carries secret values. */
  detail?: string;
  /**
   * The SQL text involved (Batch 28). Parameter placeholders only — bound
   * values are NEVER audited.
   */
  sql?: string;
  /** Whether the broker/runbook allowed the execution (Batch 28). */
  allowed?: boolean;
  /** Rows returned/affected by an executed query (Batch 28). */
  rowCount?: number;
  /** Runbook template name, for runbook intents (Batch 28). */
  templateName?: string;
}

/** Where audit intents go — injected by the host, like every other sink in this codebase. */
export type DbAuditSink = (intent: DbAuditIntent) => void;

export interface DatabaseRegistryOptions {
  now?: () => number;
  auditSink?: DbAuditSink;
}

/** Statement classes for the prod-write gate. Unknown statements are writes (fail-closed). */
export type DbStatementKind = 'read' | 'write';

const READ_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'VALUES',
  'SHOW',
  'DESCRIBE',
  'DESC',
]);

/**
 * Conservative statement classification. Leading line/block comments and
 * whitespace are skipped; a multi-statement string is a write if ANY
 * statement is a write (split is naive on ';' — documented, fail-closed).
 * Empty input classifies as 'write' so it can never slip through as a read.
 */
export function classifyStatement(sql: string): DbStatementKind {
  const chunks = String(sql).split(';');
  for (const chunk of chunks) {
    const first = firstKeyword(chunk);
    if (first === null) continue; // empty/comment-only chunk
    if (!READ_KEYWORDS.has(first)) return 'write';
  }
  return 'read';
}

/** First SQL keyword of a (possibly commented) statement, uppercased; null when none. */
function firstKeyword(chunk: string): string | null {
  let s = chunk.trimStart();
  // Strip leading comments repeatedly (e.g. "-- x\n/* y */ SELECT ...").
  for (;;) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1).trimStart();
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2).trimStart();
    } else {
      break;
    }
  }
  const m = /^[A-Za-z]+/.exec(s);
  return m ? m[0].toUpperCase() : null;
}

/**
 * First keyword of every statement in a (possibly multi-statement) string,
 * uppercased; empty/comment-only chunks contribute nothing. Exported for the
 * broker's least-privilege operation mapping (Batch 28).
 */
export function statementKeywords(sql: string): string[] {
  const out: string[] = [];
  for (const chunk of String(sql).split(';')) {
    const kw = firstKeyword(chunk);
    if (kw !== null) out.push(kw);
  }
  return out;
}

export interface AuthorizeDbQueryInput {
  connectionName: string;
  sql: string;
  /**
   * Required for writes against a 'prod' connection. Must be literally
   * `true` — truthy strings/numbers do not count.
   */
  prodWriteConfirmed?: boolean;
  /**
   * Name of the previously active connection, when the caller tracks one.
   * When provided and different, a DB_CONNECTION_SWITCHED audit is emitted.
   * The gate itself keeps no hidden session state.
   */
  previousConnectionName?: string;
  actor?: string;
}

export type DbDecisionCode =
  | 'OK'
  | 'UNKNOWN_CONNECTION'
  | 'EMPTY_STATEMENT'
  | 'PROD_WRITE_REQUIRES_CONFIRMATION';

export interface DbAuthorization {
  allowed: boolean;
  code: DbDecisionCode;
  /** Human-readable reason; denials name what is missing. */
  reason: string;
  environment?: DbEnvironment;
  statementKind?: DbStatementKind;
}

function isoNow(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

function validName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 128;
}

/**
 * Registry of database connections with explicit environment identities,
 * plus the production-write authorization gate. Storage-agnostic and
 * dependency-free; audit flows through the injected sink.
 */
export class DatabaseEnvironmentRegistry {
  private readonly connections = new Map<string, DbConnectionDescriptor>();
  private readonly now?: () => number;
  private readonly auditSink?: DbAuditSink;

  constructor(opts: DatabaseRegistryOptions = {}) {
    this.now = opts.now;
    this.auditSink = opts.auditSink;
  }

  private emit(intent: Omit<DbAuditIntent, 'at'>): void {
    this.auditSink?.({ ...intent, at: isoNow(this.now) });
  }

  /**
   * Register a connection. `environment` defaults to 'dev' and is then
   * immutable: re-registering the same name with a DIFFERENT environment
   * throws (register a new name instead). Same name + same environment
   * updates kind/credentialRefs (rotation-friendly) and re-audits.
   */
  registerConnection(input: RegisterConnectionInput): DbConnectionDescriptor {
    const { name } = input;
    if (!validName(name)) throw new Error(`invalid connection name: ${JSON.stringify(name)}`);
    const environment: DbEnvironment = input.environment ?? 'dev';
    if (!isDbEnvironment(environment)) {
      throw new Error(`invalid environment ${JSON.stringify(input.environment)}; expected one of ${DB_ENVIRONMENTS.join('|')}`);
    }
    const existing = this.connections.get(name);
    if (existing && existing.environment !== environment) {
      throw new Error(
        `connection "${name}" is already registered as '${existing.environment}'; ` +
          `environment identity is immutable — register a new connection name instead`,
      );
    }
    const descriptor: DbConnectionDescriptor = {
      name,
      environment,
      kind: input.kind ?? 'other',
      credentialRefs: [...(input.credentialRefs ?? [])],
      registeredAt: isoNow(this.now),
    };
    this.connections.set(name, descriptor);
    this.emit({
      type: 'DB_CONNECTION_REGISTERED',
      connectionName: name,
      environment,
      detail: existing ? 're-registered (same environment)' : 'registered',
    });
    return { ...descriptor, credentialRefs: [...descriptor.credentialRefs] };
  }

  /** Remove a connection. Returns false when the name was not registered. */
  deregisterConnection(name: string): boolean {
    const existing = this.connections.get(name);
    if (!existing) return false;
    this.connections.delete(name);
    this.emit({
      type: 'DB_CONNECTION_DEREGISTERED',
      connectionName: name,
      environment: existing.environment,
    });
    return true;
  }

  getConnection(name: string): DbConnectionDescriptor | undefined {
    const d = this.connections.get(name);
    return d ? { ...d, credentialRefs: [...d.credentialRefs] } : undefined;
  }

  listConnections(): DbConnectionDescriptor[] {
    return [...this.connections.values()].map((d) => ({ ...d, credentialRefs: [...d.credentialRefs] }));
  }

  /**
   * Explicit switch audit for callers that track an active connection.
   * No-ops (and emits nothing) when from === to or either is blank.
   */
  auditSwitch(from: string | undefined, to: string, actor?: string): void {
    if (!from || !to || from === to) return;
    const target = this.connections.get(to);
    this.emit({
      type: 'DB_CONNECTION_SWITCHED',
      connectionName: to,
      environment: target?.environment,
      actor,
      reason: `active connection changed from "${from}" to "${to}"`,
    });
  }

  /**
   * Authorize one query against a registered connection. Every decision is
   * bound to exactly one connection — there is no cross-environment query.
   * Prod writes require literal `prodWriteConfirmed === true`; denials and
   * prod attempts are audited. Reads and non-prod writes are authorized
   * silently here (capability/approval gates upstream still apply).
   */
  authorizeQuery(input: AuthorizeDbQueryInput): DbAuthorization {
    const { connectionName, sql } = input;
    this.auditSwitch(input.previousConnectionName, connectionName, input.actor);

    const connection = this.connections.get(connectionName);
    if (!connection) {
      const reason = `unknown database connection "${connectionName}" — connections must be registered with an explicit environment identity; refusing to guess`;
      this.emit({
        type: 'DB_QUERY_DENIED',
        connectionName,
        actor: input.actor,
        reason,
      });
      return { allowed: false, code: 'UNKNOWN_CONNECTION', reason };
    }

    if (String(sql).trim().length === 0) {
      const reason = 'empty statement refused';
      this.emit({
        type: 'DB_QUERY_DENIED',
        connectionName,
        environment: connection.environment,
        actor: input.actor,
        reason,
      });
      return { allowed: false, code: 'EMPTY_STATEMENT', reason, environment: connection.environment };
    }

    const statementKind = classifyStatement(sql);
    const isProdWrite = connection.environment === 'prod' && statementKind === 'write';
    if (isProdWrite) {
      this.emit({
        type: 'DB_PROD_WRITE_ATTEMPT',
        connectionName,
        environment: 'prod',
        actor: input.actor,
        detail: `statement kind: ${statementKind}`,
      });
      if (input.prodWriteConfirmed !== true) {
        const reason =
          'production write requires explicit prodWriteConfirmed === true on the call; ' +
          'confirmation is a fail-closed gate, not the spec §33 least-privilege Broker/Runbook (not built yet)';
        this.emit({
          type: 'DB_PROD_WRITE_DENIED',
          connectionName,
          environment: 'prod',
          actor: input.actor,
          reason,
        });
        return {
          allowed: false,
          code: 'PROD_WRITE_REQUIRES_CONFIRMATION',
          reason,
          environment: 'prod',
          statementKind,
        };
      }
      this.emit({
        type: 'DB_PROD_WRITE_CONFIRMED',
        connectionName,
        environment: 'prod',
        actor: input.actor,
        detail: `confirmed production write authorized (statement kind: ${statementKind})`,
      });
    }

    return {
      allowed: true,
      code: 'OK',
      reason:
        statementKind === 'read'
          ? `read authorized on '${connection.environment}' connection "${connectionName}"`
          : `write authorized on '${connection.environment}' connection "${connectionName}"`,
      environment: connection.environment,
      statementKind,
    };
  }
}
