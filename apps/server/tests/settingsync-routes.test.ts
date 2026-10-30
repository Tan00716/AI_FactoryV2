/**
 * Settings sync HTTP tests — R7-#10.
 * Boots the real server (dist) with an isolated DB and exercises the
 * whole feature end to end:
 *
 *   GET  /api/settingsync/export      seeded keybindings + rules
 *   POST /api/settingsync/preview     first import (no baseline): modified
 *   POST /api/settingsync/apply       applies, writes files, sets baseline
 *   conflict flow                     local change + remote change on the
 *                                     same key -> conflict, 409 without
 *                                     resolution, applied with one
 *   removed flow                      dropped key -> removed, keep wins
 *   invalid docs                      unknown section -> 400, secret
 *                                     payload -> 400, nothing written
 *   audit                             SETTINGSYNC_APPLIED carries keys
 *                                     only, never values
 *   remote                            PUT url -> push (Bearer auth) ->
 *                                     pull previews the pushed doc
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/settingsync-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');
const TOKEN = 'test-settingsync-token-r7-10';

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  dataDir: string;
  rulesDir: string;
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
      srv.close(() => resolve((addr as net.AddressInfo).port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-settingsync-http-'));
  const dataDir = path.join(dir, 'data');
  const rulesDir = path.join(dir, 'rules');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'keybindings.json'),
    JSON.stringify([{ command: 'palette.toggle', key: 'ctrl+k' }]),
    'utf8',
  );
  fs.writeFileSync(
    path.join(rulesDir, 'rules.json'),
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'r1',
          name: 'seed-rule',
          scope: 'global',
          content: 'seed content',
          enabled: true,
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
    'utf8',
  );
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'db', 'factory.db'),
    AI_FACTORY_DATA_DIR: dataDir,
    AI_FACTORY_GLOBAL_RULES_DIR: rulesDir,
    FACTORY_PROJECTS_ROOT: path.join(dir, 'projects'),
    FACTORY_INSPECT_ROOTS: dir,
    FACTORY_SHADOW_ROOTS: dir,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
    FACTORY_SETTINGSYNC_TOKEN: TOKEN,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR']) delete env[k];
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
  return { port, proc, dir, dataDir, rulesDir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
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
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

function docWith(sections: Record<string, unknown>): Record<string, unknown> {
  return {
    format: 'ai-factory-settings-sync',
    version: 1,
    exportedAt: '2026-10-30T00:00:00.000Z',
    sections,
  };
}

test('settingsync export/preview/apply/conflict/removed/audit/remote end to end', async () => {
  const srv = await startServer();
  try {
    // 1. Export reflects the seeded files.
    const exp = await api(srv.port, 'GET', '/api/settingsync/export');
    assert.equal(exp.status, 200, JSON.stringify(exp.body));
    assert.equal(exp.body.doc.format, 'ai-factory-settings-sync');
    assert.deepEqual(exp.body.doc.sections.keybindings.items, [
      { command: 'palette.toggle', key: 'ctrl+k' },
    ]);
    assert.equal(exp.body.doc.sections['rules-global'].rules.length, 1);

    // 2. First import (no baseline): differing keys are modified, apply works.
    const first = docWith({
      keybindings: { items: [{ command: 'palette.toggle', key: 'ctrl+shift+k' }] },
      'rules-global': exp.body.doc.sections['rules-global'],
    });
    const prev1 = await api(srv.port, 'POST', '/api/settingsync/preview', { doc: first });
    assert.equal(prev1.status, 200, JSON.stringify(prev1.body));
    assert.equal(prev1.body.baseline, false);
    assert.deepEqual(
      prev1.body.entries.map((e: any) => `${e.section}:${e.key}:${e.kind}`),
      ['keybindings:items:modified'],
    );
    const app1 = await api(srv.port, 'POST', '/api/settingsync/apply', { doc: first });
    assert.equal(app1.status, 200, JSON.stringify(app1.body));
    assert.deepEqual(app1.body.applied, ['keybindings:items']);
    const kbAfter1 = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'keybindings.json'), 'utf8'));
    assert.deepEqual(kbAfter1, [{ command: 'palette.toggle', key: 'ctrl+shift+k' }]);

    // 3. Conflict: change locally, then import a different value for the same key.
    const put = await api(srv.port, 'PUT', '/api/keybindings', {
      keybindings: [{ command: 'palette.toggle', key: 'ctrl+alt+k' }],
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const conflictDoc = docWith({
      keybindings: { items: [{ command: 'palette.toggle', key: 'ctrl+m' }] },
    });
    const prev2 = await api(srv.port, 'POST', '/api/settingsync/preview', { doc: conflictDoc });
    assert.equal(prev2.status, 200, JSON.stringify(prev2.body));
    assert.equal(prev2.body.baseline, true);
    assert.deepEqual(
      prev2.body.entries.map((e: any) => `${e.section}:${e.key}:${e.kind}`),
      ['keybindings:items:conflict'],
    );
    const appConflict = await api(srv.port, 'POST', '/api/settingsync/apply', { doc: conflictDoc });
    assert.equal(appConflict.status, 409, JSON.stringify(appConflict.body));
    // Nothing written on the refused apply.
    const kbUnchanged = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'keybindings.json'), 'utf8'));
    assert.deepEqual(kbUnchanged, [{ command: 'palette.toggle', key: 'ctrl+alt+k' }]);
    const appResolved = await api(srv.port, 'POST', '/api/settingsync/apply', {
      doc: conflictDoc,
      resolutions: { 'keybindings:items': 'incoming' },
    });
    assert.equal(appResolved.status, 200, JSON.stringify(appResolved.body));
    assert.deepEqual(appResolved.body.applied, ['keybindings:items']);

    // 4. Removed: an incoming section that drops a key the baseline
    // has (keybindings without "items") is a removed entry: it needs
    // a resolution, keep leaves the file alone, incoming deletes it.
    const removedDoc = docWith({ keybindings: {} });
    const prev3 = await api(srv.port, 'POST', '/api/settingsync/preview', { doc: removedDoc });
    assert.equal(prev3.status, 200, JSON.stringify(prev3.body));
    assert.deepEqual(
      prev3.body.entries.map((e: any) => `${e.section}:${e.key}:${e.kind}`),
      ['keybindings:items:removed'],
    );
    const appKeep = await api(srv.port, 'POST', '/api/settingsync/apply', {
      doc: removedDoc,
      resolutions: { 'keybindings:items': 'keep' },
    });
    assert.equal(appKeep.status, 200, JSON.stringify(appKeep.body));
    assert.deepEqual(appKeep.body.kept, ['keybindings:items']);
    const kbKept = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'keybindings.json'), 'utf8'));
    assert.deepEqual(kbKept, [{ command: 'palette.toggle', key: 'ctrl+m' }]);
    const appDelete = await api(srv.port, 'POST', '/api/settingsync/apply', {
      doc: removedDoc,
      resolutions: { 'keybindings:items': 'incoming' },
    });
    assert.equal(appDelete.status, 200, JSON.stringify(appDelete.body));
    assert.deepEqual(appDelete.body.applied, ['keybindings:items']);
    const kbDeleted = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'keybindings.json'), 'utf8'));
    assert.deepEqual(kbDeleted, []);

    // 5. Invalid docs are refused and write nothing.
    const unknown = await api(srv.port, 'POST', '/api/settingsync/apply', {
      doc: docWith({ secrets: { x: 1 } }),
    });
    assert.equal(unknown.status, 400);
    const secretDoc = docWith({
      keybindings: { items: [{ command: 'x', key: 'ghp_' + 'a'.repeat(36) }] },
    });
    const secret = await api(srv.port, 'POST', '/api/settingsync/apply', { doc: secretDoc });
    assert.equal(secret.status, 400);
    const kbStill = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'keybindings.json'), 'utf8'));
    assert.deepEqual(kbStill, []);

    // 6. Audit carries keys only, never values.
    const audit = await api(srv.port, 'GET', '/api/audit?limit=200');
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body));
    const appliedRecs = (audit.body as any[]).filter((r) => r.action === 'SETTINGSYNC_APPLIED');
    assert.ok(appliedRecs.length >= 2, `expected SETTINGSYNC_APPLIED records, got ${appliedRecs.length}`);
    for (const rec of appliedRecs) {
      const details = JSON.stringify(rec.details ?? {});
      assert.equal(details.includes('ctrl+m'), false, details);
      assert.equal(details.includes('ctrl+shift+k'), false, details);
      assert.equal(details.includes('ctrl+alt+k'), false, details);
    }
    assert.ok(appliedRecs.some((r) => JSON.stringify(r.details).includes('keybindings:items')));

    // 7. Remote: configure, push (Bearer auth checked by the fake), pull previews.
    let stored: string | null = null;
    let seenAuth: string | undefined;
    const remote = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401);
        res.end('nope');
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          stored = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200);
          res.end('ok');
        });
      } else if (req.method === 'GET') {
        if (stored === null) {
          res.writeHead(404);
          res.end('none');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(stored);
        }
      } else {
        res.writeHead(405);
        res.end();
      }
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const remoteUrl = `http://127.0.0.1:${(remote.address() as { port: number }).port}/doc`;
    try {
      const remoteGet0 = await api(srv.port, 'GET', '/api/settingsync/remote');
      assert.equal(remoteGet0.status, 200);
      assert.equal(remoteGet0.body.url, null);
      assert.equal(remoteGet0.body.tokenConfigured, true);
      const pushNone = await api(srv.port, 'POST', '/api/settingsync/remote/push');
      assert.equal(pushNone.status, 409);
      const putRemote = await api(srv.port, 'PUT', '/api/settingsync/remote', { url: remoteUrl });
      assert.equal(putRemote.status, 200, JSON.stringify(putRemote.body));
      assert.equal(putRemote.body.url, remoteUrl);
      const push = await api(srv.port, 'POST', '/api/settingsync/remote/push');
      assert.equal(push.status, 200, JSON.stringify(push.body));
      assert.equal(seenAuth, `Bearer ${TOKEN}`);
      assert.ok(stored !== null && stored.includes('ai-factory-settings-sync'));
      const pull = await api(srv.port, 'POST', '/api/settingsync/remote/pull');
      assert.equal(pull.status, 200, JSON.stringify(pull.body));
      assert.equal(pull.body.doc.format, 'ai-factory-settings-sync');
      assert.deepEqual(pull.body.entries, []);
    } finally {
      remote.close();
    }
  } finally {
    await stopServer(srv);
  }
});
