/**
 * §81 needsHuman upgrade records survive restarts — Batch 36.
 *
 * Until Batch 36, packages/autonomy's needsHuman() was a pure function
 * with tests and zero server emission points and zero stores anywhere.
 * Now the one determinate server emission path is AUTHORITY_CONFLICT
 * entering OPEN (the §81 'ai-disagreement' trigger):
 *  - two same-rank principals issue genuinely incompatible directives
 *    on the same run → conflict OPEN, target paused;
 *  - the registry's onConflictOpened hook raises a needsHuman upgrade
 *    row (write-through, NEEDS_HUMAN_RAISED audit);
 *  - resolving the underlying authority conflict does NOT touch the
 *    row — nothing auto-resolves it;
 *  - a human marks 'acknowledged'/'resolved' explicitly via
 *    POST /api/needs-human/:id/resolve (409 on terminal re-resolve).
 *
 * Pinned on the REAL server binary (boot → SIGKILL → reboot on the
 * same DB file). Boots dist/index.js, so this file runs after the
 * server build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = 'needs-human-restart-admin';

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

function auditActions(body: Rec): string[] {
  const records = (Array.isArray(body) ? body : body['records']) as Rec[];
  return records.map((i) => String(i['action']));
}

describe('needsHuman upgrades survive restarts (§81, Batch 36)', () => {
  it('OPEN conflict raises an upgrade; nothing auto-resolves it; human resolution persists', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-nhu-restart-'));
    const dbFile = join(dir, 'factory.db');

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

    const directive = (principalId: string, effect: string) => ({
      principalId,
      authorityLevel: 'manager',
      targetKind: 'run',
      targetId: 'run-nhu-1',
      effect,
      instruction: `${principalId} says ${effect}`,
    });

    const bootA = await bootRealServer(dbFile);
    let conflictId = '';
    let upgradeId = '';
    try {
      // No upgrades at boot.
      {
        const r = await call(bootA.port, 'GET', '/api/needs-human');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body['items'], []);
      }

      // First directive: no conflict.
      {
        const r = await call(bootA.port, 'POST', '/api/authority/directives', directive('mgr-a', 'ALLOW'));
        assert.equal(r.status, 200);
        assert.equal(r.body['conflict'], null);
      }

      // Second, incompatible, same-rank directive → OPEN conflict.
      {
        const r = await call(bootA.port, 'POST', '/api/authority/directives', directive('mgr-b', 'BLOCK'));
        assert.equal(r.status, 200);
        const conflict = r.body['conflict'] as Rec;
        assert.equal(conflict['status'], 'OPEN');
        assert.equal(r.body['paused'], true);
        conflictId = String(conflict['conflictId']);
      }

      // The §81 upgrade row was raised.
      {
        const r = await call(bootA.port, 'GET', '/api/needs-human');
        assert.equal(r.status, 200);
        const items = r.body['items'] as Rec[];
        assert.equal(items.length, 1);
        const row = items[0];
        assert.equal(row['reason'], 'ai-disagreement');
        assert.equal(row['reasonZh'], 'AI 分歧');
        assert.equal(row['status'], 'open');
        assert.equal(row['recipient'], null);
        assert.equal(row['requiredDeciderLevel'], 'security_authority');
        assert.ok(String(row['source']).startsWith('authority-conflict:'));
        assert.ok(String(row['source']).includes(conflictId));
        upgradeId = String(row['id']);
      }

      // Raised intent is in the audit chain.
      {
        const r = await call(bootA.port, 'GET', '/api/audit?limit=300');
        assert.equal(r.status, 200);
        assert.ok(auditActions(r.body).includes('NEEDS_HUMAN_RAISED'));
      }

      // Resolving the underlying authority conflict does NOT touch the
      // upgrade row — nothing auto-resolves it.
      {
        const c = await call(bootA.port, 'GET', `/api/authority/conflicts/${conflictId}`);
        const conflict = c.body['conflict'] as Rec;
        const r = await call(bootA.port, 'POST', `/api/authority/conflicts/${conflictId}/resolve`, {
          decidedByPrincipalId: 'owner-1',
          decidedByLevel: 'owner',
          winningDirectiveId: (conflict['directiveIds'] as string[])[0],
          rationale: 'owner picks ALLOW',
        });
        assert.equal(r.status, 200);
        assert.equal((r.body['conflict'] as Rec)['status'], 'RESOLVED');
        const u = await call(bootA.port, 'GET', `/api/needs-human/${upgradeId}`);
        assert.equal((u.body['upgrade'] as Rec)['status'], 'open');
      }

      // Kill mid-open-upgrade; reboot on the same DB.
      bootA.child.kill('SIGKILL');
      await new Promise((resolve) => bootA.child.on('exit', resolve));
    } finally {
      try {
        bootA.child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }

    const bootB = await bootRealServer(dbFile);
    try {
      // The open row survived the restart as-is (nothing to demote).
      {
        const r = await call(bootB.port, 'GET', `/api/needs-human/${upgradeId}`);
        assert.equal(r.status, 200);
        const row = r.body['upgrade'] as Rec;
        assert.equal(row['status'], 'open');
        assert.equal(row['reason'], 'ai-disagreement');
      }

      // A human marks the resolution explicitly.
      {
        const r = await call(bootB.port, 'POST', `/api/needs-human/${upgradeId}/resolve`, {
          resolution: 'resolved',
          resolvedBy: 'owner-1',
          note: 'reviewed the conflict decision, agree',
        });
        assert.equal(r.status, 200);
        const row = r.body['upgrade'] as Rec;
        assert.equal(row['status'], 'resolved');
        assert.equal(row['resolvedBy'], 'owner-1');
        assert.equal(row['resolution'], 'reviewed the conflict decision, agree');
        assert.ok(typeof row['resolvedAt'] === 'number');
      }

      // Terminal rows are never rewritten.
      {
        const r = await call(bootB.port, 'POST', `/api/needs-human/${upgradeId}/resolve`, {
          resolution: 'acknowledged',
        });
        assert.equal(r.status, 409);
        assert.equal(r.body['error'], 'NEEDS_HUMAN_ALREADY_TERMINAL');
      }

      // Status filter reflects the resolution.
      {
        const r = await call(bootB.port, 'GET', '/api/needs-human?status=open');
        assert.deepEqual(r.body['items'], []);
        const r2 = await call(bootB.port, 'GET', '/api/needs-human?status=resolved');
        assert.equal((r2.body['items'] as Rec[]).length, 1);
      }

      // Resolution is in the audit chain.
      {
        const r = await call(bootB.port, 'GET', '/api/audit?limit=300');
        assert.equal(r.status, 200);
        const actions = auditActions(r.body);
        assert.ok(actions.includes('NEEDS_HUMAN_RAISED'));
        assert.ok(actions.includes('NEEDS_HUMAN_RESOLVED'));
      }

      // Unknown id → 404, not a manufactured row.
      {
        const r = await call(bootB.port, 'POST', '/api/needs-human/nhu-nope/resolve', {
          resolution: 'resolved',
        });
        assert.equal(r.status, 404);
      }

      bootB.child.kill('SIGKILL');
      await new Promise((resolve) => bootB.child.on('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    } finally {
      try {
        bootB.child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  });
});
