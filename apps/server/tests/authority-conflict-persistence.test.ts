/**
 * Authority-conflict registry persistence — §8.1, Batch 75 (F12).
 *
 * Until Batch 75 the registry was process-local memory: an OPEN
 * conflict died with the process. Now every mutation is written
 * through to fdb.authorityConflicts and the rows are loaded into a
 * fresh registry at boot (silent hydrate — no §81 re-emission).
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file). Boots dist/index.js, so this file runs after the
 * server build.
 *
 *  - boot A: two same-rank principals issue genuinely incompatible
 *    directives on the same run → conflict OPEN, target paused;
 *  - SIGKILL, boot B on the same DB: the OPEN conflict is back with
 *    the same id, the target is paused again, both directives are
 *    readable, and the §81 needsHuman upgrade was NOT re-emitted;
 *  - a new directive issued after hydrate gets a non-colliding id;
 *  - resolve on boot B → RESOLVED; SIGKILL, boot C on the same DB:
 *    no OPEN conflicts, the resolution survived, the target is
 *    unpaused.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'authority-persist-admin';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootRealServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 28_000 + Math.floor(Math.random() * 15_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKENS: 'admin:' + ADMIN,
    FACTORY_SECRETS_BACKEND: 'memory',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
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
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Rec = Record<string, unknown>;

async function kill(child: ChildProcess): Promise<void> {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
  await new Promise((resolve) => child.on('exit', resolve));
}

describe('authority-conflict registry survives restarts (§8.1, Batch 75)', () => {
  it('OPEN conflict + directives survive SIGKILL; resolution survives the next one', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ac-persist-'));
    const dbFile = join(dir, 'factory.db');
    const target = `run-ac-persist-${Date.now()}`;

    const call = async (port: number, method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: 'Bearer ' + ADMIN,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: Rec = {};
      try {
        parsed = JSON.parse(text) as Rec;
      } catch {
        /* non-JSON */
      }
      return { status: res.status, body: parsed };
    };

    const directive = (principalId: string, effect: string, targetId: string) => ({
      principalId,
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId,
      effect,
      instruction: `${principalId} says ${effect}`,
    });

    // ---- boot A: open a conflict ----
    const bootA = await bootRealServer(dbFile);
    let conflictId = '';
    let directiveIds: string[] = [];
    try {
      {
        const r = await call(bootA.port, 'POST', '/api/authority/directives', directive('mgr-a', 'ALLOW', target));
        assert.equal(r.status, 200);
        assert.equal(r.body['conflict'], null);
      }
      {
        const r = await call(bootA.port, 'POST', '/api/authority/directives', directive('mgr-b', 'BLOCK', target));
        assert.equal(r.status, 200);
        const conflict = r.body['conflict'] as Rec;
        assert.equal(conflict['status'], 'OPEN');
        assert.equal(r.body['paused'], true);
        conflictId = String(conflict['conflictId']);
        directiveIds = conflict['directiveIds'] as string[];
        assert.equal(directiveIds.length, 2);
      }
      // The registry wrote through: the rows are in the DB file already.
      {
        const r = await call(bootA.port, 'GET', '/api/authority/conflicts');
        assert.equal(r.status, 200);
        assert.equal((r.body['conflicts'] as Rec[]).length, 1);
      }
    } finally {
      await kill(bootA.child);
    }

    // ---- boot B: the OPEN conflict is back ----
    const bootB = await bootRealServer(dbFile);
    try {
      {
        const r = await call(bootB.port, 'GET', '/api/authority/conflicts');
        assert.equal(r.status, 200);
        const conflicts = r.body['conflicts'] as Rec[];
        assert.equal(conflicts.length, 1);
        assert.equal(conflicts[0]['conflictId'], conflictId);
        assert.equal(conflicts[0]['status'], 'OPEN');
        assert.deepEqual(conflicts[0]['directiveIds'], directiveIds);
      }
      {
        const r = await call(bootB.port, 'GET', `/api/authority/conflicts/${conflictId}`);
        assert.equal(r.status, 200);
        const conflict = r.body['conflict'] as Rec;
        assert.equal(conflict['status'], 'OPEN');
        const ds = r.body['directives'] as Rec[];
        assert.equal(ds.length, 2);
        assert.deepEqual(
          ds.map((d) => d['principalId']).sort(),
          ['mgr-a', 'mgr-b'],
        );
        assert.deepEqual(
          ds.map((d) => d['effect']).sort(),
          ['ALLOW', 'BLOCK'],
        );
      }
      // The target is paused again.
      {
        const r = await call(bootB.port, 'GET', `/api/authority/targets/run/${target}`);
        assert.equal(r.status, 200);
        assert.equal(r.body['paused'], true);
        assert.equal((r.body['openConflict'] as Rec)['conflictId'], conflictId);
        assert.equal((r.body['directives'] as Rec[]).length, 2);
      }
      // Hydrate did not re-emit the §81 upgrade: still exactly one row.
      {
        const r = await call(bootB.port, 'GET', '/api/needs-human');
        assert.equal(r.status, 200);
        const items = r.body['items'] as Rec[];
        assert.equal(items.length, 1);
        assert.equal(items[0]['reason'], 'ai-disagreement');
      }
      // Boot recorded the hydrate loudly.
      {
        const r = await call(bootB.port, 'GET', '/api/audit?limit=500');
        assert.equal(r.status, 200);
        const records = (Array.isArray(r.body) ? r.body : r.body['records']) as Rec[];
        assert.ok(records.map((i) => String(i['action'])).includes('AUTHORITY_CONFLICT_HYDRATED'));
      }
      // A new directive after hydrate gets a non-colliding id.
      {
        const other = `${target}-other`;
        const r = await call(bootB.port, 'POST', '/api/authority/directives', directive('mgr-c', 'ALLOW', other));
        assert.equal(r.status, 200);
        const d = r.body['directive'] as Rec;
        assert.ok(!directiveIds.includes(String(d['directiveId'])));
        const r2 = await call(bootB.port, 'POST', '/api/authority/directives', directive('mgr-d', 'BLOCK', other));
        assert.equal(r2.status, 200);
        const c2 = (r2.body['conflict'] as Rec)['conflictId'];
        assert.notEqual(String(c2), conflictId);
      }
      // Resolve the original conflict on boot B.
      {
        const r = await call(bootB.port, 'POST', `/api/authority/conflicts/${conflictId}/resolve`, {
          decidedByPrincipalId: 'owner-1',
          decidedByLevel: 'owner',
          winningDirectiveId: directiveIds[0],
          rationale: 'owner picks ALLOW',
        });
        assert.equal(r.status, 200);
        assert.equal((r.body['conflict'] as Rec)['status'], 'RESOLVED');
      }
    } finally {
      await kill(bootB.child);
    }

    // ---- boot C: the resolution survived; nothing is OPEN ----
    const bootC = await bootRealServer(dbFile);
    try {
      {
        const r = await call(bootC.port, 'GET', '/api/authority/conflicts?status=OPEN');
        assert.equal(r.status, 200);
        const opens = r.body['conflicts'] as Rec[];
        // The original conflict is resolved and gone from the OPEN
        // list; the probe conflict opened on boot B (never resolved)
        // is still OPEN — persistence works for untouched rows too.
        assert.ok(!opens.some((c) => c['conflictId'] === conflictId));
        assert.equal(opens.length, 1);
        assert.equal(opens[0]['targetId'], `${target}-other`);
        assert.equal(opens[0]['status'], 'OPEN');
      }
      {
        const r = await call(bootC.port, 'GET', `/api/authority/conflicts/${conflictId}`);
        assert.equal(r.status, 200);
        const conflict = r.body['conflict'] as Rec;
        assert.equal(conflict['status'], 'RESOLVED');
        assert.equal((conflict['resolution'] as Rec)['mode'], 'human');
        assert.equal((conflict['resolution'] as Rec)['winningDirectiveId'], directiveIds[0]);
      }
      {
        const r = await call(bootC.port, 'GET', `/api/authority/targets/run/${target}`);
        assert.equal(r.status, 200);
        assert.equal(r.body['paused'], false);
        assert.equal(r.body['openConflict'], null);
      }
      // Unknown conflict is still 404, not a manufactured row.
      {
        const r = await call(bootC.port, 'GET', '/api/authority/conflicts/ac-nope');
        assert.equal(r.status, 404);
      }
    } finally {
      await kill(bootC.child);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
