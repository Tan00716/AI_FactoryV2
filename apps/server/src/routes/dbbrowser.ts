/**
 * DB browser routes (round-4 task A5) — JetBrains Database tool style.
 *
 *   GET    /api/db-browser/connections                    list (viewer)
 *   POST   /api/db-browser/connections                    register (operator)
 *            {name, kind:'sqlite', path, env?} | {name, kind:'postgres', host, port, user, database, env?}
 *   DELETE /api/db-browser/connections/:name              deregister (operator)
 *   GET    /api/db-browser/drivers                        driver catalog (viewer)
 *   GET    /api/db-browser/connections/meta               meta + active (viewer)
 *   GET    /api/db-browser/active                         active connection (viewer)
 *   POST   /api/db-browser/active                         {name} (operator)
 *   POST   /api/db-browser/connections/:name/write-mode   {enabled, confirm} (operator)
 *   GET    /api/db-browser/history[?connection=&favoritesOnly=1] (viewer)
 *   POST   /api/db-browser/history/:id/rerun              (operator)
 *   POST   /api/db-browser/history/:id/favorite           {favorite} (operator)
 *   DELETE /api/db-browser/history/:id                    (operator)
 *   DELETE /api/db-browser/history[?connection=]          (operator)
 *   POST   /api/db-browser/query                          query console (operator)
 *            {connection, sql} -> {verdict, result} | {approvalRequired, reason}
 *   GET    /api/db-browser/tables?connection=             (viewer)
 *   GET    /api/db-browser/table?connection=&name=&page=&pageSize=&orderBy=&orderDir=&filter=
 *   PUT    /api/db-browser/row                            {connection, table, pk, patch} (operator)
 *   GET    /api/db-browser/schema?connection=             (viewer)
 *   POST   /api/db-browser/schema/diff                    {source, target} (viewer)
 *   GET    /api/db-browser/ddl?connection=[&table=]       (viewer)
 *   GET    /api/db-browser/er?connection=                 (viewer)
 *   POST   /api/db-browser/destructive/request            {connection, sql} -> {ticketId} (operator)
 *   POST   /api/db-browser/destructive/approve            {ticketId, decided_by} (operator)
 *   POST   /api/db-browser/destructive/execute            {ticketId, connection, sql} (operator)
 *
 * Destructive statements never run inline. /destructive/request mints a
 * single-use ticket (15min TTL) bound to the exact statement sha256 and
 * connection; /destructive/approve moves it pending -> approved with an
 * explicit decider identity; /destructive/execute runs it once.
 * Why not /api/approvals: the approval store requires task_id FK to an
 * existing task; a db-browser destructive ticket is not task-bound, so it
 * runs its own audited ticket lifecycle instead (documented, not hidden).
 *
 * Audit: DBB_CONNECTION_REGISTERED / DBB_CONNECTION_REMOVED /
 * DBB_WRITE / DBB_ROW_UPDATED / DBB_DESTRUCTIVE_REQUESTED /
 * DBB_DESTRUCTIVE_APPROVED / DBB_DESTRUCTIVE_EXECUTED /
 * DBB_WRITE_MODE_CHANGED / DBB_ACTIVE_CHANGED / DBB_HISTORY_RERUN /
 * DBB_HISTORY_CLEARED. Read-only console queries are not audited
 * (they are recorded in query history instead, without audit details).
 *
 * RBAC: default prefix rule gives GET -> viewer, others -> operator.
 *
 * R7-#8 multi-connection notes (on top of R4-A5):
 *  - Write mode is OFF by default for every connection: write-verdict
 *    statements are refused with WRITE_MODE_DISABLED until the operator
 *    enables write mode with confirm: true. Prod can never enable it.
 *  - Query history lives in <dataDir>/db-history.json (atomic write,
 *    500 entries, SQL truncated at 4000 chars). Audit events for
 *    history actions carry entry ids and counts, never SQL text.
 *  - Passwords are never accepted, stored, logged, or audited: Postgres
 *    uses trust auth only, so there is no password field; any
 *    password-like key in a request body is ignored and scrubbed from
 *    audit details by stripSecretFields().
 *
 * HONEST BOUNDARIES (also rendered in the UI):
 *  - Postgres driver is a minimal wire-protocol client (trust auth, no
 *    SSL, simple-query only); verified against a protocol stub, not a
 *    live server.
 *  - SQLite PRAGMA-based introspection; generated DDL is SQLite dialect.
 *  - Schema diff DDL is additive-only; drops are reported, not scripted.
 *  - Connections are session-scoped: a server restart drops them.
 *    Query history survives restarts (data-dir file); connection names
 *    in old entries may dangle after a restart (rerun -> 404).
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  DRIVER_CATALOG,
  DbBlockedError,
  DbBrowser,
  DbNeedsApprovalError,
  HistoryCorruptError,
  MultiConnectionManager,
  QueryHistory,
  classifySql,
  driverInfo,
  stripSecretFields,
  type DbEnvironment,
  type HistoryVerdict,
  type QueryResult,
} from '@ai-factory/dbbrowser';
import type { RouteContext } from './context';

const PREFIX = '/api/db-browser';

/** One browser per process (session-scoped connections). */
let browser: DbBrowser | null = null;
export function dbBrowser(): DbBrowser {
  if (!browser) browser = new DbBrowser();
  return browser;
}

/** R7-#8: connection metadata moves with the browser (same session scope). */
let connMeta: MultiConnectionManager | null = null;
function meta(): MultiConnectionManager {
  if (!connMeta) connMeta = new MultiConnectionManager();
  return connMeta;
}
/** R7-#8: query history, one store per data dir (file-backed). */
let historyStore: QueryHistory | null = null;
let historyDir = '';
function historyOf(dataDir: string): QueryHistory {
  if (!historyStore || historyDir !== dataDir) {
    historyStore = new QueryHistory({ filePath: join(dataDir, 'db-history.json') });
    historyDir = dataDir;
  }
  return historyStore;
}

/** Test seam. */
export function setDbBrowser(b: DbBrowser | null): void {
  browser = b;
  connMeta = null;
  historyStore = null;
  historyDir = '';
}

/**
 * R7-#8 write gate, shared by /query and /history/:id/rerun.
 * If the browser knows a connection the meta registry does not (e.g. a
 * seam-injected browser), meta is backfilled from the browser so the
 * gate never 404s a live connection.
 */
function writeGate(connection: string, sql: string): void {
  const g = classifySql(sql);
  if (g.verdict !== 'write') return;
  const m = meta();
  if (!m.has(connection)) {
    const c = dbBrowser().get(connection); // UNKNOWN_CONNECTION when truly unknown
    m.register(connection, c.driver.kind, c.env, c.env === 'prod');
  }
  m.assertWriteAllowed(m.get(connection), 'write');
}

/** Execute one console statement through the write gate + browser guard. */
async function executeConsole(
  connection: string,
  sql: string,
  actor: string,
): Promise<{ verdict: 'read' | 'write' | 'destructive' | 'blocked'; result: QueryResult }> {
  writeGate(connection, sql);
  return dbBrowser().query(connection, sql, actor);
}

/** Best-effort history recording: history must never break a query. */
function recordHistory(
  dataDir: string,
  input: { connection: string; sql: string; verdict: HistoryVerdict; ok: boolean; errorCode?: string | null; rowCount?: number | null; durationMs?: number | null },
): void {
  try {
    historyOf(dataDir).record(input);
  } catch {
    // Corrupt history file stays corrupt (fail-closed) and queries keep working.
  }
}

interface DestructiveTicket {
  ticketId: string;
  connection: string;
  sql: string;
  sqlSha256: string;
  status: 'pending' | 'approved' | 'consumed';
  requestedBy: string;
  decidedBy: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Destructive tickets: session-scoped, single-use, 15min TTL. */
const destructiveTickets = new Map<string, DestructiveTicket>();
const TICKET_TTL_MS = 15 * 60 * 1000;

function getTicket(id: string): DestructiveTicket | null {
  const t = destructiveTickets.get(id);
  if (!t) return null;
  if (Date.now() > t.expiresAt) {
    destructiveTickets.delete(id);
    return null;
  }
  return t;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function strOf(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

function intOf(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function dataDirOf(ctx: RouteContext): string {
  // AI_FACTORY_DATA_DIR is the documented override; fall back to cwd/data.
  const env = (process.env['AI_FACTORY_DATA_DIR'] ?? '').trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'data');
}

/** Jail a sqlite path inside the data dir; returns the resolved path. */
function jailSqlitePath(raw: string, dataDir: string): string {
  if (raw === ':memory:') return raw;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(dataDir, raw);
  if (abs !== dataDir && !abs.startsWith(dataDir + sep)) {
    throw new DbBlockedError('PATH_ESCAPED', `sqlite path escapes the data dir (${dataDir}); refused.`);
  }
  return abs;
}

function envOf(v: unknown): DbEnvironment {
  return v === 'staging' || v === 'prod' ? v : 'dev';
}

function actorOf(body: Record<string, unknown>): string {
  const a = body['actor'];
  return typeof a === 'string' && a.length > 0 ? a : 'human';
}

function errBody(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof DbNeedsApprovalError) {
    return {
      status: 403,
      body: { error: e.message, code: e.code, approvalRequired: true, connection: e.connectionName },
    };
  }
  if (e instanceof DbBlockedError) {
    const status = e.code === 'UNKNOWN_CONNECTION' || e.code === 'UNKNOWN_TABLE' ? 404 : 403;
    return { status, body: { error: e.message, code: e.code } };
  }
  throw e;
}

export async function handleDbBrowserRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const p = url.pathname;
  if (p !== PREFIX && !p.startsWith(PREFIX + '/')) return false;
  const rest = p.slice(PREFIX.length);
  const b = dbBrowser();
  const dataDir = dataDirOf(ctx);

  // ------------------------------------------------------------ connections
  if (rest === '/connections' && method === 'GET') {
    ctx.json(res, 200, { connections: b.listConnections() });
    return true;
  }

  if (rest === '/connections' && method === 'POST') {
    const body = await ctx.readBody(req);
    const name = strOf(body['name'], 64);
    if (!name) return ctx.json(res, 400, { error: 'name is required (<=64 chars)', code: 'BAD_NAME' }), true;
    const kind = body['kind'];
    const env = envOf(body['env']);
    const actor = actorOf(body);
    try {
      if (kind === 'sqlite') {
        const rawPath = strOf(body['path'], 512);
        if (!rawPath) return ctx.json(res, 400, { error: 'path is required for sqlite', code: 'BAD_PATH' }), true;
        const filePath = jailSqlitePath(rawPath, dataDir);
        if (env === 'prod' && filePath !== ':memory:' && !existsSync(filePath)) {
          // Fail-closed: a prod connection must point at a real database;
          // a read-only open of a missing file would 500 on first query.
          return ctx.json(res, 404, {
            error: `prod sqlite file not found: ${rawPath}`,
            code: 'PROD_DB_NOT_FOUND',
          }), true;
        }
        b.registerSqlite(name, filePath, env, env === 'prod');
        meta().register(name, 'sqlite', env, env === 'prod');
        ctx.audit.record('db-browser', 'DBB_CONNECTION_REGISTERED', 'db-connection', name, stripSecretFields({
          kind: 'sqlite',
          env,
          path: filePath,
          actor,
        }) as Record<string, unknown>);
        return ctx.json(res, 201, { name, kind: 'sqlite', env }), true;
      }
      if (kind === 'postgres') {
        const host = strOf(body['host'], 253) ?? '127.0.0.1';
        const port = intOf(body['port'], 5432);
        const user = strOf(body['user'], 128);
        const database = strOf(body['database'], 128);
        if (!user || !database) {
          return ctx.json(res, 400, { error: 'user and database are required for postgres', code: 'BAD_PG' }), true;
        }
        b.registerPostgres(name, { host, port, user, database }, env);
        meta().register(name, 'postgres', env, env === 'prod');
        ctx.audit.record('db-browser', 'DBB_CONNECTION_REGISTERED', 'db-connection', name, stripSecretFields({
          kind: 'postgres',
          env,
          host,
          port,
          user,
          database,
          actor,
        }) as Record<string, unknown>);
        return ctx.json(res, 201, { name, kind: 'postgres', env }), true;
      }
      // R7-#8: unavailable kinds get an honest reason, not a generic BAD_KIND.
      const info = typeof kind === 'string' ? driverInfo(kind) : null;
      if (info && !info.available) {
        return ctx.json(res, 400, { error: info.note, code: 'DRIVER_UNAVAILABLE', kind }), true;
      }
      return ctx.json(res, 400, { error: "kind must be 'sqlite'|'postgres'", code: 'BAD_KIND' }), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest.startsWith('/connections/') && method === 'DELETE') {
    const name = decodeURIComponent(rest.slice('/connections/'.length));
    try {
      await b.deregister(name);
      meta().remove(name);
      ctx.audit.record('db-browser', 'DBB_CONNECTION_REMOVED', 'db-connection', name, { actor: actorOf({}) });
      return ctx.json(res, 200, { ok: true }), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  // ------------------------------------------------------------ R7-#8 multi-connection
  if (rest === '/drivers' && method === 'GET') {
    ctx.json(res, 200, { drivers: DRIVER_CATALOG });
    return true;
  }

  if (rest === '/connections/meta' && method === 'GET') {
    const m = meta();
    ctx.json(res, 200, {
      active: m.activeNameOnly(),
      connections: m.list().map((c) => ({ ...c, driverNote: driverInfo(c.kind)?.note ?? '' })),
    });
    return true;
  }

  if (rest === '/active' && method === 'GET') {
    ctx.json(res, 200, { active: meta().activeNameOnly() });
    return true;
  }

  if (rest === '/active' && method === 'POST') {
    const body = await ctx.readBody(req);
    const name = strOf(body['name'], 64);
    if (!name) return ctx.json(res, 400, { error: 'name is required', code: 'BAD_INPUT' }), true;
    try {
      meta().setActive(name);
      ctx.audit.record('db-browser', 'DBB_ACTIVE_CHANGED', 'db-connection', name, { actor: actorOf(body) });
      return ctx.json(res, 200, { active: name }), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest.startsWith('/connections/') && rest.endsWith('/write-mode') && method === 'POST') {
    const name = decodeURIComponent(rest.slice('/connections/'.length, -'/write-mode'.length));
    const body = await ctx.readBody(req);
    const enabled = body['enabled'];
    if (typeof enabled !== 'boolean') {
      return ctx.json(res, 400, { error: 'enabled must be a boolean', code: 'BAD_INPUT' }), true;
    }
    try {
      const m = meta().setWriteMode(name, enabled, body['confirm'] === true);
      ctx.audit.record('db-browser', 'DBB_WRITE_MODE_CHANGED', 'db-connection', name, {
        enabled,
        actor: actorOf(body),
      });
      return ctx.json(res, 200, { name: m.name, writeMode: m.writeMode, env: m.env }), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  // ------------------------------------------------------------ R7-#8 query history
  if (rest === '/history' && method === 'GET') {
    try {
      const entries = historyOf(dataDir).list({
        connection: url.searchParams.get('connection') ?? undefined,
        favoritesOnly: url.searchParams.get('favoritesOnly') === '1',
      });
      return ctx.json(res, 200, { entries }), true;
    } catch (e) {
      if (e instanceof HistoryCorruptError) {
        return ctx.json(res, 500, { error: e.message, code: e.code }), true;
      }
      throw e;
    }
  }

  if (rest === '/history' && method === 'DELETE') {
    const connection = url.searchParams.get('connection') ?? undefined;
    try {
      const removed = historyOf(dataDir).clear(connection);
      ctx.audit.record('db-browser', 'DBB_HISTORY_CLEARED', 'db-history', connection ?? 'all', {
        removed,
        actor: actorOf({}),
      });
      return ctx.json(res, 200, { removed }), true;
    } catch (e) {
      if (e instanceof HistoryCorruptError) {
        return ctx.json(res, 500, { error: e.message, code: e.code }), true;
      }
      throw e;
    }
  }

  if (rest.startsWith('/history/') && rest.endsWith('/rerun') && method === 'POST') {
    const id = decodeURIComponent(rest.slice('/history/'.length, -'/rerun'.length));
    const body = await ctx.readBody(req);
    const actor = actorOf(body);
    let entry;
    try {
      entry = historyOf(dataDir).get(id);
    } catch (e) {
      if (e instanceof HistoryCorruptError) {
        return ctx.json(res, 500, { error: e.message, code: e.code }), true;
      }
      throw e;
    }
    if (!entry) return ctx.json(res, 404, { error: 'history entry not found', code: 'HISTORY_NOT_FOUND' }), true;
    try {
      const { verdict, result } = await executeConsole(entry.connection, entry.sql, actor);
      const fresh = historyOf(dataDir).record({
        connection: entry.connection,
        sql: entry.sql,
        verdict,
        ok: true,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
      });
      ctx.audit.record('db-browser', 'DBB_HISTORY_RERUN', 'db-history', entry.id, {
        connection: entry.connection,
        newEntryId: fresh.id,
        actor,
      });
      return ctx.json(res, 200, { verdict, result, historyId: fresh.id }), true;
    } catch (e) {
      if (e instanceof DbBlockedError) {
        recordHistory(dataDir, {
          connection: entry.connection,
          sql: entry.sql,
          verdict: 'refused',
          ok: false,
          errorCode: e.code,
        });
      }
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest.startsWith('/history/') && rest.endsWith('/favorite') && method === 'POST') {
    const id = decodeURIComponent(rest.slice('/history/'.length, -'/favorite'.length));
    const body = await ctx.readBody(req);
    if (typeof body['favorite'] !== 'boolean') {
      return ctx.json(res, 400, { error: 'favorite must be a boolean', code: 'BAD_INPUT' }), true;
    }
    try {
      const entry = historyOf(dataDir).setFavorite(id, body['favorite'] as boolean);
      if (!entry) return ctx.json(res, 404, { error: 'history entry not found', code: 'HISTORY_NOT_FOUND' }), true;
      return ctx.json(res, 200, { entry }), true;
    } catch (e) {
      if (e instanceof HistoryCorruptError) {
        return ctx.json(res, 500, { error: e.message, code: e.code }), true;
      }
      throw e;
    }
  }

  if (rest.startsWith('/history/') && method === 'DELETE') {
    const id = decodeURIComponent(rest.slice('/history/'.length));
    try {
      const removed = historyOf(dataDir).remove(id);
      if (!removed) return ctx.json(res, 404, { error: 'history entry not found', code: 'HISTORY_NOT_FOUND' }), true;
      return ctx.json(res, 200, { ok: true }), true;
    } catch (e) {
      if (e instanceof HistoryCorruptError) {
        return ctx.json(res, 500, { error: e.message, code: e.code }), true;
      }
      throw e;
    }
  }

  // ------------------------------------------------------------ query console
  if (rest === '/query' && method === 'POST') {
    const body = await ctx.readBody(req);
    const connection = strOf(body['connection'], 64);
    const sql = typeof body['sql'] === 'string' ? body['sql'] : '';
    if (!connection || !sql.trim()) {
      return ctx.json(res, 400, { error: 'connection and sql are required', code: 'BAD_INPUT' }), true;
    }
    const actor = actorOf(body);
    try {
      const { verdict, result } = await executeConsole(connection, sql, actor);
      recordHistory(dataDir, {
        connection,
        sql: sql.trim(),
        verdict,
        ok: true,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
      });
      if (verdict === 'write') {
        ctx.audit.record('db-browser', 'DBB_WRITE', 'db-connection', connection, {
          actor,
          sql: sql.trim().slice(0, 2000),
          changes: result.changes ?? null,
        });
      }
      return ctx.json(res, 200, { verdict, result }), true;
    } catch (e) {
      // Refused attempts (guard-blocked, write-mode-off) are history, not
      // executions; approval-required is neither (ticket flow owns it).
      if (e instanceof DbBlockedError) {
        recordHistory(dataDir, {
          connection,
          sql: sql.trim(),
          verdict: 'refused',
          ok: false,
          errorCode: e.code,
        });
      }
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  // ------------------------------------------------------------ table editor
  if (rest === '/tables' && method === 'GET') {
    const connection = url.searchParams.get('connection');
    if (!connection) return ctx.json(res, 400, { error: 'connection is required', code: 'BAD_INPUT' }), true;
    try {
      return ctx.json(res, 200, { tables: await b.tables(connection) }), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest === '/table' && method === 'GET') {
    const connection = url.searchParams.get('connection');
    const name = url.searchParams.get('name');
    if (!connection || !name) {
      return ctx.json(res, 400, { error: 'connection and name are required', code: 'BAD_INPUT' }), true;
    }
    let filters: Array<{ column: string; op: 'eq' | 'like' | 'gt' | 'lt' | 'gte' | 'lte'; value: unknown }> | undefined;
    const fRaw = url.searchParams.get('filter');
    if (fRaw) {
      try {
        const parsed: unknown = JSON.parse(fRaw);
        if (!Array.isArray(parsed)) throw new Error('filter must be a JSON array');
        filters = parsed as typeof filters;
      } catch {
        return ctx.json(res, 400, { error: 'filter must be a JSON array', code: 'BAD_FILTER' }), true;
      }
    }
    try {
      const page = await b.pageTable(connection, name, {
        page: intOf(url.searchParams.get('page'), 1),
        pageSize: intOf(url.searchParams.get('pageSize'), 50),
        orderBy: url.searchParams.get('orderBy') ?? undefined,
        orderDir: url.searchParams.get('orderDir') === 'desc' ? 'desc' : 'asc',
        filters,
      });
      return ctx.json(res, 200, page), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest === '/row' && method === 'PUT') {
    const body = await ctx.readBody(req);
    const connection = strOf(body['connection'], 64);
    const table = strOf(body['table'], 128);
    const pk = body['pk'];
    const patch = body['patch'];
    if (!connection || !table || typeof pk !== 'object' || pk === null || typeof patch !== 'object' || patch === null) {
      return ctx.json(res, 400, { error: 'connection, table, pk, patch are required', code: 'BAD_INPUT' }), true;
    }
    const actor = actorOf(body);
    try {
      // R7-#8: row edits are writes, so the write-mode gate applies here too.
      if (!meta().has(connection)) {
        const c = b.get(connection); // UNKNOWN_CONNECTION when truly unknown
        meta().register(connection, c.driver.kind, c.env, c.env === 'prod');
      }
      meta().assertWriteAllowed(meta().get(connection), 'write');
      const out = await b.updateRow(
        connection,
        table,
        pk as Record<string, unknown>,
        patch as Record<string, unknown>,
      );
      ctx.audit.record('db-browser', 'DBB_ROW_UPDATED', 'db-connection', connection, {
        actor,
        table,
        pk: JSON.stringify(pk).slice(0, 500),
        changes: out.changes,
      });
      return ctx.json(res, 200, out), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  // ------------------------------------------------------------ schema / ddl / er
  if (rest === '/schema' && method === 'GET') {
    const connection = url.searchParams.get('connection');
    if (!connection) return ctx.json(res, 400, { error: 'connection is required', code: 'BAD_INPUT' }), true;
    try {
      return ctx.json(res, 200, await b.schema(connection)), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest === '/schema/diff' && method === 'POST') {
    const body = await ctx.readBody(req);
    const source = strOf(body['source'], 64);
    const target = strOf(body['target'], 64);
    if (!source || !target) {
      return ctx.json(res, 400, { error: 'source and target connections are required', code: 'BAD_INPUT' }), true;
    }
    try {
      return ctx.json(res, 200, await b.diff(source, target)), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest === '/ddl' && method === 'GET') {
    const connection = url.searchParams.get('connection');
    if (!connection) return ctx.json(res, 400, { error: 'connection is required', code: 'BAD_INPUT' }), true;
    try {
      return ctx.json(res, 200, await b.ddlFor(connection, url.searchParams.get('table') ?? undefined)), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest === '/er' && method === 'GET') {
    const connection = url.searchParams.get('connection');
    if (!connection) return ctx.json(res, 400, { error: 'connection is required', code: 'BAD_INPUT' }), true;
    try {
      return ctx.json(res, 200, await b.erGraph(connection)), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  // ------------------------------------------------------------ destructive flow
  if (rest === '/destructive/request' && method === 'POST') {
    const body = await ctx.readBody(req);
    const connection = strOf(body['connection'], 64);
    const sql = typeof body['sql'] === 'string' ? body['sql'].trim() : '';
    if (!connection || !sql) {
      return ctx.json(res, 400, { error: 'connection and sql are required', code: 'BAD_INPUT' }), true;
    }
    // Fail-closed: only guard-destructive statements may enter this path.
    const g = classifySql(sql);
    if (g.verdict !== 'destructive') {
      return ctx.json(res, 400, {
        error: `statement is ${g.verdict} (${g.reason}), not destructive — use /api/db-browser/query`,
        code: 'NOT_DESTRUCTIVE',
      }), true;
    }
    const actor = actorOf(body);
    try {
      b.get(connection); // unknown connection -> 404, before minting a ticket
      const ticket: DestructiveTicket = {
        ticketId: randomUUID(),
        connection,
        sql,
        sqlSha256: sha256(sql),
        status: 'pending',
        requestedBy: actor,
        decidedBy: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + TICKET_TTL_MS,
      };
      destructiveTickets.set(ticket.ticketId, ticket);
      ctx.audit.record('db-browser', 'DBB_DESTRUCTIVE_REQUESTED', 'db-connection', connection, {
        actor,
        ticketId: ticket.ticketId,
        sql: sql.slice(0, 2000),
      });
      return ctx.json(res, 201, {
        ticketId: ticket.ticketId,
        status: ticket.status,
        approveVia: '/api/db-browser/destructive/approve',
      }), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  if (rest === '/destructive/approve' && method === 'POST') {
    const body = await ctx.readBody(req);
    const ticketId = strOf(body['ticketId'], 128);
    // Decider identity is required explicitly (same lesson as /api/approvals).
    const decidedBy = strOf(body['decided_by'] ?? body['decidedBy'], 128);
    if (!ticketId || !decidedBy) {
      return ctx.json(res, 400, { error: 'ticketId and decided_by are required', code: 'BAD_INPUT' }), true;
    }
    const t = getTicket(ticketId);
    if (!t) return ctx.json(res, 404, { error: 'ticket not found or expired', code: 'TICKET_NOT_FOUND' }), true;
    if (t.status !== 'pending') {
      return ctx.json(res, 409, { error: `ticket is ${t.status}, not pending`, code: 'TICKET_NOT_PENDING' }), true;
    }
    t.status = 'approved';
    t.decidedBy = decidedBy;
    ctx.audit.record('db-browser', 'DBB_DESTRUCTIVE_APPROVED', 'db-connection', t.connection, {
      actor: decidedBy,
      ticketId,
      sql: t.sql.slice(0, 2000),
    });
    return ctx.json(res, 200, { ticketId, status: t.status }), true;
  }

  if (rest === '/destructive/execute' && method === 'POST') {
    const body = await ctx.readBody(req);
    const ticketId = strOf(body['ticketId'], 128);
    const connection = strOf(body['connection'], 64);
    const sql = typeof body['sql'] === 'string' ? body['sql'].trim() : '';
    if (!ticketId || !connection || !sql) {
      return ctx.json(res, 400, { error: 'ticketId, connection and sql are required', code: 'BAD_INPUT' }), true;
    }
    const actor = actorOf(body);
    try {
      const t = getTicket(ticketId);
      if (!t) return ctx.json(res, 404, { error: 'ticket not found or expired', code: 'TICKET_NOT_FOUND' }), true;
      if (t.status === 'consumed') {
        return ctx.json(res, 409, { error: 'ticket already consumed (single-use)', code: 'TICKET_CONSUMED' }), true;
      }
      if (t.status !== 'approved') {
        return ctx.json(res, 403, {
          error: `ticket is ${t.status}, not approved`,
          code: 'TICKET_NOT_APPROVED',
        }), true;
      }
      if (t.connection !== connection || t.sqlSha256 !== sha256(sql)) {
        return ctx.json(res, 403, {
          error: 'ticket is bound to a different connection or statement; refusing',
          code: 'TICKET_BINDING_MISMATCH',
        }), true;
      }
      // Re-classify at execution time: the statement must still be destructive.
      const g = classifySql(sql);
      if (g.verdict !== 'destructive') {
        return ctx.json(res, 400, { error: 'statement no longer classifies as destructive; refusing', code: 'NOT_DESTRUCTIVE' }), true;
      }
      const conn = b.get(connection);
      if (conn.env === 'prod') {
        return ctx.json(res, 403, {
          error: 'refusing destructive execution on prod; use /api/db-time-travel/promote',
          code: 'PROD_WRITE_REFUSED',
        }), true;
      }
      const result = await conn.driver.exec(sql, []);
      t.status = 'consumed';
      ctx.audit.record('db-browser', 'DBB_DESTRUCTIVE_EXECUTED', 'db-connection', connection, {
        actor,
        ticketId,
        decidedBy: t.decidedBy,
        sql: sql.slice(0, 2000),
        changes: result.changes,
      });
      return ctx.json(res, 200, { ok: true, changes: result.changes, durationMs: result.durationMs }), true;
    } catch (e) {
      const eb = errBody(e);
      return ctx.json(res, eb.status, eb.body), true;
    }
  }

  return false;
}
