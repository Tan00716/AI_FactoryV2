/**
 * SPEC v2 §33 least-privilege Broker/Runbook for database access.
 *
 * The only normative sentence on this (SPEC v2 §33): "Database 分开 DEV/UAT/PROD
 * 身份；生产写仅经最小权限 Broker/Runbook。" This module ships the second
 * half — the actual query-executing agent that sits BEHIND the
 * DatabaseEnvironmentRegistry fail-closed gate (database.ts, Batch 27).
 *
 * Two execution paths:
 *
 *  - **Broker (ad-hoc SQL)**: `execute()` runs caller-supplied SQL through
 *    three checkpoints, in order:
 *      1. the registry's `authorizeQuery` gate (unknown connection, empty
 *         statement, prod-write confirmation);
 *      2. the per-connection least-privilege whitelist — every statement's
 *         operation bucket AND every referenced table must be allowed;
 *      3. the host-injected query engine, which actually runs the query.
 *    Every outcome is audited (who / when / what SQL / allowed or not /
 *    row count). A connection with no registered engine is refused LOUDLY
 *    (`NO_ENGINE`) — the broker never pretends it executed anything.
 *
 *  - **Runbook (named templates)**: `registerRunbookTemplate()` binds a
 *    fixed SQL template with `:slot` parameter slots to one connection.
 *    Registration is itself the approval (audited). `runRunbook()` validates
 *    that params match the declared slots EXACTLY (no missing, no extra) and
 *    are scalar-only, then runs through the registry gate and the engine.
 *    The broker NEVER interpolates values into SQL — the engine receives the
 *    template text and the params object separately and binds them itself.
 *    Runbook templates skip the ad-hoc operation/table whitelist BY DESIGN
 *    (the registered template is the pre-approval, not ad-hoc SQL); they
 *    still pass the registry gate (prod writes still need confirmation).
 *
 * Honest boundaries (also in KNOWN_LIMITATIONS):
 *  1. Table extraction is best-effort parsing for common DML/DDL shapes
 *     (FROM/JOIN/INTO/UPDATE/TABLE/TRUNCATE + comma lists, subqueries,
 *     schema-qualified and quoted names). Anything it cannot see fails
 *     CLOSED: a write with no determinable target table is refused.
 *  2. This is an in-package execution surface for hosts that inject engines.
 *     `db.query` stays definition-only at the server — no server wiring in
 *     this batch — and no physical isolation is provided; the engine runs
 *     wherever the host puts it.
 *  3. Audit carries the SQL text with placeholders only. Bound parameter
 *     VALUES are never audited, never logged, never interpolated.
 *  4. Only single-statement runbook templates are accepted (multi-statement
 *     strings are rejected at registration, not silently truncated).
 */

import {
  DatabaseEnvironmentRegistry,
  classifyStatement,
  statementKeywords,
  type DbAuditSink,
  type DbEnvironment,
} from './database';

/** Least-privilege operation buckets, derived from each statement's first keyword. */
export type DbOperation = 'read' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';

const READ_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'VALUES',
  'SHOW',
  'DESCRIBE',
  'DESC',
]);

/** Map a statement's first keyword to its least-privilege operation bucket. */
export function operationOfKeyword(keyword: string): DbOperation {
  const kw = String(keyword).toUpperCase();
  if (READ_KEYWORDS.has(kw)) return 'read';
  switch (kw) {
    case 'INSERT':
      return 'insert';
    case 'UPDATE':
      return 'update';
    case 'DELETE':
      return 'delete';
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'TRUNCATE':
      return 'ddl';
    default:
      return 'other';
  }
}

/** Operation bucket of every statement in a (possibly multi-statement) string. */
export function extractOperations(sql: string): DbOperation[] {
  const ops = new Set<DbOperation>();
  for (const kw of statementKeywords(sql)) ops.add(operationOfKeyword(kw));
  return [...ops];
}

// ---------------------------------------------------------------------------
// Best-effort table extraction (fail-closed).
// ---------------------------------------------------------------------------

/** Strip `--` line comments, `/* … *\/` block comments, and single-quoted
 * string literals in ONE pass (state machine). Two separate passes would
 * be order-dependent: a quote inside a comment (`/* it's *\/`) or a comment
 * opener inside a string (`'/*'`) would make the other pass eat real SQL —
 * and eating a real table reference is the UNSAFE direction for a
 * whitelist (fewer extracted tables = weaker check). */
function stripNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const IDENT_SRC = '(?:"[^"]*"|`[^`]*`|\\[[^\\]]*\\]|[A-Za-z_][\\w$]*)';
const DOTTED_SRC = IDENT_SRC + '(?:\\s*\\.\\s*' + IDENT_SRC + ')*';
const TABLE_LEAD_RE = new RegExp('\\b(FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE)\\b\\s*(' + DOTTED_SRC + ')', 'gi');
const COMMA_IDENT_RE = new RegExp('^\\s*,\\s*(' + DOTTED_SRC + ')', 'i');

/** Split a possibly schema-qualified name on dots, respecting quoted parts. */
function splitDotted(raw: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      cur += c;
      if (c === quote) {
        if (raw[i + 1] === quote) {
          cur += raw[i + 1];
          i++;
        } else {
          quote = null;
        }
      }
    } else if (c === '"' || c === '`') {
      quote = c;
      cur += c;
    } else if (c === '[') {
      quote = ']';
      cur += c;
    } else if (c === '.') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/** Normalize a table reference: unquote, lowercase, keep schema qualification. */
export function normalizeTableName(raw: string): string {
  return splitDotted(raw)
    .map((p) => {
      let s = p.trim();
      if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
          s = s.slice(1, -1).replace(/""/g, '"');
        } else if (first === '[' && last === ']') {
          s = s.slice(1, -1);
        }
      }
      return s.toLowerCase();
    })
    .join('.');
}

/**
 * Extract referenced table names from SQL (best-effort). Handles
 * FROM/JOIN/INTO/UPDATE/TABLE/TRUNCATE leads, comma-separated lists,
 * subqueries (inner FROMs are caught by the same scan), schema-qualified
 * and quoted names. Comments and string literals are stripped first
 * (single-pass, so neither can hide a real table reference).
 *
 * This is intentionally NOT a full SQL parser: anything exotic it cannot
 * see simply yields fewer names, and the broker fails CLOSED on writes
 * with no determinable target table.
 */
export function extractTables(sql: string): string[] {
  const clean = stripNoise(sql);
  const tables = new Set<string>();
  TABLE_LEAD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_LEAD_RE.exec(clean)) !== null) {
    tables.add(normalizeTableName(m[2]));
    // Comma-separated continuation: FROM a, b, c
    let rest = clean.slice(TABLE_LEAD_RE.lastIndex);
    for (;;) {
      const cm = COMMA_IDENT_RE.exec(rest);
      if (!cm) break;
      tables.add(normalizeTableName(cm[1]));
      rest = rest.slice(cm[0].length);
    }
  }
  return [...tables];
}

// ---------------------------------------------------------------------------
// Privilege policy.
// ---------------------------------------------------------------------------

/**
 * Least-privilege policy bound to one connection at registration time.
 * Ad-hoc broker SQL must pass BOTH checks: every statement's operation
 * bucket is listed in `operations`, and every referenced table is listed
 * in `tables` ('*' permits all tables).
 */
export interface DbPrivilegePolicy {
  connectionName: string;
  operations: DbOperation[];
  tables: string[];
}

export interface PrivilegeCheck {
  ok: boolean;
  reason?: string;
  operations: DbOperation[];
  tables: string[];
}

/** Check ad-hoc SQL against a connection's least-privilege policy. Fail-closed. */
export function checkPrivilege(sql: string, policy: DbPrivilegePolicy): PrivilegeCheck {
  const operations = extractOperations(sql);
  const tables = extractTables(sql);
  const allowedOps = new Set(policy.operations);
  for (const op of operations) {
    if (!allowedOps.has(op)) {
      return {
        ok: false,
        reason:
          `operation '${op}' is not in the least-privilege whitelist for connection ` +
          `"${policy.connectionName}" (allowed: ${policy.operations.join(', ') || 'none'})`,
        operations,
        tables,
      };
    }
  }
  const hasWrite = operations.some((op) => op !== 'read');
  if (hasWrite && tables.length === 0) {
    return {
      ok: false,
      reason:
        `write statement with no determinable target table — refused (fail-closed) ` +
        `on connection "${policy.connectionName}"`,
      operations,
      tables,
    };
  }
  const allowedTables = new Set(policy.tables.map((t) => t.toLowerCase()));
  if (!allowedTables.has('*')) {
    for (const t of tables) {
      if (!allowedTables.has(t)) {
        return {
          ok: false,
          reason: `table "${t}" is not in the least-privilege whitelist for connection "${policy.connectionName}"`,
          operations,
          tables,
        };
      }
    }
  }
  return { ok: true, operations, tables };
}

// ---------------------------------------------------------------------------
// Query engine (host-injected).
// ---------------------------------------------------------------------------

export interface DbQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  durationMs?: number;
}

export interface DbEngineExecuteInput {
  connectionName: string;
  /**
   * SQL text with named `:slot` placeholders. The engine binds `params`
   * itself — values are never interpolated by the broker.
   */
  sql: string;
  params: Record<string, unknown>;
  actor?: string;
}

/**
 * The actual query executor, injected by the host. The broker authorizes;
 * the engine executes. A connection without a registered engine cannot
 * execute anything — the broker refuses loudly instead of faking it.
 */
export interface DbQueryEngine {
  execute(input: DbEngineExecuteInput): Promise<DbQueryResult>;
}

// ---------------------------------------------------------------------------
// Runbook templates.
// ---------------------------------------------------------------------------

export interface RunbookTemplateInput {
  name: string;
  connectionName: string;
  description?: string;
  actor?: string;
  /**
   * SQL with `:slotName` placeholders. Single statement only. Values are
   * NEVER interpolated — the engine binds them.
   */
  sqlTemplate: string;
  /**
   * Declared parameter slots. Must match the template's placeholders
   * EXACTLY: every placeholder declared, every declared placeholder present.
   */
  slots: string[];
}

export interface RunbookTemplate {
  name: string;
  connectionName: string;
  description?: string;
  sqlTemplate: string;
  slots: string[];
  statementKind: 'read' | 'write';
  registeredAt: string;
}

export interface RunbookRunInput {
  templateName: string;
  params: Record<string, unknown>;
  actor?: string;
  prodWriteConfirmed?: boolean;
  previousConnectionName?: string;
}

const SLOT_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `:slot` placeholders, ignoring `::` casts, comments, and string literals. */
function scanPlaceholders(template: string): string[] {
  const bare = stripNoise(template);
  const out = new Set<string>();
  const re = /(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) out.add(m[1]);
  return [...out];
}

/** Only JSON-scalar values may be bound — no objects, arrays, or functions. */
function isScalarParam(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

// ---------------------------------------------------------------------------
// Broker.
// ---------------------------------------------------------------------------

export type DbBrokerCode =
  | 'OK'
  | 'UNKNOWN_CONNECTION'
  | 'UNKNOWN_TEMPLATE'
  | 'GATE_DENIED'
  | 'PRIVILEGE_DENIED'
  | 'PARAM_MISMATCH'
  | 'INVALID_PARAMS'
  | 'NO_ENGINE'
  | 'EXECUTION_FAILED';

export interface DbBrokerExecution {
  /** Authorization (registry gate + privilege/policy checks) passed. */
  allowed: boolean;
  /** The engine actually ran the query. */
  executed: boolean;
  code: DbBrokerCode;
  /** Human-readable reason; denials name what is missing. */
  reason: string;
  connectionName: string;
  environment?: DbEnvironment;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
}

export interface DbBrokerExecuteInput {
  connectionName: string;
  /** Ad-hoc SQL. The broker authorizes it; it never rewrites it. */
  sql: string;
  /** Optional named params, passed through to the engine unbound by us. */
  params?: Record<string, unknown>;
  actor?: string;
  prodWriteConfirmed?: boolean;
  previousConnectionName?: string;
}

export interface DbBrokerOptions {
  now?: () => number;
  auditSink?: DbAuditSink;
}

function isoNow(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

function validName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 128;
}

/**
 * SPEC v2 §33 least-privilege Broker/Runbook. Composes a
 * DatabaseEnvironmentRegistry (the fail-closed gate) with per-connection
 * privilege policies, host-injected query engines, and named runbook
 * templates. Storage-agnostic and dependency-free; audit flows through the
 * injected sink.
 */
export class DbBroker {
  private readonly registry: DatabaseEnvironmentRegistry;
  private readonly policies = new Map<string, DbPrivilegePolicy>();
  private readonly engines = new Map<string, DbQueryEngine>();
  private readonly runbooks = new Map<string, RunbookTemplate>();
  private readonly now?: () => number;
  private readonly auditSink?: DbAuditSink;

  constructor(registry: DatabaseEnvironmentRegistry, opts: DbBrokerOptions = {}) {
    this.registry = registry;
    this.now = opts.now;
    this.auditSink = opts.auditSink;
  }

  private emit(intent: Omit<import('./database').DbAuditIntent, 'at'>): void {
    this.auditSink?.({ ...intent, at: isoNow(this.now) });
  }

  /**
   * Bind least privilege to a connection. The connection must already be
   * registered — privilege without identity is refused.
   */
  setPrivilegePolicy(policy: DbPrivilegePolicy, actor?: string): DbPrivilegePolicy {
    const connection = this.registry.getConnection(policy.connectionName);
    if (!connection) {
      throw new Error(
        `cannot bind privilege policy: unknown database connection "${policy.connectionName}" — ` +
          'register the connection (with its environment identity) first',
      );
    }
    const ops = [...(policy.operations ?? [])];
    const validOps: DbOperation[] = ['read', 'insert', 'update', 'delete', 'ddl', 'other'];
    for (const op of ops) {
      if (!validOps.includes(op)) throw new Error(`invalid operation bucket ${JSON.stringify(op)}`);
    }
    const stored: DbPrivilegePolicy = {
      connectionName: policy.connectionName,
      operations: ops,
      tables: [...(policy.tables ?? [])],
    };
    this.policies.set(policy.connectionName, stored);
    this.emit({
      type: 'DB_BROKER_POLICY_SET',
      connectionName: policy.connectionName,
      environment: connection.environment,
      actor,
      detail: `operations=[${ops.join(',')}] tables=[${stored.tables.join(',')}]`,
    });
    return { ...stored, operations: [...stored.operations], tables: [...stored.tables] };
  }

  getPrivilegePolicy(connectionName: string): DbPrivilegePolicy | undefined {
    const p = this.policies.get(connectionName);
    return p ? { ...p, operations: [...p.operations], tables: [...p.tables] } : undefined;
  }

  /**
   * Register the query engine that actually executes for a connection.
   * The connection must already be registered — execution without
   * identity is refused.
   */
  registerEngine(connectionName: string, engine: DbQueryEngine, actor?: string): void {
    const connection = this.registry.getConnection(connectionName);
    if (!connection) {
      throw new Error(
        `cannot register engine: unknown database connection "${connectionName}" — ` +
          'register the connection (with its environment identity) first',
      );
    }
    if (!engine || typeof engine.execute !== 'function') {
      throw new Error('engine must expose an async execute() function');
    }
    this.engines.set(connectionName, engine);
    this.emit({
      type: 'DB_BROKER_ENGINE_REGISTERED',
      connectionName,
      environment: connection.environment,
      actor,
    });
  }

  deregisterEngine(connectionName: string, actor?: string): boolean {
    if (!this.engines.delete(connectionName)) return false;
    const connection = this.registry.getConnection(connectionName);
    this.emit({
      type: 'DB_BROKER_ENGINE_DEREGISTERED',
      connectionName,
      environment: connection?.environment,
      actor,
    });
    return true;
  }

  hasEngine(connectionName: string): boolean {
    return this.engines.has(connectionName);
  }

  /**
   * Execute ad-hoc SQL: registry gate → privilege whitelist → engine.
   * Every outcome is audited. No engine = loud refusal, never faked.
   */
  async execute(input: DbBrokerExecuteInput): Promise<DbBrokerExecution> {
    const { connectionName } = input;
    const gate = this.registry.authorizeQuery({
      connectionName,
      sql: input.sql,
      prodWriteConfirmed: input.prodWriteConfirmed,
      previousConnectionName: input.previousConnectionName,
      actor: input.actor,
    });
    if (!gate.allowed) {
      const reason = `registry gate refused: ${gate.reason}`;
      this.emit({
        type: 'DB_BROKER_DENIED',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason,
        sql: input.sql,
        allowed: false,
      });
      return {
        allowed: false,
        executed: false,
        code: gate.code === 'UNKNOWN_CONNECTION' ? 'UNKNOWN_CONNECTION' : 'GATE_DENIED',
        reason,
        connectionName,
        environment: gate.environment,
      };
    }

    const policy = this.policies.get(connectionName);
    if (!policy) {
      const reason =
        `no least-privilege policy bound to connection "${connectionName}" — ` +
        'ad-hoc execution requires an explicit policy (setPrivilegePolicy first)';
      this.emit({
        type: 'DB_BROKER_DENIED',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason,
        sql: input.sql,
        allowed: false,
      });
      return { allowed: false, executed: false, code: 'PRIVILEGE_DENIED', reason, connectionName, environment: gate.environment };
    }

    if (input.params !== undefined) {
      const bad = Object.entries(input.params).find(([, v]) => !isScalarParam(v));
      if (bad) {
        const reason = `param "${bad[0]}" must be a scalar (string/number/boolean/null) — objects and functions are refused`;
        this.emit({
          type: 'DB_BROKER_DENIED',
          connectionName,
          environment: gate.environment,
          actor: input.actor,
          reason,
          sql: input.sql,
          allowed: false,
        });
        return { allowed: false, executed: false, code: 'INVALID_PARAMS', reason, connectionName, environment: gate.environment };
      }
    }

    const priv = checkPrivilege(input.sql, policy);
    if (!priv.ok) {
      this.emit({
        type: 'DB_BROKER_DENIED',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason: priv.reason,
        sql: input.sql,
        allowed: false,
        detail: `operations=[${priv.operations.join(',')}] tables=[${priv.tables.join(',')}]`,
      });
      return {
        allowed: false,
        executed: false,
        code: 'PRIVILEGE_DENIED',
        reason: priv.reason!,
        connectionName,
        environment: gate.environment,
      };
    }

    const engine = this.engines.get(connectionName);
    if (!engine) {
      const reason =
        `no query engine registered for connection "${connectionName}" — ` +
        'the broker refuses to pretend it executed anything';
      this.emit({
        type: 'DB_BROKER_NO_ENGINE',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason,
        sql: input.sql,
        allowed: true,
      });
      return { allowed: true, executed: false, code: 'NO_ENGINE', reason, connectionName, environment: gate.environment };
    }

    let result;
    try {
      result = await engine.execute({
        connectionName,
        sql: input.sql,
        params: { ...(input.params ?? {}) },
        actor: input.actor,
      });
    } catch (err) {
      const reason = `query engine failed: ${err instanceof Error ? err.message : String(err)}`;
      this.emit({
        type: 'DB_BROKER_EXECUTION_FAILED',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason,
        sql: input.sql,
        allowed: true,
      });
      return { allowed: true, executed: false, code: 'EXECUTION_FAILED', reason, connectionName, environment: gate.environment };
    }

    this.emit({
      type: 'DB_BROKER_EXECUTED',
      connectionName,
      environment: gate.environment,
      actor: input.actor,
      reason: 'executed',
      sql: input.sql,
      allowed: true,
      rowCount: result.rowCount,
      detail: `durationMs=${result.durationMs ?? '?'}`,
    });
    return {
      allowed: true,
      executed: true,
      code: 'OK',
      reason: `executed on '${gate.environment}' connection "${connectionName}"`,
      connectionName,
      environment: gate.environment,
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }

  /**
   * Register a named runbook template. Registration IS the approval —
   * the template's SQL is fixed, its slots are fixed, its connection is
   * fixed. Placeholders and declared slots must match exactly, and the
   * template must be a single statement.
   */
  registerRunbookTemplate(input: RunbookTemplateInput): RunbookTemplate {
    const { name, connectionName } = input;
    if (!validName(name)) throw new Error(`invalid runbook template name: ${JSON.stringify(name)}`);
    const connection = this.registry.getConnection(connectionName);
    if (!connection) {
      throw new Error(
        `cannot register runbook template "${name}": unknown database connection ` +
          `"${connectionName}" — templates bind to registered connections only`,
      );
    }
    const slots = [...(input.slots ?? [])];
    for (const s of slots) {
      if (!SLOT_IDENT_RE.test(s)) throw new Error(`invalid slot name ${JSON.stringify(s)} — must be an identifier`);
    }
    if (new Set(slots).size !== slots.length) {
      throw new Error(`duplicate slot names in runbook template "${name}"`);
    }
    const keywords = statementKeywords(input.sqlTemplate);
    if (keywords.length !== 1) {
      throw new Error(
        `runbook template "${name}" must be a single statement ` +
          `(got ${keywords.length === 0 ? 'none' : keywords.length}) — multi-statement templates are refused`,
      );
    }
    const placeholders = scanPlaceholders(input.sqlTemplate);
    const declared = new Set(slots);
    for (const p of placeholders) {
      if (!declared.has(p)) {
        throw new Error(
          `runbook template "${name}": placeholder ":${p}" is not a declared slot — declare it or remove it`,
        );
      }
    }
    for (const s of declared) {
      if (!placeholders.includes(s)) {
        throw new Error(`runbook template "${name}": declared slot ":${s}" does not appear in the template`);
      }
    }
    const template: RunbookTemplate = {
      name,
      connectionName,
      description: input.description,
      sqlTemplate: input.sqlTemplate,
      slots,
      statementKind: classifyStatement(input.sqlTemplate),
      registeredAt: isoNow(this.now),
    };
    this.runbooks.set(name, template);
    this.emit({
      type: 'DB_RUNBOOK_REGISTERED',
      connectionName,
      environment: connection.environment,
      actor: input.actor,
      templateName: name,
      sql: input.sqlTemplate,
      detail: `slots=[${slots.join(',')}] kind=${template.statementKind}`,
    });
    return { ...template, slots: [...template.slots] };
  }

  getRunbookTemplate(name: string): RunbookTemplate | undefined {
    const t = this.runbooks.get(name);
    return t ? { ...t, slots: [...t.slots] } : undefined;
  }

  listRunbookTemplates(): RunbookTemplate[] {
    return [...this.runbooks.values()].map((t) => ({ ...t, slots: [...t.slots] }));
  }

  deregisterRunbookTemplate(name: string, actor?: string): boolean {
    const existing = this.runbooks.get(name);
    if (!existing) return false;
    this.runbooks.delete(name);
    const connection = this.registry.getConnection(existing.connectionName);
    this.emit({
      type: 'DB_RUNBOOK_DEREGISTERED',
      connectionName: existing.connectionName,
      environment: connection?.environment,
      actor,
      templateName: name,
    });
    return true;
  }

  /**
   * Run a named template: exact param match (scalar-only) → registry gate
   * → engine. The template is pre-approved at registration, so the ad-hoc
   * operation/table whitelist does NOT apply here — BY DESIGN (the gate
   * still does). The engine receives template + params separately; the
   * broker never interpolates values into SQL.
   */
  async runRunbook(input: RunbookRunInput): Promise<DbBrokerExecution> {
    const template = this.runbooks.get(input.templateName);
    if (!template) {
      const reason = `unknown runbook template "${input.templateName}"`;
      this.emit({
        type: 'DB_RUNBOOK_DENIED',
        connectionName: '',
        actor: input.actor,
        reason,
        templateName: input.templateName,
        allowed: false,
      });
      return {
        allowed: false,
        executed: false,
        code: 'UNKNOWN_TEMPLATE',
        reason,
        connectionName: '',
      };
    }
    const { connectionName } = template;
    const params = input.params ?? {};
    const declared = new Set(template.slots);
    const missing = template.slots.filter((s) => !(s in params));
    const extra = Object.keys(params).filter((k) => !declared.has(k));
    if (missing.length > 0 || extra.length > 0) {
      const reason =
        `params must match declared slots exactly for template "${template.name}"` +
        (missing.length ? ` (missing: ${missing.join(', ')})` : '') +
        (extra.length ? ` (extra: ${extra.join(', ')})` : '');
      this.emit({
        type: 'DB_RUNBOOK_DENIED',
        connectionName,
        actor: input.actor,
        reason,
        templateName: template.name,
        sql: template.sqlTemplate,
        allowed: false,
      });
      return { allowed: false, executed: false, code: 'PARAM_MISMATCH', reason, connectionName };
    }
    for (const [k, v] of Object.entries(params)) {
      if (!isScalarParam(v)) {
        const reason = `param "${k}" must be a scalar (string/number/boolean/null) — objects and functions are refused`;
        this.emit({
          type: 'DB_RUNBOOK_DENIED',
          connectionName,
          actor: input.actor,
          reason,
          templateName: template.name,
          sql: template.sqlTemplate,
          allowed: false,
        });
        return { allowed: false, executed: false, code: 'INVALID_PARAMS', reason, connectionName };
      }
    }

    const gate = this.registry.authorizeQuery({
      connectionName,
      sql: template.sqlTemplate,
      prodWriteConfirmed: input.prodWriteConfirmed,
      previousConnectionName: input.previousConnectionName,
      actor: input.actor,
    });
    if (!gate.allowed) {
      const reason = `registry gate refused: ${gate.reason}`;
      this.emit({
        type: 'DB_RUNBOOK_DENIED',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason,
        templateName: template.name,
        sql: template.sqlTemplate,
        allowed: false,
      });
      return {
        allowed: false,
        executed: false,
        code: 'GATE_DENIED',
        reason,
        connectionName,
        environment: gate.environment,
      };
    }

    const engine = this.engines.get(connectionName);
    if (!engine) {
      const reason =
        `no query engine registered for connection "${connectionName}" — ` +
        'the broker refuses to pretend it executed anything';
      this.emit({
        type: 'DB_RUNBOOK_DENIED',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason,
        templateName: template.name,
        sql: template.sqlTemplate,
        allowed: true,
      });
      return { allowed: true, executed: false, code: 'NO_ENGINE', reason, connectionName, environment: gate.environment };
    }

    let result;
    try {
      result = await engine.execute({
        connectionName,
        sql: template.sqlTemplate,
        params: { ...params },
        actor: input.actor,
      });
    } catch (err) {
      const reason = `query engine failed: ${err instanceof Error ? err.message : String(err)}`;
      this.emit({
        type: 'DB_RUNBOOK_DENIED',
        connectionName,
        environment: gate.environment,
        actor: input.actor,
        reason,
        templateName: template.name,
        sql: template.sqlTemplate,
        allowed: true,
      });
      return { allowed: true, executed: false, code: 'EXECUTION_FAILED', reason, connectionName, environment: gate.environment };
    }

    this.emit({
      type: 'DB_RUNBOOK_EXECUTED',
      connectionName,
      environment: gate.environment,
      actor: input.actor,
      reason: 'executed',
      templateName: template.name,
      sql: template.sqlTemplate,
      allowed: true,
      rowCount: result.rowCount,
      detail: `durationMs=${result.durationMs ?? '?'}`,
    });
    return {
      allowed: true,
      executed: true,
      code: 'OK',
      reason: `runbook "${template.name}" executed on '${gate.environment}' connection "${connectionName}"`,
      connectionName,
      environment: gate.environment,
      rows: result.rows,
      rowCount: result.rowCount,
    };
  }
}
