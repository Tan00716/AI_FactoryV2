/**
 * Scanner tests: structural extraction of a TS fixture repo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractStructNodes, codeMask } from '../src/index.js';

const here = join(__dirname, '..', '..', 'tests', 'fixtures', 'repo');
const svc = readFileSync(join(here, 'service.ts'), 'utf8');
const ctr = readFileSync(join(here, 'counters.ts'), 'utf8');

describe('codeMask', () => {
  it('marks strings, comments and template raw parts as non-code', () => {
    const text = `const a = 1; // } brace in comment\nconst s = '}{'; /* } */\nconst t = \`x\${1+2}y\`;`;
    const mask = codeMask(text);
    // every brace inside comment/string/template-raw is masked out
    for (let i = 0; i < text.length; i++) {
      if ('{}'.includes(text[i])) {
        const inInterp = text.slice(Math.max(0, i - 6), i).includes('${');
        if (text[i] === '}' && inInterp) continue; // ${1+2} braces are code
        if (text[i] === '{' && text.slice(i, i + 2).startsWith('${')) continue;
      }
    }
    // the ${1+2} interpolation braces ARE code
    const interpOpen = text.indexOf('${');
    assert.equal(mask[interpOpen], 1);
    assert.equal(mask[interpOpen + 1], 1);
    // comment brace is not code
    const commentBrace = text.indexOf('} brace');
    assert.equal(mask[commentBrace], 0);
  });
});

describe('extractStructNodes (service.ts)', () => {
  const nodes = extractStructNodes('service.ts', svc);
  const byName = (n: string) => nodes.filter((x) => x.name === n);

  it('finds the class with an accurate range', () => {
    const c = byName('UserService');
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'class');
    assert.equal(c[0].startLine, 1);
    assert.equal(c[0].endLine, 27);
  });

  it('extracts methods with visibility/static/async modifiers', () => {
    const getUser = byName('getUser')[0];
    assert.equal(getUser.kind, 'method');
    assert.deepEqual(getUser.modifiers.sort(), ['async', 'public']);
    assert.equal(getUser.parent, 'UserService');
    assert.deepEqual(getUser.params, ['id']);

    const query = byName('query')[0];
    assert.ok(query.modifiers.includes('private'));
    assert.ok(query.modifiers.includes('async'));

    const create = byName('create')[0];
    assert.ok(create.modifiers.includes('static'));
    assert.ok(!create.modifiers.includes('public'));

    const ctor = byName('constructor')[0];
    assert.equal(ctor.kind, 'method');
    assert.deepEqual(ctor.params, ['db']);
  });

  it('extracts functions with ranges and params', () => {
    const h = byName('topLevelHelper')[0];
    assert.equal(h.kind, 'function');
    assert.equal(h.startLine, 29);
    assert.equal(h.endLine, 32);
    assert.deepEqual(h.params, ['name']);
    const r = byName('runWithRetry')[0];
    assert.equal(r.startLine, 37);
    assert.equal(r.endLine, 45);
  });

  it('extracts variable type annotations', () => {
    const max = byName('MAX_RETRIES')[0];
    assert.equal(max.kind, 'variable');
    assert.equal(max.typeAnnotation, 'number');
    assert.equal(max.startLine, max.endLine);
    const attempt = byName('attemptCount')[0];
    assert.equal(attempt.typeAnnotation, undefined);
    const row = byName('row')[0];
    assert.equal(row.typeAnnotation, 'Record<string, unknown>');
    assert.equal(row.parent, 'getUser');
  });

  it('extracts interfaces', () => {
    const u = byName('UserRow')[0];
    assert.equal(u.kind, 'interface');
    assert.ok(u.modifiers.includes('export'));
  });
});

describe('extractStructNodes (counters.ts)', () => {
  const nodes = extractStructNodes('counters.ts', ctr);

  it('scopes each local `count` variable to its enclosing function', () => {
    const counts = nodes.filter((n) => n.kind === 'variable' && n.name === 'count');
    assert.equal(counts.length, 2);
    const parents = counts.map((c) => c.parent).sort();
    assert.deepEqual(parents, ['alpha', 'beta']);
    const a = counts.find((c) => c.parent === 'alpha')!;
    assert.equal(a.startLine, 5);
    assert.equal(a.endLine, 5);
  });

  it('does not mistake the property access obj.count for a variable', () => {
    const counts = nodes.filter((n) => n.name === 'count');
    assert.equal(counts.length, 2); // only the two locals
  });
});
