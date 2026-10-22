/**
 * Schema introspection + diff + DDL generation + ER graph.
 *
 * SQLite is introspected via PRAGMA; Postgres via information_schema.
 * Diff is additive-only for DDL: dropped tables/columns are REPORTED,
 * never emitted as DDL (they require the destructive approval path).
 * Generated DDL is verified executable on an empty database (see tests).
 */

import type {
  AddColumnOp,
  ColumnDef,
  DbDriver,
  DroppedColumnRef,
  ErEdge,
  ErGraph,
  ErNode,
  ForeignKeyDef,
  IndexDef,
  SchemaDiff,
  SchemaInfo,
  TableDef,
  ViewDef,
} from './types.js';

export function quoteIdent(dialect: 'sqlite' | 'postgres', name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function lit(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
}

async function sqliteTables(driver: DbDriver): Promise<TableDef[]> {
  const tables: TableDef[] = [];
  const list = await driver.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  for (const r of list.rows) {
    const name = String(r['name']);
    const cols = await driver.query(`PRAGMA table_info(${quoteIdent('sqlite', name)})`);
    const columns: ColumnDef[] = cols.rows.map((c) => ({
      name: String(c['name']),
      type: String(c['type'] ?? ''),
      notNull: Number(c['notnull'] ?? 0) === 1,
      pk: Number(c['pk'] ?? 0),
      defaultValue: c['dflt_value'] === null || c['dflt_value'] === undefined ? null : String(c['dflt_value']),
    }));
    const idxList = await driver.query(`PRAGMA index_list(${quoteIdent('sqlite', name)})`);
    const indexes: IndexDef[] = [];
    for (const ix of idxList.rows) {
      const ixName = String(ix['name']);
      const info = await driver.query(`PRAGMA index_info(${quoteIdent('sqlite', ixName)})`);
      const ixCols = info.rows
        .slice()
        .sort((a, b) => Number(a['seqno']) - Number(b['seqno']))
        .map((x) => String(x['name']));
      indexes.push({ name: ixName, unique: Number(ix['unique'] ?? 0) === 1, columns: ixCols });
    }
    const fkList = await driver.query(`PRAGMA foreign_key_list(${quoteIdent('sqlite', name)})`);
    const foreignKeys: ForeignKeyDef[] = fkList.rows.map((f) => ({
      column: String(f['from']),
      refTable: String(f['table']),
      refColumn: String(f['to']),
    }));
    tables.push({ name, columns, indexes, foreignKeys });
  }
  return tables;
}

async function sqliteViews(driver: DbDriver): Promise<ViewDef[]> {
  const list = await driver.query(`SELECT name, sql FROM sqlite_master WHERE type='view' ORDER BY name`);
  return list.rows.map((r) => ({ name: String(r['name']), sql: r['sql'] == null ? null : String(r['sql']) }));
}

async function postgresTables(driver: DbDriver): Promise<TableDef[]> {
  const tables: TableDef[] = [];
  const list = await driver.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
  );
  for (const r of list.rows) {
    const name = String(r['table_name']);
    const cols = await driver.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='${name.replace(/'/g, "''")}' ORDER BY ordinal_position`,
    );
    const pkCols = await driver.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name WHERE tc.table_schema='public' AND tc.table_name='${name.replace(/'/g, "''")}' AND tc.constraint_type='PRIMARY KEY' ORDER BY kcu.ordinal_position`,
    );
    const pkOrder = new Map<string, number>();
    pkCols.rows.forEach((p, i) => pkOrder.set(String(p['column_name']), i + 1));
    const columns: ColumnDef[] = cols.rows.map((c) => ({
      name: String(c['column_name']),
      type: String(c['data_type'] ?? ''),
      notNull: String(c['is_nullable']) === 'NO',
      pk: pkOrder.get(String(c['column_name'])) ?? 0,
      defaultValue: c['column_default'] == null ? null : String(c['column_default']),
    }));
    const fks = await driver.query(
      `SELECT kcu.column_name AS col, ccu.table_name AS ref_table, ccu.column_name AS ref_col FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name WHERE tc.table_schema='public' AND tc.table_name='${name.replace(/'/g, "''")}' AND tc.constraint_type='FOREIGN KEY'`,
    );
    const foreignKeys: ForeignKeyDef[] = fks.rows.map((f) => ({
      column: String(f['col']),
      refTable: String(f['ref_table']),
      refColumn: String(f['ref_col']),
    }));
    tables.push({ name, columns, indexes: [], foreignKeys });
  }
  return tables;
}

export async function introspectSchema(driver: DbDriver): Promise<SchemaInfo> {
  const dialect = driver.kind;
  if (dialect === 'sqlite') {
    return { dialect, tables: await sqliteTables(driver), views: await sqliteViews(driver) };
  }
  return { dialect, tables: await postgresTables(driver), views: [] };
}

/** CREATE TABLE DDL for one table. Column/constraint quoting is deterministic. */
export function createTableDdl(dialect: 'sqlite' | 'postgres', table: TableDef): string {
  const q = (n: string) => quoteIdent(dialect, n);
  const colSql = table.columns.map((c) => {
    let s = `${q(c.name)}${c.type ? ' ' + c.type : ''}`;
    if (c.notNull) s += ' NOT NULL';
    if (c.defaultValue !== null) s += ` DEFAULT ${c.defaultValue}`;
    return s;
  });
  const pkCols = table.columns
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => q(c.name));
  if (pkCols.length > 0) colSql.push(`PRIMARY KEY (${pkCols.join(', ')})`);
  for (const fk of table.foreignKeys) {
    colSql.push(`FOREIGN KEY (${q(fk.column)}) REFERENCES ${q(fk.refTable)} (${q(fk.refColumn)})`);
  }
  const lines = [`CREATE TABLE ${q(table.name)} (`, `  ${colSql.join(',\n  ')}`, `);`];
  const idx: string[] = [];
  for (const ix of table.indexes) {
    if (ix.name.startsWith('sqlite_autoindex_')) continue; // implicit pk/unique index
    idx.push(
      `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${q(table.name)} (${ix.columns.map(q).join(', ')});`,
    );
  }
  return [...lines, ...idx].join('\n');
}

export function addColumnDdl(dialect: 'sqlite' | 'postgres', table: string, column: ColumnDef): string {
  const q = (n: string) => quoteIdent(dialect, n);
  let s = `ALTER TABLE ${q(table)} ADD COLUMN ${q(column.name)}${column.type ? ' ' + column.type : ''}`;
  if (column.notNull) s += ' NOT NULL';
  if (column.defaultValue !== null) s += ` DEFAULT ${column.defaultValue}`;
  return s + ';';
}

/** Diff source → target: statements needed to bring target up to source's shape. */
export function diffSchemas(source: SchemaInfo, target: SchemaInfo): SchemaDiff {
  const dialect = source.dialect;
  const sMap = new Map(source.tables.map((t) => [t.name, t]));
  const tMap = new Map(target.tables.map((t) => [t.name, t]));
  const addTables: TableDef[] = [];
  const addColumns: AddColumnOp[] = [];
  const droppedTables: string[] = [];
  const droppedColumns: DroppedColumnRef[] = [];
  const ddl: string[] = [];
  const notes: string[] = [];

  for (const [name, st] of sMap) {
    const tt = tMap.get(name);
    if (!tt) {
      addTables.push(st);
      ddl.push(createTableDdl(dialect, st));
      continue;
    }
    const tCols = new Map(tt.columns.map((c) => [c.name, c]));
    for (const c of st.columns) {
      if (!tCols.has(c.name)) {
        addColumns.push({ table: name, column: c });
        ddl.push(addColumnDdl(dialect, name, c));
      }
    }
    const sCols = new Set(st.columns.map((c) => c.name));
    for (const c of tt.columns) {
      if (!sCols.has(c.name)) droppedColumns.push({ table: name, column: c.name });
    }
  }
  for (const name of tMap.keys()) {
    if (!sMap.has(name)) droppedTables.push(name);
  }
  if (droppedTables.length > 0 || droppedColumns.length > 0) {
    notes.push(
      `Destructive items are reported, not scripted: dropped tables [${droppedTables.join(', ')}]; ` +
        `dropped columns [${droppedColumns.map((d) => `${d.table}.${d.column}`).join(', ')}]. ` +
        'Apply them through the destructive approval path.',
    );
  }
  if (source.dialect !== target.dialect) {
    notes.push(`Dialect mismatch (source ${source.dialect}, target ${target.dialect}); DDL emitted in ${dialect}.`);
  }
  return { addTables, addColumns, droppedTables, droppedColumns, ddl, notes };
}

/** Foreign-key topology → node/edge lists (rendered by the desktop panel). */
export function schemaToErGraph(schema: SchemaInfo): ErGraph {
  const nodes: ErNode[] = schema.tables.map((t) => ({
    id: t.name,
    label: t.name,
    columns: t.columns.map((c) => c.name),
    pk: t.columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name),
  }));
  const edges: ErEdge[] = [];
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      edges.push({ from: t.name, to: fk.refTable, label: `${fk.column} → ${fk.refColumn}` });
    }
  }
  return { nodes, edges };
}

export { lit as ddlLit };
