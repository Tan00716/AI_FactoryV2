import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '../src/index';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function fixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-tx-run-'));
  dirs.push(dir);
  const file = path.join(dir, 'sample.test.mjs');
  fs.writeFileSync(file, content);
  return dir;
}

const MIXED = [
  "import { test, describe } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "describe('math', () => {",
  "  test('adds', () => { assert.equal(1 + 1, 2); });",
  "  test('fails here', () => { assert.equal(1, 2); });",
  "  test.skip('skipped one', () => {});",
  "});",
  "test('top passes', () => {});",
  '',
].join('\n');

test('run: whole file reports per-case status, duration and failure text', async () => {
  const dir = fixture(MIXED);
  const out = await runTests({
    root: dir,
    files: [path.join(dir, 'sample.test.mjs')],
    timeoutMs: 60_000,
  });
  assert.equal(out.runError, undefined);
  assert.equal(out.timedOut, false);
  const byName = new Map(out.results.map((r) => [r.fullName, r]));
  assert.equal(byName.get('math > adds')?.status, 'pass');
  assert.equal(byName.get('math > fails here')?.status, 'fail');
  assert.match(byName.get('math > fails here')?.error ?? '', /1 !== 2/);
  assert.equal(byName.get('math > skipped one')?.status, 'skip');
  assert.equal(byName.get('top passes')?.status, 'pass');
  assert.equal(out.summary.total, 4);
  assert.equal(out.summary.pass, 2);
  assert.equal(out.summary.fail, 1);
  assert.equal(out.summary.skip, 1);
  for (const r of out.results) assert.equal(typeof r.durationMs, 'number');
});

test('run: single case via leaf-name pattern runs only that case', async () => {
  const dir = fixture(MIXED);
  const out = await runTests({
    root: dir,
    files: [path.join(dir, 'sample.test.mjs')],
    patterns: ['^adds$'],
    timeoutMs: 60_000,
  });
  assert.equal(out.runError, undefined);
  assert.deepEqual(out.results.map((r) => r.fullName), ['math > adds']);
});

test('run: missing file surfaces a run error, not invented cases', async () => {
  const dir = fixture(MIXED);
  const out = await runTests({
    root: dir,
    files: [path.join(dir, 'nope.test.mjs')],
    timeoutMs: 60_000,
  });
  assert.equal(out.results.length, 0);
  assert.match(out.runError ?? '', /nope\.test\.mjs/);
});

test('run: timeout kills the child and reports timedOut', async () => {
  const dir = fixture("import { test } from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 30_000)); });\n");
  const out = await runTests({
    root: dir,
    files: [path.join(dir, 'sample.test.mjs')],
    timeoutMs: 800,
  });
  assert.equal(out.timedOut, true);
  assert.match(out.runError ?? '', /timed out/);
});
