/**
 * @ai-factory/depscan — semver engine tests.
 * Run compiled: node --test packages/depscan/dist/tests/semver.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemver, compareSemver, diffKind, maxSatisfying, maxVersion } from '../src/index';

describe('parseSemver', () => {
  it('parses full versions', () => {
    const v = parseSemver('1.2.3');
    assert.deepEqual([v?.major, v?.minor, v?.patch], [1, 2, 3]);
  });
  it('parses short forms and v-prefix', () => {
    assert.equal(parseSemver('v2')?.major, 2);
    assert.equal(parseSemver('1.2')?.patch, 0);
    assert.deepEqual(parseSemver('1.2.3-beta.1')?.prerelease, ['beta', '1']);
  });
  it('rejects junk', () => {
    assert.equal(parseSemver('latest'), null);
    assert.equal(parseSemver(''), null);
    assert.equal(parseSemver('1.2.3.4.5'), null);
  });
});

describe('compareSemver', () => {
  it('orders numerically, not lexically', () => {
    assert.equal(compareSemver(parseSemver('1.10.0')!, parseSemver('1.9.0')!), 1);
    assert.equal(compareSemver(parseSemver('2.0.0')!, parseSemver('10.0.0')!), -1);
  });
  it('release beats prerelease', () => {
    assert.equal(compareSemver(parseSemver('1.0.0')!, parseSemver('1.0.0-alpha')!), 1);
  });
});

describe('diffKind', () => {
  it('classifies patch/minor/major', () => {
    assert.equal(diffKind('1.2.3', '1.2.4'), 'patch');
    assert.equal(diffKind('1.2.3', '1.3.0'), 'minor');
    assert.equal(diffKind('1.2.3', '2.0.0'), 'major');
    assert.equal(diffKind('1.2.3', '1.2.3'), 'none');
    assert.equal(diffKind('2.0.0', '1.9.9'), 'downgrade');
  });
  it('returns null for junk', () => {
    assert.equal(diffKind('latest', '1.0.0'), null);
  });
});

describe('maxSatisfying', () => {
  const vs = ['1.0.0', '1.2.0', '1.2.3', '1.3.0', '2.0.0'];
  it('caret ranges', () => {
    assert.equal(maxSatisfying(vs, '^1.2.0'), '1.3.0');
    assert.equal(maxSatisfying(vs, '^0.0.0'), null);
  });
  it('caret on 0.x narrows correctly', () => {
    assert.equal(maxSatisfying(['0.2.3', '0.2.9', '0.3.0'], '^0.2.3'), '0.2.9');
    assert.equal(maxSatisfying(['0.0.3', '0.0.4'], '^0.0.3'), '0.0.3');
  });
  it('tilde ranges', () => {
    assert.equal(maxSatisfying(vs, '~1.2.0'), '1.2.3');
  });
  it('exact and comparators', () => {
    assert.equal(maxSatisfying(vs, '1.2.0'), '1.2.0');
    assert.equal(maxSatisfying(vs, '>=1.2.0 <2.0.0'), '1.3.0');
  });
  it('wildcards', () => {
    assert.equal(maxSatisfying(vs, '*'), '2.0.0');
    assert.equal(maxSatisfying(vs, ''), '2.0.0');
  });
  it('unsupported syntax returns null (never guesses)', () => {
    assert.equal(maxSatisfying(vs, '1.2.3 || 2.0.0'), null);
    assert.equal(maxSatisfying(vs, '1.2.3 - 2.0.0'), null);
    assert.equal(maxSatisfying(vs, 'latest'), null);
  });
  it('prereleases excluded unless the range mentions one', () => {
    const withPre = [...vs, '2.1.0-beta.1'];
    assert.equal(maxSatisfying(withPre, '^2.0.0'), '2.0.0');
    assert.equal(maxSatisfying(withPre, '^2.1.0-beta.1'), '2.1.0-beta.1');
  });
});

describe('maxVersion', () => {
  it('picks the highest release, skipping prereleases and junk', () => {
    assert.equal(maxVersion(['1.0.0', '2.0.0-beta', '1.5.0', 'nonsense']), '1.5.0');
    assert.equal(maxVersion(['junk']), null);
  });
});
