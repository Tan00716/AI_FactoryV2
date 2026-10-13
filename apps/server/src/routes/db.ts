/**
 * Server-side database broker HTTP surface — SPEC v2 §33 (Batch 29).
 *
 *   GET    /api/db/connections                  list connections (viewer)
 *   POST   /api/db/connections                  register connection (admin)
 *   DELETE /api/db/connections/:name            deregister connection (admin)
 *   GET    /api/db/connections/:name/policy     read privilege policy (viewer)
 *   PUT    /api/db/connections/:name/policy     bind privilege policy (admin)
 *   POST   /api/db/query                        execute ad-hoc SQL (operator)
 *   GET    /api/db/runbooks                     list runbook templates (viewer)
 *   POST   /api/db/runbooks                     register template (admin)
 *   POST   /api/db/runbooks/run                 run a template (operator)
 *
 * RBAC is enforced by the central gate (auth.ts requiredRoleFor):
 * execution is operator, connection registration and privilege-policy
 * writes are admin.
 *
 * Every call flows authorizeQuery gate → privilege whitelist → engine
 * inside the DbBroker; every outcome (allowed, denied, no-engine,
 * failed, executed) is written to the hash-chained audit log by the
 * service's audit sink (see ../db-broker.ts). Bound parameter VALUES
 * are never audited — the SQL text in audit carries placeholders only.
 *
 * Honest boundaries (also in KNOWN_LIMITATIONS):
 *  - The 'factory' connection is registered at boot over the server's
 *    own database with NO privilege policy: ad-hoc execution is refused
 *    (PRIVILEGE_DENIED) until an admin binds one. Execution is opt-in,
 *    never open by default.
 *  - `db.query` the TOOL stays definition-only: the tools route's
 *    implementationGate is untouched, so it keeps answering DENY. The
 *    tool contract and this HTTP surface are separate on purpose.
 *  - Engine writes go straight to SQLite, skipping the domain stores
 *    (TaskManager validation, archive guards). The whitelist is the
 *    only control — bind it narrowly.
 *  - Single statements only; multi-statement strings are rejected
 *    (400), not half-executed.
 *  - Rows are capped at DB_QUERY_MAX_ROWS, columns at DB_QUERY_MAX_COLS;
 *    truncation is flagged (truncatedRows/truncatedColumns), never silent.
 *    Binary values are returned as base64 strings.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  statementKeywords,
  type DbBrokerCode,
  type DbBrokerExecution,
} from '@ai-factory/tools';
import type { RouteContext } from './context';

function actorOf(body: Record<string, unknown>): string {
  const a = body['actor'];
  return typeof a === 'string' && a.length > 0 ? a : 'human';
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function statusFor(code: DbBrokerCode): number {
  switch (code) {
    case 'OK':
      return 200;
    case 'UNKNOWN_CONNECTION':
    case 'UNKNOWN_TEMPLATE':
      return 404;
    case 'GATE_DENIED':
    case 'PRIVILEGE_DENIED':
      return 403;
    case 'INVALID_PARAMS':
    case 'PARAM_MISMATCH':
      return 400;
    case 'NO_ENGINE':
      return 503;
    case 'EXECUTION_FAILED':
      return 500;
  }
}

function executionBody(exec: DbBrokerExecution, trunc: { truncatedRows: boolean; truncatedColumns: boolean } | null) {
  const body: Record<string, unknown> = {
    ok: exec.code === 'OK',
    allowed: exec.allowed,
    executed: exec.executed,
    code: exec.code,
    reason: exec.reason,
    connectionName: exec.connectionName,
  };
  if (exec.environment !== undefined) body['environment'] = exec.environment;
  if (exec.rows !== undefined) body['rows'] = exec.rows;
  if (exec.rowCount !== undefined) body['rowCount'] = exec.rowCount;
  if (trunc !== null) {
    body['truncatedRows'] = trunc.truncatedRows;
    body['truncatedColumns'] = trunc.truncatedColumns;
  }
  return body;
}

export async function handleDbRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const { json, readBody } = ctx;
  const method = req.method ?? 'GET';
  const p = url.pathname;
  if (p !== '/api/db' && !p.startsWith('/api/db/')) return false;
  const svc = ctx.dbBroker;
  if (!svc) {
    json(res, 503, { error: 'database broker not wired in this process' });
    return true;
  }
  const { registry, broker, engine } = svc;

  // -------------------------------------------------- connections --

  if (p === '/api/db/connections' && method === 'GET') {
    json(res, 200, { connections: registry.listConnections() });
    return true;
  }

  if (p === '/api/db/connections' && method === 'POST') {
    const b = await readBody(req);
    const name = b['name'];
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      json(res, 400, { error: 'name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/' });
      return true;
    }
    const environment = b['environment'];
    if (environment !== undefined && environment !== 'dev' && environment !== 'staging' && environment !== 'prod') {
      json(res, 400, { error: "environment must be 'dev', 'staging' or 'prod'" });
      return true;
    }
    const kind = b['kind'];
    if (kind !== undefined && kind !== 'sqlite' && kind !== 'postgres' && kind !== 'mysql' && kind !== 'other') {
      json(res, 400, { error: "kind must be 'sqlite', 'postgres', 'mysql' or 'other'" });
      return true;
    }
    const credentialRefs = b['credentialRefs'];
    if (credentialRefs !== undefined && (!Array.isArray(credentialRefs) || credentialRefs.some((r) => typeof r !== 'string'))) {
      json(res, 400, { error: 'credentialRefs must be an array of reference-name strings (values are never accepted)' });
      return true;
    }
    try {
      const descriptor = registry.registerConnection({
        name,
        kind: kind ?? 'other',
        environment,
        credentialRefs,
      });
      json(res, 201, { connection: descriptor });
    } catch (e) {
      // Fail-closed: immutable-identity violations and bad input are
      // refused loudly, never silently re-registered.
      json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  const connMatch = p.match(/^\/api\/db\/connections\/([^/]+)$/);
  if (connMatch && method === 'DELETE') {
    const name = decodeURIComponent(connMatch[1]);
    if (!registry.deregisterConnection(name)) {
      json(res, 404, { error: `unknown database connection: ${name}` });
      return true;
    }
    json(res, 200, { ok: true, deregistered: name });
    return true;
  }

  const policyMatch = p.match(/^\/api\/db\/connections\/([^/]+)\/policy$/);
  if (policyMatch && method === 'GET') {
    const name = decodeURIComponent(policyMatch[1]);
    const policy = broker.getPrivilegePolicy(name);
    if (!policy) {
      json(res, 404, { error: `no privilege policy bound to connection: ${name}` });
      return true;
    }
    json(res, 200, { policy });
    return true;
  }

  if (policyMatch && method === 'PUT') {
    const name = decodeURIComponent(policyMatch[1]);
    const b = await readBody(req);
    const operations = b['operations'];
    const tables = b['tables'];
    if (!Array.isArray(operations) || operations.some((o) => typeof o !== 'string')) {
      json(res, 400, { error: 'operations must be an array of operation-bucket strings (read|insert|update|delete|ddl|other)' });
      return true;
    }
    if (!Array.isArray(tables) || tables.some((t) => typeof t !== 'string')) {
      json(res, 400, { error: 'tables must be an array of table-name strings ("*" allows all tables)' });
      return true;
    }
    try {
      const policy = broker.setPrivilegePolicy(
        { connectionName: name, operations, tables },
        actorOf(b),
      );
      json(res, 200, { policy });
    } catch (e) {
      // Unknown connection (privilege without identity is refused) or
      // an invalid operation bucket — both fail closed.
      const msg = (e as Error).message;
      const status = msg.includes('unknown database connection') ? 404 : 400;
      json(res, status, { error: msg });
    }
    return true;
  }

  // ------------------------------------------------------- query --

  if (p === '/api/db/query' && method === 'POST') {
    const b = await readBody(req);
    const connectionName = b['connectionName'];
    const sql = b['sql'];
    if (typeof connectionName !== 'string' || connectionName.length === 0) {
      json(res, 400, { error: 'connectionName is required' });
      return true;
    }
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      json(res, 400, { error: 'sql is required and must be non-empty' });
      return true;
    }
    // Single statements only: the engine prepares one statement, so a
    // multi-statement string is refused up front (400) rather than
    // half-executed or failing mid-broker.
    if (statementKeywords(sql).length !== 1) {
      json(res, 400, { error: 'only single-statement SQL is accepted on this surface' });
      return true;
    }
    const params = b['params'];
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      json(res, 400, { error: 'params must be an object of scalar values (string|number|boolean|null)' });
      return true;
    }
    const exec = await broker.execute({
      connectionName,
      sql,
      params: (params ?? {}) as Record<string, unknown>,
      actor: actorOf(b),
      prodWriteConfirmed: b['prodWriteConfirmed'] === true,
      previousConnectionName:
        typeof b['previousConnectionName'] === 'string' ? b['previousConnectionName'] : undefined,
    });
    json(res, statusFor(exec.code), executionBody(exec, engine.lastTruncation));
    return true;
  }

  // ----------------------------------------------------- runbooks --

  if (p === '/api/db/runbooks' && method === 'GET') {
    json(res, 200, { templates: broker.listRunbookTemplates() });
    return true;
  }

  if (p === '/api/db/runbooks' && method === 'POST') {
    const b = await readBody(req);
    const name = b['name'];
    const connectionName = b['connectionName'];
    const sqlTemplate = b['sqlTemplate'];
    const slots = b['slots'];
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      json(res, 400, { error: 'name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/' });
      return true;
    }
    if (typeof connectionName !== 'string' || connectionName.length === 0) {
      json(res, 400, { error: 'connectionName is required' });
      return true;
    }
    if (typeof sqlTemplate !== 'string' || sqlTemplate.trim().length === 0) {
      json(res, 400, { error: 'sqlTemplate is required and must be non-empty' });
      return true;
    }
    if (!Array.isArray(slots) || slots.some((s) => typeof s !== 'string')) {
      json(res, 400, { error: 'slots must be an array of identifier strings matching the template placeholders exactly' });
      return true;
    }
    try {
      const template = broker.registerRunbookTemplate({
        name,
        connectionName,
        description: typeof b['description'] === 'string' ? b['description'] : undefined,
        sqlTemplate,
        slots,
        actor: actorOf(b),
      });
      json(res, 201, { template });
    } catch (e) {
      // Registration IS the approval: placeholder/slot mismatches and
      // multi-statement templates are refused loudly, never truncated.
      json(res, 400, { error: (e as Error).message });
    }
    return true;
  }

  if (p === '/api/db/runbooks/run' && method === 'POST') {
    const b = await readBody(req);
    const templateName = b['templateName'];
    if (typeof templateName !== 'string' || templateName.length === 0) {
      json(res, 400, { error: 'templateName is required' });
      return true;
    }
    const params = b['params'];
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      json(res, 400, { error: 'params must be an object of scalar values (string|number|boolean|null)' });
      return true;
    }
    const exec = await broker.runRunbook({
      templateName,
      params: (params ?? {}) as Record<string, unknown>,
      actor: actorOf(b),
      prodWriteConfirmed: b['prodWriteConfirmed'] === true,
      previousConnectionName:
        typeof b['previousConnectionName'] === 'string' ? b['previousConnectionName'] : undefined,
    });
    json(res, statusFor(exec.code), executionBody(exec, engine.lastTruncation));
    return true;
  }

  return false;
}
