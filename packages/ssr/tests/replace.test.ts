/**
 * Replacement tests, including the headline contrast experiment:
 * structural rename of a shadowed local variable vs. blind text search.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateTemplate,
  findMatches,
  previewEdits,
  applyEdits,
  renderDiff,
  codeMask,
} from '../src/index.js';
import type { SsrTemplate } from '../src/index.js';

const here = join(__dirname, '..', '..', 'tests', 'fixtures', 'repo');
const ctrPath = join(here, 'counters.ts');
const ctrText = readFileSync(ctrPath, 'utf8');

function tpl(t: unknown): SsrTemplate {
  const { template, errors } = validateTemplate(t);
  assert.equal(errors.length, 0, errors.join('; '));
  return template!;
}

describe('contrast experiment: structural rename vs text search', () => {
  const renameTpl = tpl({
    id: 'rename-count',
    name: 'rename count in alpha',
    version: 1,
    search: { kind: 'variable', namePattern: '^count$', enclosing: '^alpha$' },
    replace: { op: 'rename', to: 'total' },
  });

  it('template matches exactly the alpha-scoped variable', () => {
    const ms = findMatches([{ file: 'counters.ts', text: ctrText }], renameTpl);
    assert.equal(ms.length, 1);
    assert.equal(ms[0].parent, 'alpha');
    assert.equal(ms[0].startLine, 5);
  });

  it('structural rename touches 3 occurrences; text search would hit 6', () => {
    const ms = findMatches([{ file: 'counters.ts', text: ctrText }], renameTpl);
    const files = new Map([['counters.ts', ctrText]]);
    const { edits, skipped } = previewEdits(files, ms, renameTpl);
    assert.equal(skipped.length, 0);
    assert.equal(edits.length, 1);
    const after = applyEdits(files, edits).get('counters.ts')!;

    // occurrences of the identifier `total` now: exactly the 3 alpha lines
    const totalHits = (after.match(/(?<!\.)\btotal\b/g) || []).length;
    assert.equal(totalHits, 3);

    // beta's count is untouched
    assert.ok(after.includes('let count = 100;'));
    assert.ok(after.includes('return count - 1;'));
    // the property access obj.count is untouched
    assert.ok(after.includes('obj.count'));
    // alpha's own lines renamed
    assert.ok(after.includes('let total = 0;'));
    assert.ok(after.includes('total += 1;'));
    assert.ok(after.includes('return total;'));

    // blind text search hits: code-only occurrences a text replace would take
    // (comments masked out via codeMask — a real text search hits comments too,
    // which only makes the structural advantage larger)
    const mask = codeMask(ctrText);
    const codeOnly = [...ctrText].map((ch, i) => (mask[i] === 1 ? ch : ' ')).join('');
    const textHits = (codeOnly.match(/(?<!\.)\bcount\b/g) || []).length;
    assert.equal(textHits, 6); // alpha x3 + beta x2 + gamma's `{ count: number }` annotation
    assert.ok(textHits > totalHits, 'structural rename is strictly more precise');
  });

  it('preview diff shows exactly the alpha hunk', () => {
    const ms = findMatches([{ file: 'counters.ts', text: ctrText }], renameTpl);
    const files = new Map([['counters.ts', ctrText]]);
    const { diffs } = previewEdits(files, ms, renameTpl);
    const d = diffs['counters.ts'];
    assert.ok(d.includes('-  let count = 0;'));
    assert.ok(d.includes('+  let total = 0;'));
    assert.ok(!d.includes('let count = 100;'), 'beta body stays out of the hunk');
    assert.ok(!d.includes('return count - 1;'), 'beta body stays out of the hunk');
  });
});

describe('replaceRange', () => {
  it('replaces the whole node range with $name substitution', () => {
    const t = tpl({
      id: 'rr-1',
      name: 'x',
      version: 1,
      search: { kind: 'function', namePattern: '^beta$' },
      replace: { op: 'replaceRange', text: 'export function $name(): number {\n  return -1;\n}' },
    });
    const ms = findMatches([{ file: 'counters.ts', text: ctrText }], t);
    assert.equal(ms.length, 1);
    const files = new Map([['counters.ts', ctrText]]);
    const { edits } = previewEdits(files, ms, t);
    const after = applyEdits(files, edits).get('counters.ts')!;
    assert.ok(after.includes('export function beta(): number {\n  return -1;\n}'));
    assert.ok(after.includes('export function alpha()'), 'alpha untouched');
  });
});

describe('addModifier', () => {
  const svcText = readFileSync(join(here, 'service.ts'), 'utf8');

  it('inserts a visibility modifier into a method definition line', () => {
    const t = tpl({
      id: 'am-1',
      name: 'x',
      version: 1,
      search: { kind: 'method', namePattern: '^refreshAll$' },
      replace: { op: 'addModifier', modifier: 'private' },
    });
    const ms = findMatches([{ file: 'service.ts', text: svcText }], t);
    assert.equal(ms.length, 1);
    const files = new Map([['service.ts', svcText]]);
    const { edits, skipped } = previewEdits(files, ms, t);
    assert.equal(skipped.length, 0);
    const after = applyEdits(files, edits).get('service.ts')!;
    assert.ok(after.includes('  private async refreshAll()'));
  });

  it('skips when a visibility modifier is already present', () => {
    const t = tpl({
      id: 'am-2',
      name: 'x',
      version: 1,
      search: { kind: 'method', namePattern: '^getUser$' },
      replace: { op: 'addModifier', modifier: 'private' },
    });
    const ms = findMatches([{ file: 'service.ts', text: svcText }], t);
    const files = new Map([['service.ts', svcText]]);
    const { edits, skipped } = previewEdits(files, ms, t);
    assert.equal(edits.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /already has visibility/);
  });

  it('skips non-method nodes', () => {
    const t = tpl({
      id: 'am-3',
      name: 'x',
      version: 1,
      search: { kind: 'function', namePattern: '^alpha$' },
      replace: { op: 'addModifier', modifier: 'private' },
    });
    const ms = findMatches([{ file: 'counters.ts', text: ctrText }], t);
    const files = new Map([['counters.ts', ctrText]]);
    const { edits, skipped } = previewEdits(files, ms, t);
    assert.equal(edits.length, 0);
    assert.equal(skipped[0].reason, 'addModifier only applies to methods');
  });
});

describe('renderDiff', () => {
  it('renders context + removed + added lines', () => {
    const d = renderDiff('f.ts', ['a', 'b', 'c', 'd', 'e'], {
      file: 'f.ts',
      startLine: 3,
      endLine: 3,
      newLines: ['C'],
      summary: 'x',
    });
    assert.ok(d.includes('--- a/f.ts'));
    assert.ok(d.includes('-c'));
    assert.ok(d.includes('+C'));
    assert.ok(d.includes(' b'));
  });
});
