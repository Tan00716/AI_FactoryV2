import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SnapshotStore } from '../src/index';
import { tempDir, writeTree, cleanup } from './helpers';

function makeStore() {
  const root = tempDir('recovery-store-');
  return { store: new SnapshotStore(root), root };
}

describe('SnapshotStore', () => {
  it('take records sha256 hashes matching file contents', () => {
    const { store, root } = makeStore();
    const ws = tempDir('ws-');
    writeTree(ws, { 'a.txt': 'hello', 'sub/b.txt': 'world' });
    try {
      const snap = store.take(ws, { tag: 'before deploy' });
      assert.equal(snap.files.length, 2);
      assert.equal(snap.tag, 'before deploy');
      assert.equal(snap.sealed, true);
      const a = snap.files.find((f) => f.path === 'a.txt');
      assert.ok(a);
      assert.equal(a.hash.length, 64);
      assert.equal(a.size, 5);
    } finally {
      cleanup(root, ws);
    }
  });

  it('roundtrip: restore returns the workspace to the snapshotted state', () => {
    const { store, root } = makeStore();
    const ws = tempDir('ws-');
    writeTree(ws, { 'app.js': 'v1', 'cfg.json': '{"x":1}' });
    try {
      const snap = store.take(ws);
      writeFileSync(join(ws, 'app.js'), 'BROKEN {{{');
      writeFileSync(join(ws, 'new.txt'), 'extra');
      store.restore(snap.id);
      assert.equal(readFileSync(join(ws, 'app.js'), 'utf8'), 'v1');
      assert.equal(existsSync(join(ws, 'new.txt')), false);
    } finally {
      cleanup(root, ws);
    }
  });

  it('restore backs up the current state first (rollback of the rollback)', () => {
    const { store, root } = makeStore();
    const ws = tempDir('ws-');
    writeTree(ws, { 'app.js': 'v1' });
    try {
      const snap = store.take(ws, { tag: 'good' });
      writeFileSync(join(ws, 'app.js'), 'BROKEN');
      const backup = store.restore(snap.id);
      assert.equal(backup.tag, `pre-restore:${snap.id}`);
      assert.equal(backup.sealed, true);
      // The backup must contain the broken state, so we can re-apply it.
      store.restore(backup.id);
      assert.equal(readFileSync(join(ws, 'app.js'), 'utf8'), 'BROKEN');
    } finally {
      cleanup(root, ws);
    }
  });

  it('restore refuses an unsealed snapshot', () => {
    const { store, root } = makeStore();
    const ws = tempDir('ws-');
    writeTree(ws, { 'a.txt': 'x' });
    try {
      const snap = store.take(ws, { seal: false });
      assert.equal(snap.sealed, false);
      assert.throws(() => store.restore(snap.id), /integrity check/);
      store.seal(snap.id);
      assert.doesNotThrow(() => store.restore(snap.id));
    } finally {
      cleanup(root, ws);
    }
  });

  it('verify detects tampering with stored snapshot files', () => {
    const { store, root } = makeStore();
    const ws = tempDir('ws-');
    writeTree(ws, { 'a.txt': 'original' });
    try {
      const snap = store.take(ws);
      assert.deepEqual(store.verify(snap.id).ok, true);
      writeFileSync(join(root, snap.id, 'files', 'a.txt'), 'tampered');
      const v = store.verify(snap.id);
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => /tampered|mismatch/i.test(e)));
      assert.throws(() => store.restore(snap.id), /integrity check/);
    } finally {
      cleanup(root, ws);
    }
  });

  it('snapshots and restores the db file when dbPath is given', () => {
    const { store, root } = makeStore();
    const ws = tempDir('ws-');
    const db = tempDir('db-') + '/app.sqlite';
    writeTree(ws, { 'app.js': 'v1' });
    writeFileSync(db, 'DB-BYTES-v1');
    try {
      const snap = store.take(ws, { dbPath: db });
      assert.equal(snap.dbPath, db);
      assert.ok(snap.dbHash && snap.dbHash.length === 64);
      writeFileSync(db, 'DB-BYTES-corrupted');
      store.restore(snap.id);
      assert.equal(readFileSync(db, 'utf8'), 'DB-BYTES-v1');
    } finally {
      cleanup(root, ws, join(db, '..'));
    }
  });

  it('take throws for a missing workspace directory', () => {
    const { store, root } = makeStore();
    try {
      assert.throws(() => store.take(join(root, 'nope')), /not found/);
    } finally {
      cleanup(root);
    }
  });

  it('list returns snapshots oldest-first and get returns null for unknown id', () => {
    let t = 1_700_000_000_000;
    const root = tempDir('s-');
    const store = new SnapshotStore(root, { clock: { now: () => (t += 1000) } });
    const ws = tempDir('ws-');
    writeTree(ws, { 'a.txt': 'x' });
    try {
      const s1 = store.take(ws, { tag: 'one' });
      const s2 = store.take(ws, { tag: 'two' });
      const ids = store.list().map((s) => s.id);
      assert.deepEqual(ids, [s1.id, s2.id]);
      assert.equal(store.get('does-not-exist'), null);
    } finally {
      cleanup(root, ws);
    }
  });
});
