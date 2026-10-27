/**
 * @ai-factory/extensions tests: vm sandbox behaviour + escape attempts.
 * Run: node --test packages/extensions/dist/tests/*.test.js (after build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension, SandboxError } from '../src/index.js';

function manifest(over: Record<string, unknown> = {}) {
  return {
    name: 'sandbox-demo',
    version: '1.0.0',
    description: 'demo',
    permissions: [],
    contributes: {
      commands: [{ id: 'demo.echo', title: 'Echo' }],
      panels: [],
      checkers: [],
      providers: [{ id: 'demo.notes', prefix: '@notes', description: 'notes' }],
    },
    ...over,
  };
}

const GOOD_MAIN = `
api.registerCommand('demo.echo', function (args) {
  api.log('echoed ' + args.word);
  return { word: args.word, upper: String(args.word).toUpperCase() };
});
api.registerContextProvider('demo.notes', function (args) {
  return [{ label: 'note:' + args.query, text: 'note body for ' + args.query }];
});
`;

describe('loadExtension + invoke', () => {
  it('runs a command and returns JSON + logs', () => {
    const ext = loadExtension(manifest(), GOOD_MAIN);
    const { result, logs } = ext.runCommand('demo.echo', { word: 'hi' });
    assert.deepEqual(result, { word: 'hi', upper: 'HI' });
    assert.deepEqual(logs, ['echoed hi']);
  });
  it('resolves a provider and validates items', () => {
    const ext = loadExtension(manifest(), GOOD_MAIN);
    const { items } = ext.resolveProvider('demo.notes', 'hello');
    assert.deepEqual(items, [{ label: 'note:hello', text: 'note body for hello' }]);
  });
  it('rejects a declared command with no handler', () => {
    assert.throws(() => loadExtension(manifest(), `// no registrations`), /no handler/);
  });
  it('rejects a handler for an undeclared command', () => {
    assert.throws(
      () => loadExtension(manifest(), `api.registerCommand('demo.other', () => 1);` + GOOD_MAIN),
      /undeclared command/,
    );
  });
  it('rejects async handlers', () => {
    const ext = loadExtension(
      manifest(),
      `api.registerCommand('demo.echo', async () => 1);
       api.registerContextProvider('demo.notes', () => []);`,
    );
    assert.throws(() => ext.runCommand('demo.echo', {}), /async handlers/);
  });
  it('rejects an unknown command at invoke time', () => {
    const ext = loadExtension(manifest(), GOOD_MAIN);
    assert.throws(() => ext.runCommand('demo.nope', {}), /unknown command/);
  });
});

describe('sandbox escapes (all must fail)', () => {
  const cases: Array<[string, string]> = [
    ['require', `api.registerCommand('demo.echo', () => require('fs'));`],
    ['process', `api.registerCommand('demo.echo', () => process.version);`],
    ['Buffer', `api.registerCommand('demo.echo', () => Buffer.from('x'));`],
    ['eval', `api.registerCommand('demo.echo', () => eval('1+1'));`],
    ['Function constructor', `api.registerCommand('demo.echo', () => Function('return 1')());`],
    ['api constructor chain', `api.registerCommand('demo.echo', () => api.registerCommand.constructor('return process')());`],
    ['global constructor chain', `api.registerCommand('demo.echo', function () { return this.constructor.constructor('return process')(); });`],
  ];
  for (const [label, main] of cases) {
    it(`blocks ${label}`, () => {
      const ext = loadExtension(
        manifest(),
        main + `api.registerContextProvider('demo.notes', () => []);`,
      );
      assert.throws(() => ext.runCommand('demo.echo', {}), SandboxError);
    });
  }
  it('times out an infinite loop at load', () => {
    assert.throws(() => loadExtension(manifest(), `while (true) {}`), /timed out/);
  });
  it('times out an infinite loop at invoke', () => {
    const ext = loadExtension(
      manifest(),
      `api.registerCommand('demo.echo', () => { while (true) {} });
       api.registerContextProvider('demo.notes', () => []);`,
    );
    assert.throws(() => ext.runCommand('demo.echo', {}), /timed out/);
  });
  it('does not leak host objects through arguments', () => {
    // Args cross as JSON: a handler cannot reach the host via args.
    const ext = loadExtension(manifest(), GOOD_MAIN);
    const { result } = ext.runCommand('demo.echo', { word: 'x' });
    assert.equal((result as { upper: string }).upper, 'X');
  });
});
