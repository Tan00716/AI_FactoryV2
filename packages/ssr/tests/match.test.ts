/**
 * Template validation + structural matching tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateTemplate,
  findMatches,
  builtinTemplates,
  builtinTemplateById,
} from '../src/index.js';
import type { SsrTemplate } from '../src/index.js';

const here = join(__dirname, '..', '..', 'tests', 'fixtures', 'repo');
const files = [
  { file: 'service.ts', text: readFileSync(join(here, 'service.ts'), 'utf8') },
  { file: 'counters.ts', text: readFileSync(join(here, 'counters.ts'), 'utf8') },
];

describe('validateTemplate', () => {
  it('accepts a well-formed template', () => {
    const { template, errors } = validateTemplate({
      id: 'demo-1',
      name: 'Demo',
      version: 1,
      search: { kind: 'method', modifiersAbsent: ['private'] },
      replace: { op: 'rename', to: 'renamed' },
    });
    assert.equal(errors.length, 0);
    assert.ok(template);
  });

  it('rejects bad ids, bad regexes, bad ops fail-closed', () => {
    for (const bad of [
      { id: 'Bad_ID', name: 'x', search: {} },
      { id: 'ok', name: 'x', search: { namePattern: '([' } },
      { id: 'ok', name: 'x', search: {}, replace: { op: 'rename', to: 'not an ident!' } },
      { id: 'ok', name: 'x', search: {}, replace: { op: 'explode' } },
      { id: 'ok', name: 'x', search: { minParams: 5, maxParams: 2 } },
      null,
      'nope',
    ]) {
      const { template, errors } = validateTemplate(bad);
      assert.equal(template, null);
      assert.ok(errors.length > 0, JSON.stringify(bad));
    }
  });
});

describe('builtin templates on the fixture repo', () => {
  it('public-methods: all non-private/protected methods', () => {
    const t = builtinTemplateById('public-methods')!;
    const ms = findMatches(files, t);
    const names = ms.map((m) => `${m.parent}.${m.name}`).sort();
    // constructor, getUser, create, refreshAll (query is private)
    assert.deepEqual(names, [
      'UserService.constructor',
      'UserService.create',
      'UserService.getUser',
      'UserService.refreshAll',
    ]);
  });

  it('typed-variables: variables with declared type annotations', () => {
    const t = builtinTemplateById('typed-variables')!;
    const ms = findMatches(files, t);
    const names = ms.map((m) => m.name).sort();
    assert.deepEqual(names, ['MAX_RETRIES', 'greeting', 'items', 'row']);
  });

  it('async-methods: async modifier constraint', () => {
    const t = builtinTemplateById('async-methods')!;
    const ms = findMatches(files, t);
    const names = ms.map((m) => m.name).sort();
    assert.deepEqual(names, ['getUser', 'query', 'refreshAll']);
  });

  it('custom template: namePattern + enclosing + minParams', () => {
    const { template } = validateTemplate({
      id: 'custom-1',
      name: 'x',
      version: 1,
      search: { kind: 'function', namePattern: '^alpha|beta$', enclosing: '^(alpha|beta)$', minParams: 0, maxParams: 0 },
    });
    // enclosing on a top-level function never matches (no parent) → 0 hits
    assert.equal(findMatches(files, template!).length, 0);

    const { template: t2 } = validateTemplate({
      id: 'custom-2',
      name: 'x',
      version: 1,
      search: { kind: 'variable', namePattern: '^count$', enclosing: '^alpha$' },
    });
    const ms = findMatches(files, t2!);
    assert.equal(ms.length, 1);
    assert.equal(ms[0].parent, 'alpha');
    assert.equal(ms[0].file, 'counters.ts');
  });

  it('filePattern restricts the search to matching paths', () => {
    const { template } = validateTemplate({
      id: 'custom-3',
      name: 'x',
      version: 1,
      search: { kind: 'function', filePattern: 'counters\\.ts$' },
    });
    const ms = findMatches(files, template!);
    assert.ok(ms.length > 0);
    assert.ok(ms.every((m) => m.file === 'counters.ts'));
  });
});

describe('builtinTemplates', () => {
  it('all four builtins validate and have stable ids', () => {
    const ids = builtinTemplates().map((t: SsrTemplate) => t.id);
    assert.deepEqual(ids, ['public-methods', 'typed-variables', 'long-functions', 'async-methods']);
  });
});
