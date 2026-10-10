/**
 * Tests for the minimal YAML subset parser (§98/§99 support).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { YamlParseError, parseYaml } from '../src/index';

describe('yaml scalar types', () => {
  it('parses strings, booleans, null, integers, floats', () => {
    const doc = parseYaml('a: hello\nb: true\nc: false\nd: null\ne: 8\nf: 1.5\n') as Record<string, unknown>;
    assert.equal(doc['a'], 'hello');
    assert.equal(doc['b'], true);
    assert.equal(doc['c'], false);
    assert.equal(doc['d'], null);
    assert.equal(doc['e'], 8);
    assert.equal(doc['f'], 1.5);
  });

  it('parses quoted strings and keeps # inside quotes', () => {
    const doc = parseYaml('a: "x # y"\nb: \'z # w\'\n') as Record<string, unknown>;
    assert.equal(doc['a'], 'x # y');
    assert.equal(doc['b'], 'z # w');
  });

  it('strips comments', () => {
    const doc = parseYaml('a: 1 # comment\n# whole line\nb: 2\n') as Record<string, unknown>;
    assert.deepEqual(doc, { a: 1, b: 2 });
  });
});

describe('yaml structure', () => {
  it('parses nested maps (§98 style)', () => {
    const doc = parseYaml('project:\n  name: MyApp\nworkflow:\n  production_approval: human\n') as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(doc['project']['name'], 'MyApp');
    assert.equal(doc['workflow']['production_approval'], 'human');
  });

  it('parses block lists', () => {
    const doc = parseYaml('items:\n  - a\n  - b\n  - 3\n') as Record<string, unknown[]>;
    assert.deepEqual(doc['items'], ['a', 'b', 3]);
  });

  it('parses lists of inline maps', () => {
    const doc = parseYaml('agents:\n  - name: x\n    role: coder\n  - name: y\n    role: qa\n') as Record<
      string,
      Array<Record<string, unknown>>
    >;
    assert.equal(doc['agents'].length, 2);
    assert.equal(doc['agents'][0]['name'], 'x');
    assert.equal(doc['agents'][1]['role'], 'qa');
  });

  it('parses nested block under a list dash', () => {
    const doc = parseYaml('items:\n  -\n    a: 1\n    b: 2\n') as Record<string, unknown[]>;
    assert.deepEqual(doc['items'], [{ a: 1, b: 2 }]);
  });

  it('treats missing values as null', () => {
    const doc = parseYaml('a:\nb: 1\n') as Record<string, unknown>;
    assert.equal(doc['a'], null);
    assert.equal(doc['b'], 1);
  });
});

describe('yaml errors', () => {
  it('throws on tab indentation', () => {
    assert.throws(() => parseYaml('a:\n\tb: 1\n'), (e) => e instanceof YamlParseError);
  });

  it('throws on duplicate keys', () => {
    assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  });

  it('throws on unexpected indentation', () => {
    assert.throws(() => parseYaml('a: 1\n    b: 2\n'), YamlParseError);
  });
});
