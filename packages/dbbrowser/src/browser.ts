/**
 * DbBrowser — session-scoped orchestrator for the database browser.
 *
 * A connection binds a driver to an environment identity ('dev' |
 * 'staging' | 'prod'). Writes run on dev/test connections only; any
 * write against a prod connection is refused (PROD_WRITE_REFUSED) and
 * the operator is pointed at the time-travel promote path. Destructive
 * statements never run inline — the browser throws DbNeedsApprovalError
 * and the route turns it into an approval ticket.
 *
 * Table editor reads go through pageTable (LIMIT/OFFSET, ORDER BY,
 * filters — identifiers validated against the live schema, values bound
 * as parameters). Row updates go through updateRow (UPDATE .. WHERE pk,
 * then the row is re-read and returned — the write is verified, not
 * assumed).
 */

import { createHash } from 'node:crypto';
import { classifySql } from './sql-guard.js';
import { PostgresDriver, SqliteDriver } from './drivers.js';
import { createTableDdl, diffSchemas, introspectSchema, schemaToErGraph } from './schema.js';
import type {
  DbDriver,
  ErGraph,
  QueryResult,
  SchemaDiff,
  SchemaInfo,
  SqlVerdict,
  TableDef,
  TablePage,
  TablePageRequest,
} from './types.js';

export type DbEnvironment = 'dev' | 'staging' | 'prod';

export interface DbConnection {
  name: string;
  driver: DbDriver;
  env: DbEnvironment;
}

export class DbBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DbBlockedError';
    this.code = code;
  }
}

export class DbNeedsApprovalError extends Error {
  readonly code = 'DBB_APPROVAL_REQUIRED';
  constructor(
    readonly connectionName: string,
    readonly sql: string,
    message: string,
  ) {
    super(message);
    this.name = 'DbNeedsApprovalError';
  }
  /** Binds the approval ticket to this exact statement (sha256). */
  sqlDigest(): string {
    return createHash('sha256').update(this.sql, 'utf8').digest('hex');
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateIdent(v: string, what: string): string {
  if (!IDENT_RE.test(v)) throw new DbBlockedError('BAD_IDENTIFIER', `${what} "${v}" is not a safe identifier.`);
  return v;
}

/** Loose equality for the write-verification re-read (SQLite type affinities). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a == b;
  return String(a) === String(b);
}

export class DbBrowser {
  private readonly connections = new Map<string, DbConnection>();

  listConnections(): Array<{ name: string; kind: DbDriver['kind']; env: DbEnvironment }> {
    return [...this.connections.values()].map((c) => ({ name: c.name, kind: c.driver.kind, env: c.env }));
  }

  registerSqlite(name: string, filePath: string, env: DbEnvironment, readOnly = false): DbConnection {
    validateIdent(name, 'connection name');
    const conn: DbConnection = { name, driver: new SqliteDriver(name, filePath, readOnly), env };
    this.connections.set(name, conn);
    return conn;
  }

  registerPostgres(
    name: string,
    opts: { host: string; port: number; user: string; database: string },
    env: DbEnvironment,
  ): DbConnection {
    validateIdent(name, 'connection name');
    const conn: DbConnection = { name, driver: new PostgresDriver(name, opts), env };
    this.connections.set(name, conn);
    return conn;
  }

  get(name: string): DbConnection {
    const c = this.connections.get(name);
    if (!c) throw new DbBlockedError('UNKNOWN_CONNECTION', `Unknown db-browser connection "${name}".`);
    return c;
  }

  async deregister(name: string): Promise<void> {
    const c = this.connections.get(name);
    if (!c) throw new DbBlockedError('UNKNOWN_CONNECTION', `Unknown db-browser connection "${name}".`);
    await c.driver.close();
    this.connections.delete(name);
  }

  private verdictOf(sql: string): { verdict: SqlVerdict; reason: string; keyword: string; message: string } {
    return classifySql(sql);
  }

  /** Query console: one statement, guard-verdict driven. */
  async query(connectionName: string, sql: string, actor: string): Promise<{ verdict: SqlVerdict; result: QueryResult }> {
    const conn = this.get(connectionName);
    const g = this.verdictOf(sql);
    if (g.verdict === 'blocked') {
      throw new DbBlockedError(g.reason, g.message);
    }
    if (g.verdict === 'destructive') {
      throw new DbNeedsApprovalError(connectionName, sql.trim(), `${g.message} (connection "${connectionName}")`);
    }
    if (g.verdict === 'write' && conn.env === 'prod') {
      throw new DbBlockedError(
        'PROD_WRITE_REFUSED',
        `Refusing to write to prod connection "${connectionName}". The only prod write path is /api/db-time-travel/promote.`,
      );
    }
    void actor;
    const result = await conn.driver.query(sql.trim());
    return { verdict: g.verdict, result };
  }

  async tables(connectionName: string): Promise<Array<{ name: string; type: 'table' | 'view' }>> {
    const schema = await introspectSchema(this.get(connectionName).driver);
    return [
      ...schema.tables.map((t) => ({ name: t.name, type: 'table' as const })),
      ...schema.views.map((v) => ({ name: v.name, type: 'view' as const })),
    ];
  }

  async schema(connectionName: string): Promise<SchemaInfo> {
    return introspectSchema(this.get(connectionName).driver);
  }

  async pageTable(connectionName: string, table: string, req: TablePageRequest): Promise<TablePage> {
    const conn = this.get(connectionName);
    const t = validateIdent(table, 'table');
    const schema = await introspectSchema(conn.driver);
    const def = schema.tables.find((x) => x.name === t) ?? null;
    if (!def) throw new DbBlockedError('UNKNOWN_TABLE', `Table "${t}" not found on connection "${connectionName}".`);
    const colSet = new Set(def.columns.map((c) => c.name));

    const page = Math.max(1, Math.floor(req.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Math.floor(req.pageSize) || 50));
    const where: string[] = [];
    const values: unknown[] = [];
    for (const f of req.filters ?? []) {
      if (!colSet.has(f.column)) throw new DbBlockedError('BAD_FILTER', `Unknown column "${f.column}" on table "${t}".`);
      const op = { eq: '=', like: 'LIKE', gt: '>', lt: '<', gte: '>=', lte: '<=' }[f.op] ?? '=';
      where.push(`"${f.column.replace(/"/g, '""')}" ${op} ?`);
      values.push(f.value);
    }
    let order = '';
    if (req.orderBy) {
      if (!colSet.has(req.orderBy)) throw new DbBlockedError('BAD_ORDER', `Unknown column "${req.orderBy}" on table "${t}".`);
      order = ` ORDER BY "${req.orderBy.replace(/"/g, '""')}" ${req.orderDir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const count = await conn.driver.query(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"${whereSql}`, values);
    const totalRows = Number(count.rows[0]?.['n'] ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const offset = (page - 1) * pageSize;
    const data = await conn.driver.query(
      `SELECT * FROM "${t.replace(/"/g, '""')}"${whereSql}${order} LIMIT ? OFFSET ?`,
      [...values, pageSize, offset],
    );
    return {
      table: t,
      columns: data.columns,
      rows: data.rows,
      page,
      pageSize,
      totalRows,
      totalPages,
    };
  }

  /**
   * Row update: UPDATE .. WHERE pk = .., then re-read the row and return
   * it — the write is verified against the database, not assumed.
   */
  async updateRow(
    connectionName: string,
    table: string,
    pk: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<{ row: Record<string, unknown> | null; changes: number }> {
    const conn = this.get(connectionName);
    if (conn.env === 'prod') {
      throw new DbBlockedError(
        'PROD_WRITE_REFUSED',
        `Refusing to write to prod connection "${connectionName}". The only prod write path is /api/db-time-travel/promote.`,
      );
    }
    const t = validateIdent(table, 'table');
    const schema = await introspectSchema(conn.driver);
    const def: TableDef | null = schema.tables.find((x) => x.name === t) ?? null;
    if (!def) throw new DbBlockedError('UNKNOWN_TABLE', `Table "${t}" not found on connection "${connectionName}".`);
    const colSet = new Set(def.columns.map((c) => c.name));
    const pkNames = Object.keys(pk);
    if (pkNames.length === 0) throw new DbBlockedError('PK_REQUIRED', 'Row update requires a primary-key predicate.');
    for (const k of [...pkNames, ...Object.keys(patch)]) {
      if (!colSet.has(k)) throw new DbBlockedError('BAD_COLUMN', `Unknown column "${k}" on table "${t}".`);
    }
    const setSql = Object.keys(patch)
      .map((k) => `"${k.replace(/"/g, '""')}" = ?`)
      .join(', ');
    if (!setSql) throw new DbBlockedError('EMPTY_PATCH', 'Nothing to update.');
    const whereSql = pkNames.map((k) => `"${k.replace(/"/g, '""')}" = ?`).join(' AND ');
    const values = [...Object.values(patch), ...pkNames.map((k) => pk[k])];
    const exec = await conn.driver.exec(`UPDATE "${t.replace(/"/g, '""')}" SET ${setSql} WHERE ${whereSql}`, values);
    // Re-read to verify — the write is checked against the database, not assumed.
    const check = await conn.driver.query(
      `SELECT * FROM "${t.replace(/"/g, '""')}" WHERE ${whereSql} LIMIT 1`,
      pkNames.map((k) => pk[k]),
    );
    const row = check.rows[0] ?? null;
    if (!row) {
      throw new DbBlockedError('ROW_NOT_FOUND_AFTER_UPDATE', 'No row matched the pk after update; nothing was written.');
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!valuesEqual(row[k], v)) {
        throw new DbBlockedError(
          'WRITE_NOT_VERIFIED',
          `Row re-read after update does not show the patched value for "${k}"; refusing to report success.`,
        );
      }
    }
    return { row, changes: exec.changes };
  }

  async diff(sourceName: string, targetName: string): Promise<SchemaDiff> {
    const s = await this.schema(sourceName);
    const t = await this.schema(targetName);
    return diffSchemas(s, t);
  }

  async ddlFor(connectionName: string, table?: string): Promise<{ ddl: string }> {
    const schema = await this.schema(connectionName);
    if (table) {
      const def = schema.tables.find((x) => x.name === table);
      if (!def) throw new DbBlockedError('UNKNOWN_TABLE', `Table "${table}" not found.`);
      return { ddl: createTableDdl(schema.dialect, def) };
    }
    return {
      ddl: schema.tables.map((t) => createTableDdl(schema.dialect, t)).join('\n\n'),
    };
  }

  async erGraph(connectionName: string): Promise<ErGraph> {
    return schemaToErGraph(await this.schema(connectionName));
  }
}
