/**
 * SessionStore + SessionCheckpointStore unit tests (W-D).
 *
 * Pure store semantics, no server: create/list/get/archive/attach,
 * checkpoint capture (incl. git diff best-effort), restore snapshot
 * merge, corrupt-file fail-closed, atomic-write validity.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/session-store.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SessionStore,
  SessionCheckpointStore,
  SessionStoreError,
  captureCodeDiff,
} from '../src/session-store.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'aif-sessions-'));
}

test('create/list/get/archive round-trip', () => {
  const dir = tmp();
  const store = new SessionStore(join(dir, 'sessions.json'));
  assert.deepEqual(store.list(), []);
  const s = store.create({ title: '  my chat  ' });
  assert.equal(s.title, 'my chat');
  assert.equal(s.status, 'active');
  assert.ok(s.id);
  assert.deepEqual(store.list().map((x) => x.id), [s.id]);
  assert.equal(store.get(s.id)?.title, 'my chat');
  assert.equal(store.get('nope'), undefined);
  const archived = store.archive(s.id);
  assert.equal(archived.status, 'archived');
  assert.equal(store.get(s.id)?.status, 'archived');
});

test('create validates title', () => {
  const store = new SessionStore(join(tmp(), 'sessions.json'));
  assert.throws(() => store.create({ title: '   ' }), SessionStoreError);
  assert.throws(() => store.create({ title: 'x'.repeat(201) }), SessionStoreError);
  assert.throws(() => store.archive('missing'), /not found/);
});

test('attach dedupes run/task ids', () => {
  const store = new SessionStore(join(tmp(), 'sessions.json'));
  const s = store.create({ title: 't' });
  store.attach(s.id, 'run', 'r1');
  store.attach(s.id, 'run', 'r1');
  store.attach(s.id, 'task', 't1');
  const got = store.get(s.id)!;
  assert.deepEqual(got.runIds, ['r1']);
  assert.deepEqual(got.taskIds, ['t1']);
  assert.throws(() => store.attach('missing', 'run', 'r1'), /not found/);
});

test('restoreFromSnapshot replaces fields but merges checkpointIds', () => {
  const dir = tmp();
  const store = new SessionStore(join(dir, 'sessions.json'));
  const s = store.create({ title: 'original' });
  store.linkCheckpoint(s.id, 'cp-old');
  const snapshot = { ...store.get(s.id)!, title: 'snapshot-title', checkpointIds: ['cp-old'] };
  // Live session moves on: new checkpoint + archived.
  store.linkCheckpoint(s.id, 'cp-new');
  store.archive(s.id);
  const restored = store.restoreFromSnapshot(snapshot);
  assert.equal(restored.title, 'snapshot-title');
  assert.equal(restored.status, 'active');
  // cp-new (created after the snapshot) survives the restore.
  assert.deepEqual(restored.checkpointIds.sort(), ['cp-new', 'cp-old']);
});

test('corrupt file: fail-closed — serve empty, refuse writes', () => {
  const dir = tmp();
  const p = join(dir, 'sessions.json');
  writeFileSync(p, '{not json', 'utf8');
  const store = new SessionStore(p);
  assert.equal(store.isCorrupt(), true);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.create({ title: 'x' }), /corrupt/);
});

test('persisted file is valid JSON (atomic write)', () => {
  const dir = tmp();
  const p = join(dir, 'sessions.json');
  const store = new SessionStore(p);
  store.create({ title: 't' });
  const raw = JSON.parse(readFileSync(p, 'utf8')) as { sessions: unknown[] };
  assert.equal(raw.sessions.length, 1);
});

test('captureCodeDiff: no root → no-code-root note', () => {
  const r = captureCodeDiff(null);
  assert.equal(r.gitDiff, null);
  assert.equal(r.gitDiffNote, 'no-code-root');
});

test('captureCodeDiff: non-git dir → not-a-git-repo', () => {
  const r = captureCodeDiff(tmp());
  assert.equal(r.gitDiff, null);
  assert.equal(r.gitDiffNote, 'not-a-git-repo');
});

test('captureCodeDiff: git repo with uncommitted change → diff captured', () => {
  const dir = tmp();
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  writeFileSync(join(dir, 'f.txt'), 'one\n', 'utf8');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  writeFileSync(join(dir, 'f.txt'), 'two\n', 'utf8');
  const r = captureCodeDiff(dir);
  assert.ok(r.gitHead && r.gitHead.length === 40);
  assert.ok(r.gitDiff && r.gitDiff.includes('two'));
  assert.equal(r.gitDiffTruncated, false);
  assert.equal(r.gitDiffNote, '');
});

test('checkpoint create/list/get round-trip', () => {
  const dir = tmp();
  const store = new SessionStore(join(dir, 'sessions.json'));
  const cps = new SessionCheckpointStore(join(dir, 'cps.json'));
  const s = store.create({ title: 't' });
  const cp = cps.create({
    session: s,
    runResumePoints: [{ runId: 'r1', stepPosition: 4, capturedAt: 123 }],
    label: 'before',
  });
  assert.equal(cp.sessionId, s.id);
  assert.equal(cp.label, 'before');
  assert.equal(cp.sessionSnapshot.title, 't');
  assert.deepEqual(cp.runResumePoints, [{ runId: 'r1', stepPosition: 4, capturedAt: 123 }]);
  assert.equal(cp.gitDiffNote, 'no-code-root');
  assert.deepEqual(cps.list(s.id).map((c) => c.id), [cp.id]);
  assert.deepEqual(cps.list('other'), []);
  assert.equal(cps.get(cp.id)?.label, 'before');
});

test('checkpoint store: corrupt file fail-closed', () => {
  const dir = tmp();
  const sStore = new SessionStore(join(dir, 'sessions.json'));
  const p = join(dir, 'cps.json');
  writeFileSync(p, 'xx', 'utf8');
  const cps = new SessionCheckpointStore(p);
  assert.equal(cps.isCorrupt(), true);
  assert.deepEqual(cps.list('s'), []);
  const s = sStore.create({ title: 't' });
  assert.throws(() => cps.create({ session: s, runResumePoints: [] }), /corrupt/);
});

test('checkpoint label defaults and is bounded', () => {
  const dir = tmp();
  const sStore = new SessionStore(join(dir, 'sessions.json'));
  const cps = new SessionCheckpointStore(join(dir, 'cps.json'));
  const s = sStore.create({ title: 't' });
  const cp = cps.create({ session: s, runResumePoints: [], label: 'x'.repeat(500) });
  assert.ok(cp.label.length <= 120);
  const cp2 = cps.create({ session: s, runResumePoints: [] });
  assert.match(cp2.label, /^checkpoint /);
});
