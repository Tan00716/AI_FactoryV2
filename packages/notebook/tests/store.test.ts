/**
 * Notebook package tests (round-7 task R7-#2).
 * node:test + node:assert/strict, run against compiled output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addCell,
  applyRunResult,
  capStream,
  clearOutputs,
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebooks,
  moveCell,
  notebookAddCell,
  notebookClearOutputs,
  notebookDeleteCell,
  notebookMoveCell,
  notebookUpdateCell,
  stripOutputs,
  updateCellSource,
  updateNotebook,
  MAX_CELLS,
  MAX_OUTPUT_CHARS,
  NotebookError,
} from '../src/index.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ai-factory-notebook-test-'));
}

function makeNotebook(root: string, name = 'demo'): string {
  const meta = createNotebook(root, { id: '11111111-1111-1111-1111-111111111111', name, language: 'typescript' });
  return meta.id;
}

test('create/list/get round-trip; duplicate id rejected', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = makeNotebook(root);
  assert.equal(listNotebooks(root).length, 1);
  assert.equal(getNotebook(root, id).cells.length, 0);
  assert.throws(
    () => createNotebook(root, { id, name: 'again', language: 'typescript' }),
    (e: unknown) => e instanceof NotebookError && e.code === 'exists',
  );
});

test('bad name / bad language / bad id fail closed', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => createNotebook(root, { id: 'bad id!', name: 'x', language: 'typescript' }), /invalid notebook id/);
  assert.throws(
    () => createNotebook(root, { id: '22222222-2222-2222-2222-222222222222', name: '', language: 'typescript' }),
    /invalid notebook name/,
  );
  assert.throws(
    () => createNotebook(root, { id: '22222222-2222-2222-2222-222222222222', name: 'x', language: 'python' }),
    /unknown notebook language/,
  );
  assert.throws(
    () => createNotebook(root, { id: '22222222-2222-2222-2222-222222222222', name: 'x', language: 'markdown' }),
    /unknown notebook language/,
  );
});

test('cell add/update/move/delete ordering', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = makeNotebook(root);
  const a = notebookAddCell(root, id, { kind: 'code', language: 'typescript', source: 'console.log(1)' });
  const b = notebookAddCell(root, id, { kind: 'markdown', language: 'markdown', source: '# hi' });
  const c = notebookAddCell(root, id, { kind: 'code', language: 'javascript', source: 'console.log(3)', afterId: a.cellId });
  let nb = getNotebook(root, id);
  assert.deepEqual(nb.cells.map((x) => x.id), [a.cellId, c.cellId, b.cellId]);
  assert.equal(nb.cells[1]!.kind, 'code');
  nb = notebookUpdateCell(root, id, c.cellId, 'console.log(30)');
  assert.equal(nb.cells[1]!.source, 'console.log(30)');
  nb = notebookMoveCell(root, id, b.cellId, { direction: 'up' });
  assert.deepEqual(nb.cells.map((x) => x.id), [a.cellId, b.cellId, c.cellId]);
  assert.throws(() => notebookMoveCell(root, id, a.cellId, { direction: 'up' }), /cannot move cell/);
  assert.throws(() => notebookMoveCell(root, id, a.cellId, { toIndex: 99 }), /out of range/);
  nb = notebookDeleteCell(root, id, b.cellId);
  assert.deepEqual(nb.cells.map((x) => x.id), [a.cellId, c.cellId]);
  assert.throws(() => notebookDeleteCell(root, id, 'cell-999'), /cell not found/);
});

test('code cells require a runnable language; markdown cells require markdown', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = makeNotebook(root);
  assert.throws(
    () => notebookAddCell(root, id, { kind: 'code', language: 'markdown', source: 'x' }),
    /runnable language/,
  );
  assert.throws(
    () => notebookAddCell(root, id, { kind: 'markdown', language: 'typescript', source: 'x' }),
    /must use language "markdown"/,
  );
});

test('pure cell ops: add after unknown id, update unknown cell, capStream, applyRunResult', () => {
  const nb = {
    version: 1 as const,
    id: '11111111-1111-1111-1111-111111111111',
    name: 'pure',
    language: 'typescript',
    cellCount: 0,
    cells: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.throws(() => addCell(nb, { kind: 'code', language: 'typescript', afterId: 'cell-9' }), /cell not found/);
  assert.throws(() => updateCellSource(nb, 'cell-9', 'x'), /cell not found/);
  const capped = capStream('x'.repeat(MAX_OUTPUT_CHARS + 10));
  assert.equal(capped.text.length, MAX_OUTPUT_CHARS);
  assert.equal(capped.truncated, true);
  assert.equal(capStream('short').truncated, false);
  const { cell } = addCell(nb, { kind: 'code', language: 'typescript', source: 'console.log(1)' });
  const withCell = { ...nb, cells: [cell] };
  const ran = applyRunResult(withCell, cell.id, {
    ok: true,
    exitCode: 0,
    stdout: 'hello\n',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 12,
    runner: 'node',
    language: 'typescript',
  });
  assert.equal(ran.cells[0]!.outputs[0]!.kind, 'stdout');
  assert.equal(ran.cells[0]!.run!.ok, true);
  const cleared = clearOutputs(ran);
  assert.deepEqual(cleared.cells[0]!.outputs, []);
  assert.equal(cleared.cells[0]!.run, null);
  assert.deepEqual(stripOutputs(ran).cells[0]!.outputs, []);
});

test('cell limit constant is sane and updateNotebook renames', (t) => {
  assert.equal(MAX_CELLS, 200);
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = makeNotebook(root, 'old');
  const meta = updateNotebook(root, id, { name: 'new name' });
  assert.equal(meta.name, 'new name');
  assert.equal(meta.cellCount, 0);
  deleteNotebook(root, id);
  assert.equal(listNotebooks(root).length, 0);
  assert.throws(() => getNotebook(root, id), /not found/);
});

test('clearOutputs persists', (t) => {
  const root = tmpRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = makeNotebook(root);
  const { cellId } = notebookAddCell(root, id, { kind: 'code', language: 'typescript', source: 'console.log(1)' });
  void cellId;
  const cleared = notebookClearOutputs(root, id);
  assert.deepEqual(cleared.cells.map((c) => c.outputs), [[]]);
});
