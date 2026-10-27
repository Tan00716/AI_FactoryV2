/**
 * @ai-factory/extensions tests: manifest validation (fail-closed).
 * Run: node --test packages/extensions/dist/tests/*.test.js (after build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateMainSource } from '../src/index.js';

function good(over: Record<string, unknown> = {}) {
  return {
    name: 'demo-ext',
    version: '1.0.0',
    description: 'demo',
    permissions: ['commands.execute'],
    contributes: {
      commands: [{ id: 'demo.run', title: 'Run demo' }],
      panels: [],
      checkers: [],
      providers: [],
    },
    ...over,
  };
}

describe('validateManifest', () => {
  it('accepts a full valid manifest', () => {
    const m = validateManifest(good());
    assert.equal(m.name, 'demo-ext');
    assert.equal(m.contributes.commands.length, 1);
  });
  it('accepts a minimal manifest (empty contributes)', () => {
    const m = validateManifest({ name: 'xy', version: '0.0.1', description: 'd' });
    assert.deepEqual(m.contributes, { commands: [], panels: [], checkers: [], providers: [] });
    assert.deepEqual(m.permissions, []);
  });
  it('rejects a name with path traversal', () => {
    assert.throws(() => validateManifest(good({ name: '../evil' })), /name is invalid/);
  });
  it('rejects a bad version', () => {
    assert.throws(() => validateManifest(good({ version: '1.0' })), /semver/);
  });
  it('rejects unknown permissions', () => {
    assert.throws(() => validateManifest(good({ permissions: ['network.access'] })), /unknown permission/);
  });
  it('rejects unknown top-level keys', () => {
    assert.throws(() => validateManifest(good({ scripts: {} })), /unknown key/);
  });
  it('rejects duplicate command ids', () => {
    assert.throws(
      () =>
        validateManifest(
          good({
            contributes: {
              commands: [
                { id: 'a.b', title: '1' },
                { id: 'a.b', title: '2' },
              ],
            },
          }),
        ),
      /duplicated/,
    );
  });
  it('rejects a checker pattern that does not compile', () => {
    assert.throws(
      () =>
        validateManifest(
          good({
            contributes: {
              checkers: [{ id: 'c', title: 't', pattern: '([', message: 'm' }],
            },
          }),
        ),
      /does not compile/,
    );
  });
  it('rejects checker flags other than i', () => {
    assert.throws(
      () =>
        validateManifest(
          good({
            contributes: {
              checkers: [{ id: 'c', title: 't', pattern: 'x', flags: 'g', message: 'm' }],
            },
          }),
        ),
      /flags/,
    );
  });
  it('rejects a bad provider prefix', () => {
    assert.throws(
      () =>
        validateManifest(
          good({
            contributes: { providers: [{ id: 'p', prefix: 'notes' }] },
          }),
        ),
      /prefix/,
    );
  });
});

describe('validateMainSource', () => {
  it('accepts a normal main.js', () => {
    assert.equal(validateMainSource('api.registerCommand("a.b", () => 1);'), 'api.registerCommand("a.b", () => 1);');
  });
  it('rejects empty and NUL-containing sources', () => {
    assert.throws(() => validateMainSource(''), /non-empty/);
    assert.throws(() => validateMainSource('a\0b'), /NUL/);
  });
});
