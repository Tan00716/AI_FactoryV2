import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/index';

const resolvePath = (p: string) => `/root/${p}`;

test('python and go types normalize to placeholder adapters', () => {
  const py = normalizeConfig(
    { name: 'py', type: 'python', request: 'launch', program: 'main.py' },
    resolvePath,
  );
  assert.equal(py.adapter, 'python');
  assert.equal(py.program, '/root/main.py');
  const dbg = normalizeConfig(
    { name: 'dbg', type: 'debugpy', request: 'launch', program: 'main.py' },
    resolvePath,
  );
  assert.equal(dbg.adapter, 'python');
  const go = normalizeConfig(
    { name: 'go', type: 'go', request: 'launch', program: 'main.go' },
    resolvePath,
  );
  assert.equal(go.adapter, 'go');
  const dlv = normalizeConfig(
    { name: 'dlv', type: 'delve', request: 'launch', program: 'main.go' },
    resolvePath,
  );
  assert.equal(dlv.adapter, 'go');
});

test('node still normalizes and unknown types still reject', () => {
  const node = normalizeConfig(
    { name: 'n', type: 'pwa-node', request: 'launch', program: 'app.js' },
    resolvePath,
  );
  assert.equal(node.adapter, 'node');
  assert.throws(
    () => normalizeConfig({ name: 'c', type: 'chrome', request: 'launch', program: 'x' }, resolvePath),
    /not supported/,
  );
});
