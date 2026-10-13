/**
 * MCP trust flow over HTTP — Batch 20 (§46).
 *
 * Closes the KNOWN_LIMITATIONS deadlock from Batch 19: a freshly
 * registered server defaults to approvalPolicy BLOCKED and there was
 * no HTTP path to move it out — POST /api/mcp/launch just answered
 * 403 forever.
 *
 * Two layers:
 *  1. RBAC classification (requiredRoleFor, no server needed):
 *     trust reads are viewer, approve/deny/revoke are admin.
 *  2. The real server binary (dist/index.js) booted with
 *     FACTORY_API_TOKENS + FACTORY_SECRETS_BACKEND=memory:
 *       register (BLOCKED) -> launch 403 with an actionable
 *       MCP_TRUST_NOT_APPROVED pointing at /trust/approve ->
 *       approve (admin) -> install -> launch 201 (x2 sleepers) ->
 *       revoke -> running launches stopped, policy back to BLOCKED ->
 *       new launch 403;
 *       plus the deny path, illegal transitions (409), bad input
 *       (400), unknown servers (404), and viewer/operator RBAC
 *       denials on the trust mutations.
 *
 * Imports src/auth.ts from src (type-stripping, like the other src
 * tests); the e2e half boots dist/index.js, so this file runs after
 * the server build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRoleFor } from '../src/auth.ts';

const VIEWER = 'trust-viewer-aaa';
const OPERATOR = 'trust-operator-bbb';
const ADMIN = 'trust-admin-ccc';

describe('requiredRoleFor /api/mcp/servers/:id/trust (§46 RBAC classification)', () => {
  it('trust reads are viewer, approve/deny/revoke are admin', () => {
    assert.equal(requiredRoleFor('GET', '/api/mcp/servers/db@1.0.0/trust'), 'viewer');
    assert.equal(requiredRoleFor('POST', '/api/mcp/servers/db@1.0.0/trust/approve'), 'admin');
    assert.equal(requiredRoleFor('POST', '/api/mcp/servers/db@1.0.0/trust/deny'), 'admin');
    assert.equal(requiredRoleFor('POST', '/api/mcp/servers/db@1.0.0/trust/revoke'), 'admin');
  });
});

// ------------------------------------------------------- real server (e2e) --

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootRealServer(extraEnv: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-trust-e2e-'));
  const port = 26_000 + Math.floor(Math.random() * 18_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    ...extraEnv,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    if (!(k in extraEnv)) delete env[k];
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

describe('MCP trust flow end to end (§46)', () => {
  it('register BLOCKED -> launch 403 w/ pointer -> approve -> install -> launch -> revoke stops runs -> launch 403 again', { timeout: 120_000 }, async () => {
    const { child, port } = await bootRealServer({
      FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR},admin:${ADMIN}`,
      FACTORY_SECRETS_BACKEND: 'memory',
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
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
      return { status: res.status, body: parsed, text };
    };
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const name = `trustchain-${suffix}`;
    const version = '1.0.0';
    const id = `${name}@${version}`;
    try {
      // 1. Fresh registration defaults to BLOCKED (unknown MCP = BLOCK, §73).
      const reg = await call('POST', '/api/mcp/register', ADMIN, {
        server: { name, version, provider: 'local', transport: 'stdio' },
      });
      assert.equal(reg.status, 201);
      assert.equal((reg.body.server as Record<string, unknown>).approvalPolicy, 'BLOCKED');
      assert.equal((reg.body.server as Record<string, unknown>).trustLevel, 'UNKNOWN');

      // 2. Trust query: honest presentation, assessment null (never assessed).
      const q = await call('GET', `/api/mcp/servers/${id}/trust`, ADMIN);
      assert.equal(q.status, 200);
      assert.equal(q.body.approvalPolicy, 'BLOCKED');
      assert.equal(q.body.assessment, null);
      assert.equal(q.body.launchable, false);
      assert.ok((q.body.nextSteps as string[]).some((s) => s.includes('/trust/approve')));

      // 3. Launch on a BLOCKED server: 403 with the actionable pointer, not a dead end.
      const l0 = await call('POST', '/api/mcp/launch', ADMIN, {
        name, version, command: 'node', args: ['-e', '1'],
      });
      assert.equal(l0.status, 403);
      assert.equal(l0.body.code, 'MCP_TRUST_NOT_APPROVED');
      assert.ok((l0.text as string).includes('/trust/approve'));

      // 4. RBAC: viewer and operator cannot approve.
      const rv = await call('POST', `/api/mcp/servers/${id}/trust/approve`, VIEWER, {
        trustLevel: 'HIGH', approvalPolicy: 'AUTO',
      });
      assert.equal(rv.status, 403);
      const ro = await call('POST', `/api/mcp/servers/${id}/trust/approve`, OPERATOR, {
        trustLevel: 'HIGH', approvalPolicy: 'AUTO',
      });
      assert.equal(ro.status, 403);

      // 5. Bad input is 400.
      const b1 = await call('POST', `/api/mcp/servers/${id}/trust/approve`, ADMIN, {
        trustLevel: 'SUSPICIOUS', approvalPolicy: 'AUTO',
      });
      assert.equal(b1.status, 400);
      const b2 = await call('POST', `/api/mcp/servers/${id}/trust/approve`, ADMIN, {
        trustLevel: 'HIGH', approvalPolicy: 'BLOCKED',
      });
      assert.equal(b2.status, 400);

      // 6. Approve: BLOCKED -> AUTO, audited, assessment recorded.
      const ap = await call('POST', `/api/mcp/servers/${id}/trust/approve`, ADMIN, {
        trustLevel: 'HIGH', approvalPolicy: 'AUTO', basis: 'vendor-pinned test server', reviewer: 'admin-test',
      });
      assert.equal(ap.status, 200);
      assert.equal(ap.body.approvalPolicy, 'AUTO');
      assert.equal(ap.body.trustLevel, 'HIGH');
      assert.equal((ap.body.assessment as Record<string, unknown>).assessedBy, 'admin-test');
      assert.ok((ap.body.message as string).includes('/api/mcp/install'));

      // 7. Approving an already-approved server is an illegal transition: 409.
      const ap2 = await call('POST', `/api/mcp/servers/${id}/trust/approve`, ADMIN, {
        trustLevel: 'HIGH', approvalPolicy: 'AUTO',
      });
      assert.equal(ap2.status, 409);
      assert.equal(ap2.body.code, 'MCP_TRUST_TRANSITION');

      // 8. Install (AUTO installs immediately) then launch twice — both spawn.
      const ins = await call('POST', '/api/mcp/install', ADMIN, { name, version });
      assert.equal(ins.status, 200);
      assert.equal(ins.body.status, 'INSTALLED');
      const l1 = await call('POST', '/api/mcp/launch', ADMIN, {
        name, version, command: 'node', args: ['-e', 'setTimeout(()=>{},30000)'],
      });
      assert.equal(l1.status, 201);
      const l2 = await call('POST', '/api/mcp/launch', ADMIN, {
        name, version, command: 'node', args: ['-e', 'setTimeout(()=>{},30000)'],
      });
      assert.equal(l2.status, 201);

      // 9. Revoke: trust drops, server uninstalled, running launches stopped.
      const rev = await call('POST', `/api/mcp/servers/${id}/trust/revoke`, ADMIN, {
        reason: 'test revocation', reviewer: 'admin-test',
      });
      assert.equal(rev.status, 200);
      assert.equal(rev.body.approvalPolicy, 'BLOCKED');
      assert.equal(rev.body.trustLevel, 'LOW');
      assert.equal(rev.body.stoppedLaunches, 2);

      // 10. The stopped launches are actually dead.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const ls = await call('GET', '/api/mcp/launches', ADMIN);
        const mine = (ls.body.launches as Array<Record<string, unknown>>)
          .filter((r) => r.server === name);
        assert.equal(mine.length, 2);
        if (mine.every((r) => r.alive === false)) break;
        if (Date.now() > deadline) throw new Error('revoked launches did not stop in 10000ms');
        await new Promise((r) => setTimeout(r, 200));
      }

      // 11. New launches are refused again.
      const l3 = await call('POST', '/api/mcp/launch', ADMIN, {
        name, version, command: 'node', args: ['-e', '1'],
      });
      assert.equal(l3.status, 403);

      // 12. Revoking a BLOCKED server is an illegal transition: 409.
      const rev2 = await call('POST', `/api/mcp/servers/${id}/trust/revoke`, ADMIN, { reason: 'x' });
      assert.equal(rev2.status, 409);

      // 13. Deny on a BLOCKED server records the decision and stays BLOCKED.
      const dn = await call('POST', `/api/mcp/servers/${id}/trust/deny`, ADMIN, {
        reason: 're-denied after revocation', reviewer: 'admin-test',
      });
      assert.equal(dn.status, 200);
      assert.equal(dn.body.approvalPolicy, 'BLOCKED');
      assert.equal(dn.body.denied, true);

      // 14. Denying an approved server is an illegal transition: 409.
      const name2 = `trustdeny-${suffix}`;
      const id2 = `${name2}@${version}`;
      const reg2 = await call('POST', '/api/mcp/register', ADMIN, {
        server: { name: name2, version, provider: 'local', transport: 'stdio' },
      });
      assert.equal(reg2.status, 201);
      const ap3 = await call('POST', `/api/mcp/servers/${id2}/trust/approve`, ADMIN, {
        trustLevel: 'MEDIUM', approvalPolicy: 'HUMAN_APPROVAL', basis: 'deny-transition test',
      });
      assert.equal(ap3.status, 200);
      const dn2 = await call('POST', `/api/mcp/servers/${id2}/trust/deny`, ADMIN, { reason: 'no' });
      assert.equal(dn2.status, 409);
      assert.equal(dn2.body.code, 'MCP_TRUST_TRANSITION');
      // And the denial reason is recorded on a real denial.
      const reg3 = await call('POST', '/api/mcp/register', ADMIN, {
        server: { name: `trustdeny2-${suffix}`, version, provider: 'local', transport: 'stdio' },
      });
      assert.equal(reg3.status, 201);
      const dn3 = await call('POST', `/api/mcp/servers/trustdeny2-${suffix}@${version}/trust/deny`, ADMIN, {
        reason: 'untrusted source', reviewer: 'admin-test',
      });
      assert.equal(dn3.status, 200);
      const q3 = await call('GET', `/api/mcp/servers/trustdeny2-${suffix}@${version}/trust`, ADMIN);
      assert.equal((q3.body.assessment as Record<string, unknown>).notes, 'untrusted source');
      const l4 = await call('POST', '/api/mcp/launch', ADMIN, {
        name: `trustdeny2-${suffix}`, version, command: 'node', args: ['-e', '1'],
      });
      assert.equal(l4.status, 403);
      assert.equal(l4.body.code, 'MCP_TRUST_NOT_APPROVED');
    } finally {
      await stopRealServer(child);
    }
  });

  it('unknown servers answer 404 on the trust surface', { timeout: 60_000 }, async () => {
    const { child, port } = await bootRealServer({
      FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR},admin:${ADMIN}`,
      FACTORY_SECRETS_BACKEND: 'memory',
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      const g = await fetch(`${base}/api/mcp/servers/nope@9.9.9/trust`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      });
      assert.equal(g.status, 404);
      const p = await fetch(`${base}/api/mcp/servers/nope@9.9.9/trust/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trustLevel: 'HIGH', approvalPolicy: 'AUTO' }),
      });
      assert.equal(p.status, 404);
      const bad = await fetch(`${base}/api/mcp/servers/no-at-sign/trust`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      });
      assert.equal(bad.status, 400);
    } finally {
      await stopRealServer(child);
    }
  });
});
