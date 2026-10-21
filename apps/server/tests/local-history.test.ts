/**
 * Local History core tests — imports ../src/local-history.ts straight
 * from src under node's type-stripping ESM loader. The module is node
 * builtins only, so it resolves (dual-mode import rule in AGENTS.md).
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/local-history.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  clearFileHistory,
  historyDirForFile,
  listSnapshots,
  localHistoryRoot,
  readSnapshot,
  snapshotOnSave,
  workspaceDirName,
} from '../src/local-history.ts';

const ENV_KEYS = [
  'AI_FACTORY_DATA_DIR',
  'FACTORY_LOCAL_HISTORY_DISABLED',
  'FACTORY_LOCAL_HISTORY_MAX_SNAPSHOTS_PER_FILE',
  'FACTORY_LOCAL_HISTORY_MAX_SNAPSHOT_BYTES',
  'FACTORY_LOCAL_HISTORY_MAX_WORKSPACE_BYTES',
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

const tmpRoots: string[] = [];

function freshEnv(): { dataDir: string; workspaceRoot: string } {
  const dataDir = mkdtempSync(join(homedir(), 'lh-test-data-'));
  const workspaceRoot = mkdtempSync(join(homedir(), 'lh-test-ws-'));
  tmpRoots.push(dataDir, workspaceRoot);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AI_FACTORY_DATA_DIR = dataDir;
  return { dataDir, workspaceRoot };
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('snapshotOnSave writes a snapshot; list + read round-trip', () => {
  const { workspaceRoot } = freshEnv();
  const r = snapshotOnSave(workspaceRoot, 'notes/a.txt', 'hello v1', 'save');
  assert.equal(r.status, 'ok');
  assert.ok(r.id);
  assert.equal(r.reason, null);
  const metas = listSnapshots(workspaceRoot, 'notes/a.txt');
  assert.equal(metas.length, 1);
  assert.equal(metas[0].id, r.id);
  assert.equal(metas[0].kind, 'save');
  assert.equal(metas[0].size, Buffer.byteLength('hello v1'));
  assert.match(metas[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(readSnapshot(workspaceRoot, 'notes/a.txt', r.id as string), 'hello v1');
});

test('identical consecutive saves are skipped (skipped-unchanged)', () => {
  const { workspaceRoot } = freshEnv();
  const r1 = snapshotOnSave(workspaceRoot, 'a.txt', 'same', 'save');
  assert.equal(r1.status, 'ok');
  const r2 = snapshotOnSave(workspaceRoot, 'a.txt', 'same', 'save');
  assert.equal(r2.status, 'skipped-unchanged');
  assert.equal(r2.id, null);
  assert.ok(r2.reason);
  assert.equal(listSnapshots(workspaceRoot, 'a.txt').length, 1);
});

test('per-file retention prunes oldest snapshots first', () => {
  const { workspaceRoot } = freshEnv();
  process.env.FACTORY_LOCAL_HISTORY_MAX_SNAPSHOTS_PER_FILE = '3';
  const ids: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = snapshotOnSave(workspaceRoot, 'f.txt', `v${i}`, 'save');
    assert.equal(r.status, 'ok');
    ids.push(r.id as string);
  }
  const metas = listSnapshots(workspaceRoot, 'f.txt');
  assert.equal(metas.length, 3);
  // newest-first listing keeps the three latest writes
  assert.deepEqual(
    metas.map((m) => m.id).sort(),
    ids.slice(2).sort(),
  );
  assert.equal(readSnapshot(workspaceRoot, 'f.txt', metas[metas.length - 1].id), 'v3');
});

test('oversize content is skipped explicitly (skipped-too-large)', () => {
  const { workspaceRoot } = freshEnv();
  process.env.FACTORY_LOCAL_HISTORY_MAX_SNAPSHOT_BYTES = '10';
  const r = snapshotOnSave(workspaceRoot, 'big.txt', 'x'.repeat(100), 'save');
  assert.equal(r.status, 'skipped-too-large');
  assert.match(r.reason as string, /100 bytes/);
  assert.equal(listSnapshots(workspaceRoot, 'big.txt').length, 0);
});

test('disabled flag skips with an explicit reason', () => {
  const { workspaceRoot } = freshEnv();
  process.env.FACTORY_LOCAL_HISTORY_DISABLED = '1';
  const r = snapshotOnSave(workspaceRoot, 'a.txt', 'x', 'save');
  assert.equal(r.status, 'skipped-disabled');
  assert.ok(r.reason);
});

test('workspace byte cap prunes across files', () => {
  const { workspaceRoot } = freshEnv();
  process.env.FACTORY_LOCAL_HISTORY_MAX_WORKSPACE_BYTES = '100';
  const r1 = snapshotOnSave(workspaceRoot, 'a.txt', 'x'.repeat(60), 'save');
  assert.equal(r1.status, 'ok');
  const r2 = snapshotOnSave(workspaceRoot, 'a.txt', 'y'.repeat(60), 'save');
  assert.equal(r2.status, 'ok');
  assert.ok(r2.pruned >= 1);
  const metas = listSnapshots(workspaceRoot, 'a.txt');
  assert.ok(metas.length <= 1);
  let total = 0;
  for (const m of metas) total += m.size;
  assert.ok(total <= 100);
});

test('crafted relPath cannot escape the local-history root', () => {
  const { dataDir, workspaceRoot } = freshEnv();
  const dir = historyDirForFile(workspaceRoot, 'sub/../../evil.txt');
  assert.ok(resolve(dir).startsWith(resolve(dataDir)));
  assert.ok(!resolve(dir).includes('..'));
  const r = snapshotOnSave(workspaceRoot, '..\\..\\evil.txt', 'pwn', 'save');
  assert.equal(r.status, 'ok');
  assert.ok(resolve(historyDirForFile(workspaceRoot, '..\\..\\evil.txt')).startsWith(resolve(dataDir)));
});

test('pre-restore kind is recorded; unknown/malformed ids read null', () => {
  const { workspaceRoot } = freshEnv();
  const r = snapshotOnSave(workspaceRoot, 'a.txt', 'v1', 'pre-restore');
  assert.equal(r.status, 'ok');
  const metas = listSnapshots(workspaceRoot, 'a.txt');
  assert.equal(metas[0].kind, 'pre-restore');
  assert.equal(readSnapshot(workspaceRoot, 'a.txt', 'nope.snap'), null);
  assert.equal(readSnapshot(workspaceRoot, 'a.txt', '../../etc/passwd'), null);
  assert.equal(readSnapshot(workspaceRoot, 'missing.txt', r.id as string), null);
});

test('empty relPath is an explicit skipped-error, not a throw', () => {
  const { workspaceRoot } = freshEnv();
  const r = snapshotOnSave(workspaceRoot, '', 'x', 'save');
  assert.equal(r.status, 'skipped-error');
  assert.ok(r.reason);
});

test('workspaceDirName is stable and filesystem-safe', () => {
  const a = workspaceDirName('/tmp/My Project (1)');
  const b = workspaceDirName('/tmp/My Project (1)');
  const c = workspaceDirName('/tmp/other');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[A-Za-z0-9._-]+$/);
});

test('localHistoryRoot honors AI_FACTORY_DATA_DIR', () => {
  const { dataDir } = freshEnv();
  assert.equal(localHistoryRoot(), resolve(dataDir, 'local-history'));
});

test('clearFileHistory removes a file history', () => {
  const { workspaceRoot } = freshEnv();
  snapshotOnSave(workspaceRoot, 'a.txt', 'x', 'save');
  assert.equal(listSnapshots(workspaceRoot, 'a.txt').length, 1);
  clearFileHistory(workspaceRoot, 'a.txt');
  assert.equal(listSnapshots(workspaceRoot, 'a.txt').length, 0);
});
