/**
 * Role-based access control tests — Batch 15 (src/auth.ts RBAC layer).
 *
 * Three layers:
 *  1. Pure predicates: FACTORY_API_TOKENS parsing (incl. fail-closed
 *     malformed entries that never echo a token), the route→role
 *     classification, and the full access decision.
 *  2. The middleware over fake req/res and over a real node:http
 *     server: the three-role × three-surface matrix, uniform 401 for
 *     unauthenticated, 403 + RBAC_DENIED audit (role named, token never)
 *     for under-privileged callers, and the legacy single-token config
 *     behaving as admin — the backward-compatibility contract.
 *  3. The real server binary (dist/index.js) booted with
 *     FACTORY_API_TOKENS: the wiring in index.ts actually gates, and
 *     GET /api/auth/whoami reports each caller's own role.
 *
 * The pre-RBAC behavior is pinned unchanged by tests/auth.test.ts,
 * which this file does not touch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RBAC_DENIED_ACTION,
  authMode,
  enforceApiAuth,
  evaluateApiAccess,
  parseRoleTokens,
  requestRole,
  requiredRoleFor,
  resolveApiAuthConfig,
  roleForAuthorization,
  startupRbacError,
  type ApiAuthConfig,
} from '../src/auth.ts';

const VIEWER = 'viewer-secret-aaa';
const OPERATOR = 'operator-secret-bbb';
const ADMIN = 'admin-secret-ccc';
const SINGLE = 'single-token-ddd';

const RBAC_CONFIG: ApiAuthConfig = {
  singleToken: undefined,
  roleTokens: [
    { role: 'viewer', token: VIEWER },
    { role: 'operator', token: OPERATOR },
    { role: 'admin', token: ADMIN },
  ],
};

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('parseRoleTokens (FACTORY_API_TOKENS)', () => {
  it('parses role:token entries, trims, and is case-insensitive on roles', () => {
    const { entries, errors } = parseRoleTokens(` viewer:${VIEWER} , OPERATOR:${OPERATOR},admin:${ADMIN} `);
    assert.deepEqual(errors, []);
    assert.deepEqual(entries, [
      { role: 'viewer', token: VIEWER },
      { role: 'operator', token: OPERATOR },
      { role: 'admin', token: ADMIN },
    ]);
  });

  it('unset / empty / stray commas produce no entries and no errors', () => {
    assert.deepEqual(parseRoleTokens(undefined), { entries: [], errors: [] });
    assert.deepEqual(parseRoleTokens(''), { entries: [], errors: [] });
    assert.deepEqual(parseRoleTokens(' , ,'), { entries: [], errors: [] });
  });

  it('a token may contain colons — only the first colon separates the role', () => {
    const { entries, errors } = parseRoleTokens('viewer:a:b:c');
    assert.deepEqual(errors, []);
    assert.deepEqual(entries, [{ role: 'viewer', token: 'a:b:c' }]);
  });

  it('several tokens may share one role', () => {
    const { entries, errors } = parseRoleTokens(`viewer:${VIEWER},viewer:second-viewer`);
    assert.deepEqual(errors, []);
    assert.equal(entries.length, 2);
  });

  it('malformed entries are errors, and error text never echoes a token', () => {
    const bad = [
      'no-colon-here',
      `superuser:${ADMIN}`,
      'viewer:',
      `${VIEWER}`,
      `viewer:${VIEWER},operator:${VIEWER}`, // same token, two roles
      `viewer:${VIEWER},viewer:${VIEWER}`, // duplicate token
    ].join(',');
    const { errors } = parseRoleTokens(bad);
    // no-colon, unknown role, empty token, bare token (no colon),
    // cross-role duplicate, then two duplicate-token entries = 7.
    assert.equal(errors.length, 7);
    const surface = errors.join('\n');
    assert.ok(!surface.includes(VIEWER), 'token leaked into an error');
    assert.ok(!surface.includes(ADMIN), 'token leaked into an error');
  });
});

describe('resolveApiAuthConfig / startupRbacError', () => {
  it('resolves single + role tokens together; the single token stays admin', () => {
    const { config, errors } = resolveApiAuthConfig({
      FACTORY_API_TOKEN: SINGLE,
      FACTORY_API_TOKENS: `viewer:${VIEWER}`,
    });
    assert.deepEqual(errors, []);
    assert.equal(config.singleToken, SINGLE);
    assert.equal(authMode(config), 'rbac');
    assert.equal(roleForAuthorization(`Bearer ${SINGLE}`, config), 'admin');
    assert.equal(roleForAuthorization(`Bearer ${VIEWER}`, config), 'viewer');
  });

  it('modes: open without credentials, single with only FACTORY_API_TOKEN', () => {
    assert.equal(authMode(resolveApiAuthConfig({}).config), 'open');
    assert.equal(
      authMode(resolveApiAuthConfig({ FACTORY_API_TOKEN: SINGLE }).config),
      'single',
    );
  });

  it('any credential allows a non-loopback bind; none keeps the loopback rule', () => {
    const roleOnly = resolveApiAuthConfig({ FACTORY_API_TOKENS: `viewer:${VIEWER}` }).config;
    assert.equal(startupRbacError('0.0.0.0', roleOnly), null);
    assert.equal(startupRbacError('127.0.0.1', resolveApiAuthConfig({}).config), null);
    const err = startupRbacError('0.0.0.0', resolveApiAuthConfig({}).config);
    assert.ok(err);
    assert.match(err!, /FACTORY_API_TOKENS/);
  });
});

describe('requiredRoleFor (route classification)', () => {
  it('reads are viewer across the board', () => {
    for (const p of ['/api/projects', '/api/tasks', '/api/audit', '/api/retention/policies', '/api/retention/holds', '/api/policy/layers', '/api/auth/whoami']) {
      assert.equal(requiredRoleFor('GET', p), 'viewer', p);
    }
  });

  it('daily writes are operator', () => {
    for (const [m, p] of [
      ['POST', '/api/tasks'],
      ['POST', '/api/tasks/t1/transition'],
      ['POST', '/api/tasks/t1/evidence'],
      ['POST', '/api/approvals'],
      ['POST', '/api/runtime/runs'],
      ['POST', '/api/policy/validate'],
    ] as const) {
      assert.equal(requiredRoleFor(m, p), 'operator', `${m} ${p}`);
    }
  });

  it('the dangerous surfaces are admin, including the backup inventory read', () => {
    for (const [m, p] of [
      ['POST', '/api/backup'],
      ['POST', '/api/restore'],
      ['GET', '/api/backups'],
      ['PUT', '/api/retention/policies'],
      ['POST', '/api/retention/holds'],
      ['POST', '/api/retention/holds/h1/release'],
      ['POST', '/api/retention/evaluate'],
      ['POST', '/api/retention/enforce'],
      ['PUT', '/api/autonomy/mode'],
    ] as const) {
      assert.equal(requiredRoleFor(m, p), 'admin', `${m} ${p}`);
    }
  });

  it('health and non-/api paths sit outside the gate', () => {
    assert.equal(requiredRoleFor('GET', '/api/health'), null);
    assert.equal(requiredRoleFor('GET', '/'), null);
    assert.equal(requiredRoleFor('GET', '/favicon.ico'), null);
  });
});

describe('evaluateApiAccess (decision matrix)', () => {
  const access = (method: string, path: string, token?: string) =>
    evaluateApiAccess({
      method,
      path,
      authorization: token ? `Bearer ${token}` : undefined,
      config: RBAC_CONFIG,
    });

  it('viewer reads, cannot write, cannot touch admin surfaces', () => {
    assert.equal(access('GET', '/api/projects', VIEWER).outcome, 'allow');
    assert.equal(access('POST', '/api/tasks', VIEWER).outcome, 'forbidden');
    assert.equal(access('POST', '/api/backup', VIEWER).outcome, 'forbidden');
  });

  it('operator works daily surfaces, not admin ones', () => {
    assert.equal(access('POST', '/api/tasks', OPERATOR).outcome, 'allow');
    assert.equal(access('POST', '/api/restore', OPERATOR).outcome, 'forbidden');
    assert.equal(access('POST', '/api/retention/enforce', OPERATOR).outcome, 'forbidden');
  });

  it('admin passes everything; missing/wrong credentials are unauthenticated', () => {
    assert.equal(access('POST', '/api/backup', ADMIN).outcome, 'allow');
    assert.equal(access('GET', '/api/projects').outcome, 'unauthenticated');
    assert.equal(access('GET', '/api/projects', 'bogus').outcome, 'unauthenticated');
    const denied = access('POST', '/api/backup', OPERATOR);
    assert.equal(denied.role, 'operator');
    assert.equal(denied.required, 'admin');
  });

  it('open mode allows with effective role admin; single token is admin', () => {
    const open = evaluateApiAccess({
      method: 'POST', path: '/api/backup', authorization: undefined,
      config: { singleToken: undefined, roleTokens: [] },
    });
    assert.deepEqual(
      { outcome: open.outcome, role: open.role, mode: open.mode },
      { outcome: 'allow', role: 'admin', mode: 'open' },
    );
    const single: ApiAuthConfig = { singleToken: SINGLE, roleTokens: [] };
    assert.equal(
      evaluateApiAccess({ method: 'POST', path: '/api/backup', authorization: `Bearer ${SINGLE}`, config: single }).outcome,
      'allow',
    );
    assert.equal(
      evaluateApiAccess({ method: 'POST', path: '/api/backup', authorization: undefined, config: single }).outcome,
      'unauthenticated',
    );
  });
});

describe('enforceApiAuth with roles (middleware + real HTTP matrix)', () => {
  interface AuditCall {
    actor: string;
    action: string;
    entityId: string;
    details?: Record<string, unknown>;
  }

  async function startServer(config: ApiAuthConfig, auditCalls: AuditCall[]) {
    const server: Server = createServer((req, res) => {
      const audit = {
        record: (actor: string, action: string, _t: string, entityId: string, details?: Record<string, unknown>) => {
          auditCalls.push({ actor, action, entityId, details });
        },
      };
      const deps = {
        token: config.singleToken,
        roleTokens: config.roleTokens,
        audit,
        json: writeJson,
      };
      if (!enforceApiAuth(req, res, deps)) return;
      // Mirror of the index.ts whoami branch (the e2e below covers the real one).
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/auth/whoami') {
        const identity = requestRole(req, config);
        if (identity.role === null) return writeJson(res, 401, { error: 'Unauthorized' });
        return writeJson(res, 200, {
          role: identity.role, mode: identity.mode, authRequired: identity.authRequired,
        });
      }
      writeJson(res, 200, { ok: true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    return { server, base: `http://127.0.0.1:${addr.port}` };
  }

  async function stopServer(server: Server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async function call(base: string, method: string, path: string, token?: string) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('three roles × three surfaces, plus 401s and whoami', async () => {
    const auditCalls: AuditCall[] = [];
    const { server, base } = await startServer(RBAC_CONFIG, auditCalls);
    try {
      // Health stays public.
      assert.equal((await call(base, 'GET', '/api/health')).status, 200);
      // Read surface.
      assert.equal((await call(base, 'GET', '/api/projects', VIEWER)).status, 200);
      assert.equal((await call(base, 'GET', '/api/projects', OPERATOR)).status, 200);
      assert.equal((await call(base, 'GET', '/api/projects', ADMIN)).status, 200);
      // Daily write surface.
      assert.equal((await call(base, 'POST', '/api/tasks', VIEWER)).status, 403);
      assert.equal((await call(base, 'POST', '/api/tasks', OPERATOR)).status, 200);
      assert.equal((await call(base, 'POST', '/api/tasks', ADMIN)).status, 200);
      // Admin surfaces.
      for (const [m, p] of [['POST', '/api/backup'], ['POST', '/api/restore'], ['GET', '/api/backups'], ['POST', '/api/retention/enforce'], ['POST', '/api/retention/holds'], ['PUT', '/api/autonomy/mode']] as const) {
        assert.equal((await call(base, m, p, VIEWER)).status, 403, `${m} ${p} as viewer`);
        assert.equal((await call(base, m, p, OPERATOR)).status, 403, `${m} ${p} as operator`);
        assert.equal((await call(base, m, p, ADMIN)).status, 200, `${m} ${p} as admin`);
      }
      // Unauthenticated: uniform 401 (missing and wrong are indistinguishable).
      const missing = await call(base, 'GET', '/api/projects');
      const wrong = await call(base, 'GET', '/api/projects', 'bogus-token');
      assert.equal(missing.status, 401);
      assert.equal(wrong.status, 401);
      assert.deepEqual(wrong.body, missing.body);
      // 403 body is minimal — no role configuration in it.
      const forbidden = await call(base, 'POST', '/api/backup', OPERATOR);
      assert.deepEqual(forbidden.body, { error: 'Forbidden' });
      // Whoami reports each caller's own role, never a token.
      for (const [token, role] of [[VIEWER, 'viewer'], [OPERATOR, 'operator'], [ADMIN, 'admin']] as const) {
        const me = await call(base, 'GET', '/api/auth/whoami', token);
        assert.equal(me.status, 200);
        assert.equal(me.body.role, role);
        assert.equal(me.body.mode, 'rbac');
        assert.ok(!JSON.stringify(me.body).includes(token));
      }
      assert.equal((await call(base, 'GET', '/api/auth/whoami')).status, 401);
      // Audit: RBAC_DENIED entries name role + requirement, never a token.
      const rbacDenials = auditCalls.filter((c) => c.action === RBAC_DENIED_ACTION);
      assert.ok(rbacDenials.length >= 10, `expected many RBAC_DENIED, got ${rbacDenials.length}`);
      assert.ok(rbacDenials.some(
        (c) => c.details?.role === 'operator' && c.details?.requiredRole === 'admin',
      ));
      const surface = JSON.stringify(auditCalls);
      for (const t of [VIEWER, OPERATOR, ADMIN]) {
        assert.ok(!surface.includes(t), 'token leaked into audit');
      }
    } finally {
      await stopServer(server);
    }
  });

  it('legacy single-token config: the single token is admin everywhere', async () => {
    const auditCalls: AuditCall[] = [];
    const single: ApiAuthConfig = { singleToken: SINGLE, roleTokens: [] };
    const { server, base } = await startServer(single, auditCalls);
    try {
      assert.equal((await call(base, 'POST', '/api/backup', SINGLE)).status, 200);
      assert.equal((await call(base, 'POST', '/api/tasks', SINGLE)).status, 200);
      assert.equal((await call(base, 'GET', '/api/projects', SINGLE)).status, 200);
      assert.equal((await call(base, 'GET', '/api/projects')).status, 401);
      const me = await call(base, 'GET', '/api/auth/whoami', SINGLE);
      assert.equal(me.body.role, 'admin');
      assert.equal(me.body.mode, 'single');
    } finally {
      await stopServer(server);
    }
  });
});

// ------------------------------------------------------- real server (e2e) --

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootRealServer(extraEnv: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-rbac-e2e-'));
  const port = 26_000 + Math.floor(Math.random() * 18_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    ...extraEnv,
  };
  if (!('FACTORY_API_TOKEN' in extraEnv)) delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_API_TOKENS' in extraEnv)) delete env['FACTORY_API_TOKENS'];
  if (!('FACTORY_RUNTIME_TOOLS' in extraEnv)) delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopRealServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
}

describe('RBAC on the real server binary (FACTORY_API_TOKENS wiring)', () => {
  it('gates by role end to end; whoami and audit agree', { timeout: 60_000 }, async () => {
    const { child, port } = await bootRealServer({
      FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR},admin:${ADMIN}`,
    });
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
      return { status: res.status, body: parsed as Record<string, unknown> };
    };
    try {
      // Health is public even with RBAC on.
      assert.equal((await call('GET', '/api/health')).status, 200);
      // Unauthenticated → 401.
      assert.equal((await call('GET', '/api/projects')).status, 401);
      // Viewer: reads pass, writes are 403.
      assert.equal((await call('GET', '/api/projects', VIEWER)).status, 200);
      assert.equal(
        (await call('POST', '/api/projects', VIEWER, { name: 'nope' })).status,
        403,
      );
      // Operator: daily writes pass, admin surfaces are 403.
      const created = await call('POST', '/api/projects', OPERATOR, { name: 'rbac-proj' });
      assert.equal(created.status, 201);
      assert.equal((await call('POST', '/api/backup', OPERATOR, {})).status, 403);
      assert.equal((await call('GET', '/api/backups', OPERATOR)).status, 403);
      // Admin: everything passes.
      assert.equal((await call('POST', '/api/backup', ADMIN, {})).status, 201);
      assert.equal((await call('GET', '/api/backups', ADMIN)).status, 200);
      // Whoami per caller.
      assert.equal((await call('GET', '/api/auth/whoami', VIEWER)).body.role, 'viewer');
      assert.equal((await call('GET', '/api/auth/whoami', OPERATOR)).body.role, 'operator');
      const meAdmin = await call('GET', '/api/auth/whoami', ADMIN);
      assert.equal(meAdmin.body.role, 'admin');
      assert.equal(meAdmin.body.mode, 'rbac');
      // The audit trail carries RBAC_DENIED and never a token value.
      const audit = await call('GET', '/api/audit?limit=200', ADMIN);
      assert.equal(audit.status, 200);
      const auditText = JSON.stringify(audit.body);
      assert.ok(auditText.includes(RBAC_DENIED_ACTION), 'RBAC_DENIED missing from audit');
      for (const t of [VIEWER, OPERATOR, ADMIN]) {
        assert.ok(!auditText.includes(t), 'token leaked into the audit trail');
      }
    } finally {
      await stopRealServer(child);
    }
  });

  it('single-token-only server keeps the pre-RBAC behavior (token = admin)', { timeout: 60_000 }, async () => {
    const { child, port } = await bootRealServer({ FACTORY_API_TOKEN: SINGLE });
    const base = `http://127.0.0.1:${port}`;
    try {
      const noTok = await fetch(`${base}/api/projects`);
      assert.equal(noTok.status, 401);
      const asAdmin = await fetch(`${base}/api/backup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SINGLE}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(asAdmin.status, 201);
      const me = await fetch(`${base}/api/auth/whoami`, {
        headers: { Authorization: `Bearer ${SINGLE}` },
      });
      assert.equal(((await me.json()) as { role: string }).role, 'admin');
    } finally {
      await stopRealServer(child);
    }
  });
});
