/**
 * Headless CLI arg-parsing tests (W-D).
 * Run: node --test packages/headless/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, usage, DEFAULT_API } from '../src/index.js';

test('parseArgs: exec with flags', () => {
  const p = parseArgs(['exec', '--prompt', 'hello', '--json', '--timeout-ms', '5000']);
  assert.equal(p.command, 'exec');
  assert.equal(p.opts['prompt'], 'hello');
  assert.equal(p.opts['json'], true);
  assert.equal(p.opts['timeout-ms'], '5000');
  assert.equal(p.error, undefined);
});

test('parseArgs: --flag=value form and global flags after command', () => {
  const p = parseArgs(['checkpoint', 'create', '--session=abc', '--api=http://x:1']);
  assert.equal(p.command, 'checkpoint');
  assert.equal(p.sub, 'create');
  assert.equal(p.opts['session'], 'abc');
  assert.equal(p.opts['api'], 'http://x:1');
});

test('parseArgs: resume positional', () => {
  const p = parseArgs(['resume', 'sess-123']);
  assert.equal(p.command, 'resume');
  assert.deepEqual(p.positionals, ['sess-123']);
});

test('parseArgs: missing flag value is a usage error', () => {
  const p = parseArgs(['exec', '--prompt']);
  assert.match(p.error ?? '', /requires a value/);
});

test('parseArgs: sessions subcommand', () => {
  const p = parseArgs(['sessions', 'create', '--title', 't']);
  assert.equal(p.command, 'sessions');
  assert.equal(p.sub, 'create');
  assert.equal(p.opts['title'], 't');
});

test('usage mentions exit codes and stdin', () => {
  const u = usage();
  assert.match(u, /Exit codes/);
  assert.match(u, /stdin/);
  assert.match(u, /--json/);
});

test('DEFAULT_API is the local server default', () => {
  assert.equal(DEFAULT_API, 'http://127.0.0.1:3100');
});
