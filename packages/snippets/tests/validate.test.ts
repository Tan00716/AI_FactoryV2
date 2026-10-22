import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSnippets } from '../src/validate.js';
import { BUILTIN_SNIPPETS } from '../src/defaults.js';
import { SnippetProviderRegistry } from '../src/providers.js';

const good = {
  id: 'my-for',
  trigger: 'for',
  description: 'loop',
  scope: ['typescript'],
  body: 'for (${1:i} of ${2:list}) {\n\t$0\n}',
};

describe('validateSnippets', () => {
  it('accepts a valid list', () => {
    const r = validateSnippets([good]);
    assert.deepEqual(r.issues, []);
    assert.equal(r.snippets.length, 1);
  });
  it('rejects non-array payload', () => {
    assert.deepEqual(validateSnippets({}).issues, ['snippets must be an array']);
  });
  it('rejects duplicate ids', () => {
    const r = validateSnippets([good, { ...good, trigger: 'other' }]);
    assert.match(r.issues.join('\n'), /duplicate id/);
  });
  it('rejects bad id shape', () => {
    const r = validateSnippets([{ ...good, id: 'Bad Id!' }]);
    assert.match(r.issues.join('\n'), /id must match/);
  });
  it('rejects empty trigger', () => {
    const r = validateSnippets([{ ...good, trigger: '  ' }]);
    assert.match(r.issues.join('\n'), /trigger/);
  });
  it('rejects empty scope', () => {
    const r = validateSnippets([{ ...good, scope: [] }]);
    assert.match(r.issues.join('\n'), /scope/);
  });
  it('rejects bad template body (nested placeholder)', () => {
    const r = validateSnippets([{ ...good, body: '${1:${2:x}}' }]);
    assert.match(r.issues.join('\n'), /body: nested/);
  });
  it('rejects oversized body', () => {
    const r = validateSnippets([{ ...good, body: 'x'.repeat(40_000) }]);
    assert.match(r.issues.join('\n'), /exceeds/);
  });
  it('ignores unknown fields (forward-compatible)', () => {
    const r = validateSnippets([{ ...good, future: 1 }]);
    assert.deepEqual(r.issues, []);
  });
});

describe('builtin defaults', () => {
  it('all builtin snippets validate clean', () => {
    const r = validateSnippets(BUILTIN_SNIPPETS);
    assert.deepEqual(r.issues, []);
    assert.ok(r.snippets.length >= 5);
  });
});

describe('SnippetProviderRegistry', () => {
  it('registers and lists provider snippets; failing providers are skipped', () => {
    const reg = new SnippetProviderRegistry();
    reg.register({ id: 'builtin', getSnippets: () => BUILTIN_SNIPPETS });
    reg.register({
      id: 'broken',
      getSnippets: () => {
        throw new Error('boom');
      },
    });
    const all = reg.getAll();
    assert.ok(all.length >= BUILTIN_SNIPPETS.length);
    assert.ok(reg.unregister('broken'));
    assert.deepEqual(reg.ids(), ['builtin']);
  });
  it('rejects empty provider id', () => {
    const reg = new SnippetProviderRegistry();
    assert.throws(() => reg.register({ id: ' ', getSnippets: () => [] }), /id is required/);
  });
});
