/**
 * @ai-factory/dbbrowser — database browser core (JetBrains Database tool style).
 *
 * - Query console with a dangerous-statement guard (fail-closed).
 * - Paged/filtered table editor with verified row write-back.
 * - Schema introspection (SQLite via PRAGMA, Postgres via information_schema).
 * - Additive-only schema diff → DDL (destructive items reported, not scripted).
 * - CREATE TABLE DDL generation; foreign-key ER graph export.
 *
 * Postgres support is a minimal wire-protocol client (trust auth, no SSL,
 * simple-query only); it is verified against an in-process protocol stub,
 * not a live server. SQLite is fully supported via node:sqlite.
 */

export type {
  SqlVerdict,
  GuardResult,
  QueryResult,
  DbDriver,
  ColumnDef,
  IndexDef,
  ForeignKeyDef,
  TableDef,
  ViewDef,
  SchemaInfo,
  AddColumnOp,
  DroppedColumnRef,
  SchemaDiff,
  ErNode,
  ErEdge,
  ErGraph,
  TablePageRequest,
  TablePage,
} from './types.js';
export { classifySql, maskSql } from './sql-guard.js';
export { DBBROWSER_MAX_ROWS, SqliteDriver, PostgresDriver, PgAuthRequiredError, PgProtocolError } from './drivers.js';
export type { PgConnectOptions } from './drivers.js';
export {
  quoteIdent,
  introspectSchema,
  createTableDdl,
  addColumnDdl,
  diffSchemas,
  schemaToErGraph,
} from './schema.js';
export { DbBrowser, DbBlockedError, DbNeedsApprovalError } from './browser.js';
export type { DbConnection, DbEnvironment } from './browser.js';
