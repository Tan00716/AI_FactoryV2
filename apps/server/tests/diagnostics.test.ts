/**
 * Diagnostics bundle export HTTP tests (V3-#10) — boots the real
 * server (dist) with an isolated DB and exercises the whole feature:
 *
 *   GET  /api/diagnostics/preview   requiresConfirm, includes/excludes
 *   POST /api/diagnostics/export    no confirm -> 400
 *   POST /api/diagnostics/export    { confirm: true } -> 200 bundle
 *   redaction end to end: an audit record whose actor carries a
 *     synthetic ghp_ token shape must arrive in the bundle redacted
 *     (raw shape absent from the whole serialized bundle)
 *   GET  /api/audit                 DIAGNOSTICS_EXPORTED is recorded
 *   perf baseline: FACTORY_PERFBENCH_BASELINE file is summarized
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/diagnostics.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

const GHP = 'ghp_' + 'a'.repeat(36);

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-diag-http-'));
  const baselinePath = path.join(dir, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ tasks: [{ name: 'server-boot', ms: 1234 }, { name: 'search-small', ms: 33 }] }),
  );
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_PERFBENCH_BASELINE: baselinePath,
    // Test-harness opt-in (same as the V3-#5 smoke script): the server
    // is fail-closed without a token even on loopback since V3-#1, so
    // diagnostics HTTP tests boot with explicit open-local mode.
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not start in 30s');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => {
          s.end();
          resolve();
        });
        s.once('error', reject);
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { port, proc, dir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
  fs.rmSync(r.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('diagnostics bundle export end to end over HTTP', async () => {
  const srv = await startServer();
  try {
    // 1. Preview: confirm gate + includes/excludes, no bundle built.
    let r = await api(srv.port, 'GET', '/api/diagnostics/preview');
    assert.equal(r.status, 200);
    assert.equal(r.body.requiresConfirm, true);
    assert.ok(Array.isArray(r.body.includes) && r.body.includes.length > 0);
    assert.ok(Array.isArray(r.body.excludes) && r.body.excludes.some((e: string) => /secret/i.test(e)));
    assert.ok(r.body.noticeZh.length > 0 && r.body.noticeEn.length > 0);

    // 2. Export without confirm is refused.
    r = await api(srv.port, 'POST', '/api/diagnostics/export', {});
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'DIAGNOSTICS_CONFIRM_REQUIRED');

    // 3. Seed an audit record whose actor carries a synthetic token
    // shape (egress PUT takes the actor from the body, verbatim).
    r = await api(srv.port, 'PUT', '/api/egress/config', {
      scope: 'global',
      enabled: true,
      defaultPolicy: 'deny',
      rules: [],
      actor: `operator-${GHP}`,
    });
    assert.equal(r.status, 200);

    // 4. Confirmed export: sections present, baseline summarized.
    r = await api(srv.port, 'POST', '/api/diagnostics/export', { confirm: true });
    assert.equal(r.status, 200);
    const b = r.body.bundle;
    assert.equal(b.meta.bundleVersion, 1);
    assert.equal(b.meta.appVersion, '0.2.0');
    assert.equal(b.configSnapshot.authMode, 'open');
    assert.equal(b.configSnapshot.egress.enabled, true);
    assert.equal(b.configSnapshot.egress.defaultPolicy, 'deny');
    assert.equal(b.perfBaseline.available, true);
    assert.equal(b.perfBaseline.tasks.find((t: any) => t.name === 'server-boot')?.ms, 1234);
    assert.ok(typeof b.reportHtml === 'string' && b.reportHtml.includes('AI Factory diagnostics bundle'));

    // 5. Redaction end to end: the raw token shape appears nowhere in
    // the serialized bundle, and no audit details payloads leak.
    const serialized = JSON.stringify(b);
    assert.ok(!serialized.includes(GHP), 'raw token shape leaked into bundle');
    assert.ok(!serialized.includes('ghp_'), 'token prefix leaked into bundle');
    assert.ok(!serialized.includes('details_json'), 'audit details must not be carried');
    assert.ok(serialized.includes('[REDACTED:github-pat-classic]'), 'actor token shape must be redacted');

    // 6. The export itself is audited.
    r = await api(srv.port, 'GET', '/api/audit?limit=100');
    assert.equal(r.status, 200);
    const exported = (r.body as any[]).find((rec) => rec.action === 'DIAGNOSTICS_EXPORTED');
    assert.ok(exported, 'DIAGNOSTICS_EXPORTED audit record missing');
    assert.equal(exported.entityId, b.meta.bundleId);
  } finally {
    await stopServer(srv);
  }
});
