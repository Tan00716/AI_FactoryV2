/**
 * Shared types for @ai-factory/dbbrowser.
 *
 * Honest boundary (stated at the top, not buried): the Postgres driver
 * speaks a minimal subset of the PostgreSQL wire protocol (startup +
 * simple-query, trust auth only, no SSL, no prepared statements). It is
 * verified against an in-process protocol stub, NOT a live server —
 * there is no postgres server in the dev environment.
 */

/** SQL statement classification from the dangerous-statement guard. */
export type SqlVerdict = 'read' | 'write' | 'destructive' | 'blocked';

export interface GuardResult {
  verdict: SqlVerdict;
  /** Machine-readable reason code, e.g. 'DELETE_WITHOUT_WHERE'. */
  reason: string;
  /** Upper-cased leading keyword of the statement. */
  keyword: string;
  /** Human-readable one-liner. */
  message: string;
}

/** A driver-independent query result. Values are JSON-safe scalars. */
export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when rows were capped by the driver's row limit. */
  truncated: boolean;
  durationMs: number;
  /** Rows changed (write statements only). */
  changes?: number;
}

/** Minimal driver contract: open, run, close. */
export interface DbDriver {
  readonly name: string;
  readonly kind: 'sqlite' | 'postgres';
  /** Execute one statement; params are positional (?) or named (:name). */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** Execute one statement, returning only the change count. */
  exec(sql: string, params?: unknown[]): Promise<{ changes: number; durationMs: number }>;
  close(): Promise<void>;
}

export interface ColumnDef {
  name: string;
  /** Declared type as written (may be '' on SQLite). */
  type: string;
  notNull: boolean;
  /** 1-based position inside the PRIMARY KEY, 0 = not in pk. */
  pk: number;
  defaultValue: string | null;
}

export interface IndexDef {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface ForeignKeyDef {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
}

export interface ViewDef {
  name: string;
  sql: string | null;
}

export interface SchemaInfo {
  dialect: 'sqlite' | 'postgres';
  tables: TableDef[];
  views: ViewDef[];
}

export interface AddColumnOp {
  table: string;
  column: ColumnDef;
}

export interface DroppedColumnRef {
  table: string;
  column: string;
}

/**
 * Schema diff result. Destructive items (dropped tables/columns) are
 * REPORTED but never rendered into DDL — applying them requires the
 * destructive path (approval), not a generated migration script.
 */
export interface SchemaDiff {
  addTables: TableDef[];
  addColumns: AddColumnOp[];
  droppedTables: string[];
  droppedColumns: DroppedColumnRef[];
  /** Non-destructive DDL only. */
  ddl: string[];
  notes: string[];
}

export interface ErNode {
  id: string;
  label: string;
  columns: string[];
  pk: string[];
}

export interface ErEdge {
  from: string;
  to: string;
  label: string;
}

export interface ErGraph {
  nodes: ErNode[];
  edges: ErEdge[];
}

export interface TablePageRequest {
  page: number;
  pageSize: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  /** AND-combined filters. Column names are validated against the schema. */
  filters?: Array<{ column: string; op: 'eq' | 'like' | 'gt' | 'lt' | 'gte' | 'lte'; value: unknown }>;
}

export interface TablePage {
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
}
