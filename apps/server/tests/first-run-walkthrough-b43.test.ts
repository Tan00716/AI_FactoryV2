/**
 * First-run walkthrough, sixth edition — B41–B42 chains (Batch 43-3).
 *
 * Walks the four §81 emission points that landed in B41–B42, against the
 * real compiled server over a fresh temp SQLite file, pure HTTP, zero
 * mocks:
 *
 *   P1 — policy-violation (Batch 41): the same granter hits the §8.2
 *        task-scope ceiling 3× (POST /api/workforce/employees with an
 *        empty taskScope → 403 each, audited TASK_SCOPE_CEILING_DENIED)
 *        → one OPEN 'policy-violation' upgrade (source
 *        'policy-denial:<granter>', recipient null, 'operator'). A single
 *        denial by another granter emits nothing — the policy working is
 *        not a violation.
 *   S1 — brute-force → security-issue (Batch 42): the server boots with
 *        FACTORY_API_TOKENS set. 1× wrong Bearer → 401 and no upgrade;
 *        then 10× wrong Bearer back-to-back from the same loopback source
 *        → one OPEN 'security-issue' upgrade (source
 *        'auth-bruteforce:<addr>', recipient null, 'admin'). Every admin
 *        read in this leg comes from the same loopback IP, so reads are
 *        ordered at phase ends (a successful auth clears the source's
 *        counter — the documented rule).
 *   R1 — redaction hits → security-issue (Batch 42): a real secret is
 *        stored via PUT /api/secrets/:name (metadata only, value never
 *        echoed), then POST /api/exec injects it into `printenv` output
 *        via secretEnv 3×. Each output carries the injected value → 3
 *        SECRET_REDACTED_HIT detection events (audit carries hit counts
 *        and the command, never secret content) → one OPEN
 *        'security-issue' upgrade (source
 *        'redaction-monitor:exec:printenv …', recipient null, 'operator').
 *        The returned output is asserted redacted (no sentinel, '***'
 *        marker present).
 *   Q1 — requirement-ambiguity (Batch 42): POST /api/requirements then
 *        3× POST /api/requirements/:id/ac-refinement → one OPEN
 *        'requirement-ambiguity' upgrade (source
 *        'requirement-refinement:<id>', recipient null, 'manager'); the
 *        4th refinement → 409 REQUIREMENT_REFINEMENT_PAUSED (the circuit
 *        breaker is real, not decorative).
 *
 * Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md (Batch 43 section,
 * F19+). v4 remains the authority for the B31–B36 governance chains and
 * v5 for the B37–B40 chains; v6 covers B41–B42 only.
 *
 * Requires the workspace build (root `npm run build`); run with
 * `npm run demo:e2e-v6`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN_TOKEN = 'walk-b43-admin-token';

// ---------------------------------------------------------------- helpers --

type Json = Record<string, unknown>;

const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}` };

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = adminHeaders,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Auth enabled for the S1 brute-force leg (wrong tokens → real 401s).
    FACTORY_API_TOKENS: `admin:${ADMIN_TOKEN}`,
    // Hermetic secrets: point the file vault at the temp dir (the R1 leg
    // stores a real secret there).
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-b43-secrets-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in env)) delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => s.child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function openNeedsHuman(port: number): Promise<Array<Json>> {
  const r = await api(port, 'GET', '/api/needs-human?status=open');
  assert.equal(r.status, 200);
  return (r.body['items'] ?? []) as Array<Json>;
}

function auditRecords(body: unknown): Array<Json> {
  // GET /api/audit returns a bare array (newest first).
  if (Array.isArray(body)) return body as Array<Json>;
  return (((body as Json)['records'] ?? []) as Array<Json>);
}

// ------------------------------------------------------------------ the run --

describe('first-run walkthrough, sixth edition — B41–B42 §81 chains (Batch 43-3)', () => {
  it('policy-violation → brute-force → redaction hits → requirement-ambiguity', { timeout: 600_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b43-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    try {
      server = await bootServer(dbFile);
      const port = server.port;

      // --------------------------------------------------------------- S1 --
      // Brute-force → 'security-issue' (Batch 42), pure HTTP. A single
      // 401 is the gate working — no emission. 10 wrong Bearers
      // back-to-back from the same loopback source cross the
      // BRUTE_FORCE_THRESHOLD (10 in 5 min) → one OPEN upgrade.
      const badAuth = { Authorization: 'Bearer wrong-token-b43' };
      const knock = async () => {
        const r = await api(port, 'GET', '/api/tasks', undefined, badAuth);
        assert.equal(r.status, 401, 'wrong token → uniform 401');
      };
      await knock();
      let upgrades = await openNeedsHuman(port);
      assert.equal(
        upgrades.filter(
          (u) => u['reason'] === 'security-issue' && String(u['source'] ?? '').startsWith('auth-bruteforce:'),
        ).length,
        0,
        'a single 401 emits nothing',
      );
      // The admin read above is a successful auth from the same loopback
      // IP, so it cleared the source's counter (the documented
      // "legit login clears" rule). The attack phase needs a full fresh
      // 10 denials back-to-back, with no read between them.
      for (let i = 0; i < 10; i++) await knock(); // 10 total, back-to-back
      upgrades = await openNeedsHuman(port);
      const bfRows = upgrades.filter(
        (u) => u['reason'] === 'security-issue' && String(u['source'] ?? '').startsWith('auth-bruteforce:'),
      );
      assert.equal(bfRows.length, 1, 'exactly one OPEN brute-force upgrade after 10× 401');
      const bf = bfRows[0]!;
      assert.equal(bf['recipient'], null, 'recipient is null — no named human accounts');
      assert.equal(bf['requiredDeciderLevel'], 'admin', 'brute-force is an admin-surface alert');
      assert.ok(
        String(bf['detailJson'] ?? '').includes('10 failed API authentications'),
        'detail names the counted fact',
      );
      t.diagnostic(`S1 brute-force → needs-human ${String(bf['id']).slice(0, 8)}… (admin)`);

      // --------------------------------------------------------------- P1 --
      // Policy-violation (Batch 41): the same granter denied 3× at the
      // §8.2 task-scope ceiling → emission. Single denial (other granter)
      // → nothing.
      const denyOnce = async (granter: string) => {
        const r = await api(port, 'POST', '/api/workforce/employees', {
          jobTitle: 'Walk B43 Engineer',
          requestedBy: granter,
          taskScope: [],
        });
        assert.equal(r.status, 403, 'empty task scope → 403 ceiling denial');
      };
      await denyOnce('walk-granter-b43-single');
      upgrades = await openNeedsHuman(port);
      assert.equal(
        upgrades.filter((u) => u['reason'] === 'policy-violation').length,
        0,
        'a single ceiling denial is the policy working — no emission',
      );
      const granter = 'walk-granter-b43';
      await denyOnce(granter);
      await denyOnce(granter);
      await denyOnce(granter);
      upgrades = await openNeedsHuman(port);
      const pvRows = upgrades.filter((u) => u['reason'] === 'policy-violation');
      assert.equal(pvRows.length, 1, 'exactly one OPEN policy-violation upgrade after 3 denials');
      const pv = pvRows[0]!;
      assert.equal(pv['source'], `policy-denial:${granter}`);
      assert.equal(pv['recipient'], null);
      assert.equal(pv['requiredDeciderLevel'], 'operator');
      const pvDetail = JSON.parse(String(pv['detailJson'] ?? '{}')) as Json;
      assert.equal(pvDetail['granter'], granter);
      assert.equal(pvDetail['denialCount'], 3);
      // F19: the "the policy held on every attempt — no elevation
      // occurred" wording is built into the transient needsHuman() call
      // but is NOT persisted into detailJson (only brute-force's builder
      // keeps its narrative). Assert only what the stored record says.
      t.diagnostic('P1 note: honest wording present in builder, absent from persisted detailJson (finding F19)');
      t.diagnostic(`P1 policy-violation → needs-human ${String(pv['id']).slice(0, 8)}… (operator)`);

      // --------------------------------------------------------------- R1 --
      // Redaction hits → 'security-issue' (Batch 42): store a real secret
      // (metadata only over HTTP), then run a command whose output
      // contains the injected value 3× → 3 SECRET_REDACTED_HIT detection
      // events from one source → escalation.
      const sentinel = `walk-b43-sentinel-${Date.now()}`;
      const put = await api(port, 'PUT', '/api/secrets/walk-b43-leak', {
        value: sentinel,
        purpose: 'walkthrough-b43',
      });
      assert.equal(put.status, 200, 'secret stored');
      assert.ok(!('value' in put.body), 'PUT response is metadata only');
      const redactedFrom = (out: unknown) => {
        const s = String(out ?? '');
        assert.ok(!s.includes(sentinel), 'secret value is redacted from exec output');
        assert.ok(s.includes('***'), 'redaction marker present');
      };
      for (let i = 0; i < 3; i++) {
        const ex = await api(port, 'POST', '/api/exec', {
          command: 'printenv WALK_B43_VAR',
          secretEnv: { WALK_B43_VAR: 'walk-b43-leak' },
        });
        assert.equal(ex.status, 200, 'exec runs');
        redactedFrom(ex.body['output']);
      }
      const audit = await api(port, 'GET', '/api/audit?limit=2000');
      assert.equal(audit.status, 200);
      const hits = auditRecords(audit.body).filter((r) => r['action'] === 'SECRET_REDACTED_HIT');
      assert.ok(hits.length >= 3, `at least 3 detection events, got ${hits.length}`);
      assert.ok(
        !JSON.stringify(hits).includes(sentinel),
        'detection events never carry secret content',
      );
      upgrades = await openNeedsHuman(port);
      const rhRows = upgrades.filter(
        (u) => u['reason'] === 'security-issue' && String(u['source'] ?? '').startsWith('redaction-monitor:exec:'),
      );
      assert.equal(rhRows.length, 1, 'exactly one OPEN redaction-pattern upgrade');
      const rh = rhRows[0]!;
      assert.equal(rh['recipient'], null);
      assert.equal(rh['requiredDeciderLevel'], 'operator');
      t.diagnostic(`R1 redaction hits → needs-human ${String(rh['id']).slice(0, 8)}… (operator)`);

      // --------------------------------------------------------------- Q1 --
      // Requirement-ambiguity (Batch 42): 3 consecutive AC_REFINEMENT
      // versions → emission; the 4th autonomous refinement → 409
      // (the circuit breaker is real).
      const reqId = 'REQ-WALK-B43';
      const created = await api(port, 'POST', '/api/requirements', {
        id: reqId,
        businessGoal: 'walk the B42 ambiguity chain',
        acceptanceCriteria: [
          {
            id: 'AC-001',
            description: 'the thing works',
            verificationType: 'AUTOMATED_TEST',
            verifiedBy: 'INDEPENDENT_QA',
            expectedEvidence: 'qa_result with verdict PASS',
            applicableEnvironments: ['DEV'],
          },
        ],
      });
      assert.equal(created.status, 201, 'requirement created');
      const refine = async (note: string) =>
        api(port, 'POST', `/api/requirements/${reqId}/ac-refinement`, {
          acId: 'AC-001',
          patch: { description: `clarified: ${note}` },
          by: 'agent:pm-walk-b43',
        });
      assert.equal((await refine('one')).status, 201);
      assert.equal((await refine('two')).status, 201);
      assert.equal((await refine('three')).status, 201);
      upgrades = await openNeedsHuman(port);
      const raRows = upgrades.filter((u) => u['reason'] === 'requirement-ambiguity');
      assert.equal(raRows.length, 1, 'exactly one OPEN requirement-ambiguity upgrade');
      const ra = raRows[0]!;
      assert.equal(ra['source'], `requirement-refinement:${reqId}`);
      assert.equal(ra['recipient'], null);
      assert.equal(ra['requiredDeciderLevel'], 'manager');
      const paused = await refine('four');
      assert.equal(paused.status, 409, '4th refinement while OPEN → 409');
      assert.equal(paused.body['code'], 'REQUIREMENT_REFINEMENT_PAUSED');
      t.diagnostic(`Q1 requirement-ambiguity → needs-human ${String(ra['id']).slice(0, 8)}… (manager); 4th refinement 409`);

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
