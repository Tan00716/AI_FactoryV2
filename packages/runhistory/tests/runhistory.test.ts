/**
 * RunHistory package tests (V3.0 audit round 2, item #10) — run on the
 * compiled dist: node --test packages/runhistory/dist/tests/*.test.js
 *
 * Covers: record/list round-trip, secret redaction of free-text fields,
 * corrupt-file fail-closed (record throws, file untouched), retention
 * pruning, entry cap, and explicit clear (including the corrupt repair
 * path). No step commands, outputs, or error text are ever persisted:
 * the stored shape has no such field by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { RunHistory } from '../src/index.ts';
import type { RunHistoryMetaInput } from '../src/index.ts';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'aif-runhistory-'));
}

function meta(over: Partial<RunHistoryMetaInput> = {}): RunHistoryMetaInput {
  return {
    id: 'taskrun-1',
    label: 'demo-chain',
    ok: true,
    startedAt: '2026-11-02T00:00:00.000Z',
    finishedAt: '2026-11-02T00:00:05.000Z',
    durationMs: 5000,
    taskCount: 2,
    counts: { ok: 2, failed: 0, denied: 0, timeout: 0, skipped: 0, superseded: 0 },
    coverage: 'full',
    ...over,
  };
}

test('record persists metadata and list returns it', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const h = new RunHistory({ filePath: join(d, 'run-history.json') });
  h.record(meta());
  const again = new RunHistory({ filePath: join(d, 'run-history.json') });
  again.load();
  const list = again.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, 'taskrun-1');
  assert.equal(list[0]?.label, 'demo-chain');
  assert.equal(list[0]?.taskCount, 2);
  assert.equal(list[0]?.counts.ok, 2);
  // No step data fields exist on the persisted shape.
  assert.equal('steps' in (list[0] as object), false);
  assert.equal('output' in (list[0] as object), false);
  assert.equal('command' in (list[0] as object), false);
});

test('secret-shaped label and rerunFrom are redacted before disk', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const h = new RunHistory({ filePath: join(d, 'run-history.json') });
  h.record(meta({ label: `deploy ${token}`, rerunFrom: `step api_key=${token}` }));
  const raw = readFileSync(join(d, 'run-history.json'), 'utf8');
  assert.equal(raw.includes(token), false);
  assert.match(raw, /REDACTED/);
});

test('corrupt file is fail-closed: load throws, record throws, file untouched', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const fp = join(d, 'run-history.json');
  writeFileSync(fp, '{not json', 'utf8');
  const h = new RunHistory({ filePath: fp });
  assert.throws(() => h.load(), /not valid JSON/);
  assert.equal(h.corrupt, true);
  assert.throws(() => h.record(meta()), /corrupt/);
  assert.equal(readFileSync(fp, 'utf8'), '{not json');
  // Explicit clear is the repair path: removes the corrupt file.
  assert.equal(h.clear(), null);
  assert.equal(existsSync(fp), false);
  const fresh = new RunHistory({ filePath: fp });
  fresh.record(meta({ id: 'taskrun-9' }));
  assert.equal(fresh.list().length, 1);
});

test('wrong-shape file is fail-closed, not silently accepted', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const fp = join(d, 'run-history.json');
  writeFileSync(fp, JSON.stringify([{ id: 'x' }]), 'utf8');
  const h = new RunHistory({ filePath: fp });
  assert.throws(() => h.load(), /unexpected shape/);
});

test('retention prunes entries older than 90 days on record', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const now = Date.parse('2026-11-02T00:00:00.000Z');
  const h = new RunHistory({ filePath: join(d, 'run-history.json'), now: () => now });
  h.record(meta({ id: 'taskrun-old', finishedAt: '2026-06-01T00:00:00.000Z' }));
  assert.equal(h.list().length, 0);
  h.record(meta({ id: 'taskrun-new', finishedAt: '2026-11-01T00:00:00.000Z' }));
  assert.equal(h.list().length, 1);
});

test('entry cap keeps the newest', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const h = new RunHistory({ filePath: join(d, 'run-history.json'), maxEntries: 3 });
  for (let i = 1; i <= 5; i++) h.record(meta({ id: `taskrun-${i}` }));
  assert.deepEqual(h.list().map((e) => e.id), ['taskrun-3', 'taskrun-4', 'taskrun-5']);
});

test('externally corrupted file is detected on next load, not masked by cache', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const fp = join(d, 'run-history.json');
  const h = new RunHistory({ filePath: fp });
  h.record(meta());
  assert.equal(h.list().length, 1);
  writeFileSync(fp, '{corrupted-mid-process', 'utf8');
  assert.throws(() => h.load(), /not valid JSON/);
  assert.equal(h.corrupt, true);
  assert.equal(readFileSync(fp, 'utf8'), '{corrupted-mid-process');
});

test('clear removes the file and reports the count', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const fp = join(d, 'run-history.json');
  const h = new RunHistory({ filePath: fp });
  h.record(meta());
  h.record(meta({ id: 'taskrun-2' }));
  assert.equal(h.clear(), 2);
  assert.equal(existsSync(fp), false);
  assert.equal(h.list().length, 0);
});

test('missing file loads as empty history', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(d, { recursive: true });
  const h = new RunHistory({ filePath: join(d, 'run-history.json') });
  h.load();
  assert.equal(h.list().length, 0);
  assert.equal(h.corrupt, false);
});
