import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreeWatcher } from '../src/fswatcher';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('real fs: file change under a watched tree reaches the callback', async () => {
  const root = join(tmpdir(), `watch-tree-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'v1', 'utf8');
  const events: string[] = [];
  const watcher = new TreeWatcher({
    root,
    onEvent: (rel) => events.push(rel),
  });
  watcher.start();
  assert.equal(watcher.watchedDirCount(), 2);
  writeFileSync(join(root, 'src', 'a.ts'), 'v2', 'utf8');
  // fs.watch delivery is async; poll briefly.
  for (let i = 0; i < 20 && !events.includes('src/a.ts'); i++) await sleep(50);
  watcher.close();
  assert.equal(events.includes('src/a.ts'), true);
  assert.equal(watcher.watchedDirCount(), 0);
});

test('new subdirectory gains a watcher; close is idempotent', async () => {
  const root = join(tmpdir(), `watch-tree2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const watcher = new TreeWatcher({ root, onEvent: () => {} });
  watcher.start();
  assert.equal(watcher.watchedDirCount(), 1);
  mkdirSync(join(root, 'sub'), { recursive: true });
  for (let i = 0; i < 20 && watcher.watchedDirCount() < 2; i++) await sleep(50);
  assert.equal(watcher.watchedDirCount(), 2);
  watcher.close();
  watcher.close();
  assert.equal(watcher.watchedDirCount(), 0);
});
