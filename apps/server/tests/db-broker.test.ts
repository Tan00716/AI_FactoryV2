/**
 * Server-side database broker HTTP surface — SPEC v2 §33 (Batch 29).
 *
 * The DbBroker lives in-package (@ai-factory/tools, Batches 27–28);
 * this batch wires it into the server: registry + broker + a
 * host-injected SQLite engine over the server's own database, exposed
 * as /api/db/*. Pinned on the REAL server binary (dist/index.js):
 *
 *  - 'factory' connection auto-registered at boot (env identity dev),
 *    but ad-hoc execution is refused (PRIVILEGE_DENIED) until an admin
 *    binds a privilege policy — execution is opt-in, never open;
 *  - RBAC: query/runbook execution is operator, connection registration
 *    and policy writes are admin (operator gets 403 RBAC_DENIED);
 *  - whitelist denial: a table outside the policy is refused (403);
 *  - a registered connection with no engine is refused LOUDLY (503
 *    NO_ENGINE) — the broker never pretends it executed;
 *  - prod writes need literal prodWriteConfirmed=true (403 GATE_DENIED
 *    without it; with it the gate passes and the whitelist still bites);
 *  - runbooks: register (admin) → run (operator), exact param matching;
 *  - the full audit chain lands in the hash-chained audit log with
 *    SQL placeholders only — bound parameter VALUES never audited.
 *
 * Honest boundaries pinned here: the engine executes raw SQL against
 * the factory database through the server's own SQLite connection
 * (writes skip the domain stores — the whitelist is the only control);
 * single statements only; `db.query` the TOOL stays definition-only
 * (its implementationGate is untouched and still answers DENY).
 *
 * Boots dist/index.js, so this file runs after the server build.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'db-broker-admin-token-xyz';
const OPERATOR = 'db-broker-operator-token-xyz';
const VIEWER = 'db-broker-viewer-token-xyz';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

/** Bound param VALUE that must never appear in any audit record. */
const PARAM_SENTINEL = 'param-sentinel-must-never-be-audited-9z8';

async function bootRealServer(dbFile: string, secretsDir: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 28_000 + Math.floor(Math.random() * 15_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKENS: `admin:${ADMIN},operator:${OPERATOR},viewer:${VIEWER}`,
    FACTORY_SECRETS_BACKEND: 'memory',
    FACTORY_SECRETS_DIR: secretsDir,
    // Boot the 'factory' connection as prod so the production-write
    // gate is exercised against the REAL engine (temp DB — safe).
    FACTORY_DB_ENVIRONMENT: 'prod',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Rec = Record<string, unknown>;

describe('database broker HTTP surface (§33, Batch 29)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-broker-'));
  const secretsDir = join(dir, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  let child: ChildProcess | null = null;
  let port = 0;

  after(() => {
    try { child?.kill('SIGKILL'); } catch { /* already dead */ }
    rmSync(dir, { recursive: true, force: true });
  });

  async function api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Rec }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as Rec;
    return { status: res.status, json };
  }

  it('boots with the factory connection registered but no policy bound', { timeout: 180_000 }, async () => {
    ({ child, port } = await bootRealServer(join(dir, 'factory.db'), secretsDir));

    // Viewer can list connections.
    const list = await api('GET', '/api/db/connections', VIEWER);
    assert.equal(list.status, 200);
    const conns = list.json['connections'] as Rec[];
    const factory = conns.find((c) => c['name'] === 'factory');
    assert.ok(factory, 'factory connection registered at boot');
    assert.equal(factory['environment'], 'prod');
    assert.equal(factory['kind'], 'sqlite');

    // No policy bound yet: execution is refused loudly (least privilege
    // is the default — an admin must opt in).
    const q = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: 'SELECT id FROM tasks LIMIT 3',
    });
    assert.equal(q.status, 403);
    assert.equal(q.json['code'], 'PRIVILEGE_DENIED');
    assert.match(String(q.json['reason']), /no least-privilege policy/);
  });

  it('RBAC: policy writes are admin-only; execution is operator', { timeout: 60_000 }, async () => {
    // Operator cannot bind a policy.
    const opPut = await api('PUT', '/api/db/connections/factory/policy', OPERATOR, {
      operations: ['read'],
      tables: ['tasks'],
    });
    assert.equal(opPut.status, 403);
    assert.equal(opPut.json['error'], 'Forbidden');

    // Viewer cannot execute.
    const vq = await api('POST', '/api/db/query', VIEWER, {
      connectionName: 'factory',
      sql: 'SELECT 1',
    });
    assert.equal(vq.status, 403);

    // Operator cannot register a connection.
    const opReg = await api('POST', '/api/db/connections', OPERATOR, {
      name: 'nope',
      environment: 'dev',
    });
    assert.equal(opReg.status, 403);

    // Admin binds a read-only policy on tasks.
    const put = await api('PUT', '/api/db/connections/factory/policy', ADMIN, {
      operations: ['read'],
      tables: ['tasks'],
    });
    assert.equal(put.status, 200);
    assert.deepEqual((put.json['policy'] as Rec)['operations'], ['read']);

    // Viewer can read the policy back.
    const get = await api('GET', '/api/db/connections/factory/policy', VIEWER);
    assert.equal(get.status, 200);
  });

  it('executes whitelisted reads; refuses tables outside the whitelist', { timeout: 60_000 }, async () => {
    const ok = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: 'SELECT id FROM tasks LIMIT 3',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json['ok'], true);
    assert.equal(ok.json['code'], 'OK');
    assert.ok(Array.isArray(ok.json['rows']));
    assert.equal(typeof ok.json['rowCount'], 'number');
    assert.equal(ok.json['truncatedRows'], false);
    assert.equal(ok.json['truncatedColumns'], false);

    // Named params bind; the VALUE never reaches the audit log.
    const p = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: 'SELECT :v AS v',
      params: { v: PARAM_SENTINEL },
    });
    assert.equal(p.status, 200);
    assert.equal((p.json['rows'] as Rec[])[0]['v'], PARAM_SENTINEL);

    // audit_logs is not in the whitelist: refused.
    const denied = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: 'SELECT id FROM audit_logs LIMIT 1',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json['code'], 'PRIVILEGE_DENIED');
    assert.match(String(denied.json['reason']), /audit_logs/);

    // Multi-statement strings are rejected, not half-executed.
    const multi = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: 'SELECT 1; SELECT 2',
    });
    assert.equal(multi.status, 400);
    assert.match(String(multi.json['error']), /single-statement/);
  });

  it('refuses loudly for connections with no engine and unknown connections', { timeout: 60_000 }, async () => {
    const reg = await api('POST', '/api/db/connections', ADMIN, {
      name: 'analytics',
      environment: 'staging',
      kind: 'postgres',
      credentialRefs: ['ANALYTICS_RO_REF'],
    });
    assert.equal(reg.status, 201);
    assert.equal((reg.json['connection'] as Rec)['environment'], 'staging');

    // Bind a policy so the refusal is about the ENGINE, not privilege.
    const pol = await api('PUT', '/api/db/connections/analytics/policy', ADMIN, {
      operations: ['read'],
      tables: ['*'],
    });
    assert.equal(pol.status, 200);

    const q = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'analytics',
      sql: 'SELECT 1',
    });
    assert.equal(q.status, 503);
    assert.equal(q.json['code'], 'NO_ENGINE');
    assert.match(String(q.json['reason']), /refuses to pretend/);

    const unknown = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'no-such-connection',
      sql: 'SELECT 1',
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json['code'], 'UNKNOWN_CONNECTION');

    // Deregistration is admin-only; afterwards the connection is unknown.
    const opDel = await api('DELETE', '/api/db/connections/analytics', OPERATOR);
    assert.equal(opDel.status, 403);
    const del = await api('DELETE', '/api/db/connections/analytics', ADMIN);
    assert.equal(del.status, 200);
    const gone = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'analytics',
      sql: 'SELECT 1',
    });
    assert.equal(gone.status, 404);
    assert.equal(gone.json['code'], 'UNKNOWN_CONNECTION');
  });

  it('prod writes need literal confirmation; the whitelist still bites after it', { timeout: 60_000 }, async () => {
    // The boot connection IS prod (FACTORY_DB_ENVIRONMENT=prod), so the
    // production-write gate is exercised against the real engine.
    // Reads on prod are fine without confirmation.
    const read = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: 'SELECT id FROM tasks LIMIT 1',
    });
    assert.equal(read.status, 200);
    assert.equal(read.json['environment'], 'prod');

    // Prod write without confirmation: gate refuses.
    const denied = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: "INSERT INTO tasks (id) VALUES ('x')",
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json['code'], 'GATE_DENIED');
    assert.match(String(denied.json['reason']), /confirmation/i);

    // With confirmation the GATE passes — but insert is not in the
    // read-only whitelist, so privilege still refuses. No mutation.
    const confirmed = await api('POST', '/api/db/query', OPERATOR, {
      connectionName: 'factory',
      sql: "INSERT INTO tasks (id) VALUES ('x')",
      prodWriteConfirmed: true,
    });
    assert.equal(confirmed.status, 403);
    assert.equal(confirmed.json['code'], 'PRIVILEGE_DENIED');
  });

  it('runbooks: register (admin), run (operator), exact params, unknown template', { timeout: 60_000 }, async () => {
    const reg = await api('POST', '/api/db/runbooks', ADMIN, {
      name: 'task-ids',
      connectionName: 'factory',
      description: 'fetch a task id by id',
      sqlTemplate: 'SELECT id FROM tasks WHERE id = :id',
      slots: ['id'],
    });
    assert.equal(reg.status, 201);
    assert.equal((reg.json['template'] as Rec)['statementKind'], 'read');

    const list = await api('GET', '/api/db/runbooks', VIEWER);
    assert.equal(list.status, 200);
    assert.ok((list.json['templates'] as Rec[]).some((t) => t['name'] === 'task-ids'));

    const run = await api('POST', '/api/db/runbooks/run', OPERATOR, {
      templateName: 'task-ids',
      params: { id: 'no-such-task' },
    });
    assert.equal(run.status, 200);
    assert.equal(run.json['code'], 'OK');
    assert.deepEqual(run.json['rows'], []);

    // Missing slot: refused.
    const missing = await api('POST', '/api/db/runbooks/run', OPERATOR, {
      templateName: 'task-ids',
      params: {},
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json['code'], 'PARAM_MISMATCH');

    // Unknown template: 404.
    const unknown = await api('POST', '/api/db/runbooks/run', OPERATOR, {
      templateName: 'no-such-template',
      params: {},
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json['code'], 'UNKNOWN_TEMPLATE');
  });

  it('every outcome lands in the hash-chained audit log; param values never do', { timeout: 60_000 }, async () => {
    const res = await api('GET', '/api/audit?limit=200', ADMIN);
    assert.equal(res.status, 200);
    const records = res.json as unknown as Rec[];
    const actions = new Set(records.map((r) => String(r['action'])));
    for (const expected of [
      'DB_CONNECTION_REGISTERED',
      'DB_BROKER_POLICY_SET',
      'DB_BROKER_EXECUTED',
      'DB_BROKER_DENIED',
      'DB_BROKER_NO_ENGINE',
      'DB_PROD_WRITE_DENIED',
      'DB_RUNBOOK_REGISTERED',
    ]) {
      assert.ok(actions.has(expected), `audit chain contains ${expected}`);
    }
    // RBAC denial from the operator policy attempt.
    assert.ok(actions.has('RBAC_DENIED'), 'audit chain contains RBAC_DENIED');
    // The bound param VALUE must not appear anywhere in the audit trail.
    const dumped = JSON.stringify(records);
    assert.ok(!dumped.includes(PARAM_SENTINEL), 'param values are never audited');
  });
});
