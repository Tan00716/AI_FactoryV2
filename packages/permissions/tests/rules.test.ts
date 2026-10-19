/**
 * Declarative allow/ask/deny tool rules — unit tests.
 *
 * Run compiled: node --test packages/permissions/dist/tests/rules.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRules,
  globMatch,
  globToRegExp,
  mergeRuleLayers,
  validateRule,
  validateRuleList,
} from '../src/index.js';

describe('globMatch', () => {
  it('* matches within one segment only', () => {
    assert.equal(globMatch('npm run *', 'npm run build'), true);
    assert.equal(globMatch('*.ts', 'a.ts'), true);
    assert.equal(globMatch('*.ts', 'a/b.ts'), false);
    assert.equal(globMatch('rm -rf *', 'rm -rf /tmp/x'), false); // does not cross '/'
  });
  it('** crosses segments', () => {
    assert.equal(globMatch('rm -rf **', 'rm -rf /tmp/x'), true);
    assert.equal(globMatch('src/**/*.ts', 'src/a/b/c.ts'), true);
    assert.equal(globMatch('src/**/*.ts', 'src/a.ts'), true); // **/ matches zero segments
    assert.equal(globMatch('**', 'anything/at/all'), true);
  });
  it('? matches one non-slash char', () => {
    assert.equal(globMatch('a?c', 'abc'), true);
    assert.equal(globMatch('a?c', 'ac'), false);
    assert.equal(globMatch('a?c', 'a/c'), false);
  });
  it('full-string match, regex chars escaped', () => {
    assert.equal(globMatch('a.b', 'a.b'), true);
    assert.equal(globMatch('a.b', 'axb'), false);
    assert.equal(globMatch('npm run (build)', 'npm run (build)'), true);
  });
  it('globToRegExp anchors', () => {
    assert.equal(globToRegExp('*').test(''), true);
    assert.equal(globMatch('npm*', 'npm run x'), true); // space is not '/'
    assert.equal(globMatch('npm*', 'npm/run'), false); // '*' does not cross '/'
  });
});

describe('validateRule', () => {
  it('accepts a well-formed rule', () => {
    const v = validateRule({ tool: 'Bash', pattern: 'npm run *', effect: 'allow' });
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.rule, { tool: 'Bash', pattern: 'npm run *', effect: 'allow' });
  });
  it('rejects bad shapes', () => {
    assert.equal(validateRule(null).ok, false);
    assert.equal(validateRule({ tool: '', pattern: 'x', effect: 'allow' }).ok, false);
    assert.equal(validateRule({ tool: 'Bash', pattern: '', effect: 'allow' }).ok, false);
    assert.equal(
      validateRule({ tool: 'Bash', pattern: 'x', effect: 'maybe' }).ok,
      false,
    );
  });
  it('warns on match-everything rules', () => {
    const v = validateRule({ tool: '*', pattern: '*', effect: 'deny' });
    assert.equal(v.ok, true);
    if (v.ok) assert.match(v.warnings.join(' '), /EVERY tool call/);
  });
  it('validateRuleList accepts {rules:[...]} and bare arrays', () => {
    const a = validateRuleList([{ tool: 'Bash', pattern: 'x', effect: 'ask' }]);
    const b = validateRuleList({ rules: [{ tool: 'Bash', pattern: 'x', effect: 'ask' }] });
    assert.equal(a.ok && b.ok, true);
    assert.equal(validateRuleList({ rules: [{ tool: 'Bash' }] }).ok, false);
    assert.equal(validateRuleList('nope').ok, false);
  });
});

const L = (name: string, rules: { tool: string; pattern: string; effect: 'allow' | 'ask' | 'deny' }[]) => ({
  name,
  rules,
});

describe('evaluateRules', () => {
  it('no matching rule → undefined (caller keeps default policy)', () => {
    const v = evaluateRules([L('project', [{ tool: 'Bash', pattern: 'npm run *', effect: 'allow' }])], 'Bash', [], 'git status');
    assert.equal(v, undefined);
  });
  it('deny beats ask beats allow on the same call', () => {
    const layers = [
      L('project', [
        { tool: 'Bash', pattern: 'rm -rf *', effect: 'allow' },
        { tool: 'Bash', pattern: 'rm -rf *', effect: 'ask' },
      ]),
    ];
    // ask wins over allow here (no deny present)
    assert.equal(evaluateRules(layers, 'Bash', [], 'rm -rf foo')?.effect, 'ask');
    const withDeny = [
      L('project', [
        { tool: 'Bash', pattern: 'rm -rf *', effect: 'allow' },
        { tool: '*', pattern: 'rm -rf *', effect: 'deny' },
      ]),
    ];
    const v = evaluateRules(withDeny, 'Bash', [], 'rm -rf foo');
    assert.equal(v?.effect, 'deny');
    assert.equal(v?.rule.tool, '*');
  });
  it('deny in an earlier layer beats allow in a later layer', () => {
    // Cross-rule: a project-layer deny on a specific pattern still beats a
    // personal-layer allow on a broader pattern — deny always wins.
    const layers = [
      L('project', [{ tool: 'Bash', pattern: 'rm -rf **', effect: 'deny' }]),
      L('personal', [{ tool: 'Bash', pattern: '**', effect: 'allow' }]),
    ];
    const v = evaluateRules(layers, 'Bash', [], 'rm -rf /tmp/x');
    assert.equal(v?.effect, 'deny');
    assert.equal(v?.layer, 'project');
  });
  it('later layer overrides identical (tool, pattern)', () => {
    const layers = [
      L('project', [{ tool: 'Bash', pattern: 'npm run *', effect: 'deny' }]),
      L('personal', [{ tool: 'Bash', pattern: 'npm run *', effect: 'allow' }]),
    ];
    const v = evaluateRules(layers, 'Bash', [], 'npm run build');
    assert.equal(v?.effect, 'allow');
    assert.equal(v?.layer, 'personal');
  });
  it('tool aliases match', () => {
    const layers = [L('project', [{ tool: 'Bash', pattern: 'npm run *', effect: 'allow' }])];
    const v = evaluateRules(layers, 'shell.execute', ['Bash'], 'npm run build');
    assert.equal(v?.effect, 'allow');
    // without the alias, 'Bash' does not match 'shell.execute'
    assert.equal(evaluateRules(layers, 'shell.execute', [], 'npm run build'), undefined);
  });
  it('tool glob supports mcp__* style prefixes', () => {
    const layers = [L('project', [{ tool: 'mcp__*', pattern: '*', effect: 'ask' }])];
    assert.equal(evaluateRules(layers, 'mcp__slack__send_message', [], 'hello')?.effect, 'ask');
    assert.equal(evaluateRules(layers, 'Bash', [], 'hello'), undefined);
  });
  it('first matching rule wins ties within one effect', () => {
    const layers = [
      L('project', [
        { tool: 'Bash', pattern: 'npm *', effect: 'allow' },
        { tool: 'Bash', pattern: '*', effect: 'allow' },
      ]),
    ];
    const v = evaluateRules(layers, 'Bash', [], 'npm run build');
    assert.equal(v?.rule.pattern, 'npm *');
  });
  it('winning rule carries its layer name', () => {
    const layers = [L('global', [{ tool: '*', pattern: '*', effect: 'ask' }])];
    assert.equal(evaluateRules(layers, 'Bash', [], 'x')?.layer, 'global');
  });
});

describe('mergeRuleLayers', () => {
  it('later identical (tool,pattern) replaces earlier, order otherwise kept', () => {
    const merged = mergeRuleLayers([
      L('project', [
        { tool: 'Bash', pattern: 'a', effect: 'deny' },
        { tool: 'Bash', pattern: 'b', effect: 'allow' },
      ]),
      L('personal', [{ tool: 'Bash', pattern: 'a', effect: 'allow' }]),
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.rule.effect, 'allow');
    assert.equal(merged[0]?.layer, 'personal');
    assert.equal(merged[1]?.rule.pattern, 'b');
  });
});
