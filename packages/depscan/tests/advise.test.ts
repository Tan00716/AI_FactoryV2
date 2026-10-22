/**
 * @ai-factory/depscan — upgrade-plan builder tests.
 *
 * Fixture: a fake registry with known outdated deps; asserts the safety
 * grading (patch/minor/major), wanted-vs-latest, unknown packages, and
 * CVE cross-reference injection.
 * Run compiled: node --test packages/depscan/dist/tests/advise.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpgradePlan, urgencyRank } from '../src/index';
import type { InstalledDep, RegistryMeta } from '../src/index';

function registry(): Map<string, RegistryMeta> {
  return new Map([
    [
      'tiny-patch',
      { name: 'tiny-patch', versions: ['1.0.0', '1.0.1', '1.0.5'], latest: '1.0.5', changelogUrl: 'https://example.test/tiny-patch/releases' },
    ],
    [
      'mid-minor',
      { name: 'mid-minor', versions: ['1.2.0', '1.3.0', '1.4.2'], latest: '1.4.2' },
    ],
    [
      'big-major',
      { name: 'big-major', versions: ['2.0.0', '2.9.9', '3.0.0', '3.1.0'], latest: '3.1.0' },
    ],
    [
      'fresh',
      { name: 'fresh', versions: ['5.0.0'], latest: '5.0.0' },
    ],
  ]);
}

function installed(): InstalledDep[] {
  return [
    { name: 'tiny-patch', current: '1.0.0', declaredRange: '^1.0.0', dev: false },
    { name: 'mid-minor', current: '1.2.0', declaredRange: '~1.2.0', dev: false },
    { name: 'big-major', current: '2.0.0', declaredRange: '^2.0.0', dev: true },
    { name: 'fresh', current: '5.0.0', declaredRange: '^5.0.0', dev: false },
    { name: 'ghost-pkg', current: '0.1.0', declaredRange: '^0.1.0', dev: false },
  ];
}

describe('buildUpgradePlan grading', () => {
  it('grades patch/minor/major/up-to-date/unknown correctly', () => {
    const plan = buildUpgradePlan(installed(), registry(), { generatedAt: '2026-10-22T00:00:00.000Z' });
    const byName = new Map(plan.advisories.map((a) => [a.name, a]));
    assert.equal(byName.get('tiny-patch')?.grade, 'patch');
    assert.equal(byName.get('tiny-patch')?.latest, '1.0.5');
    assert.equal(byName.get('tiny-patch')?.wanted, '1.0.5');
    assert.equal(byName.get('mid-minor')?.grade, 'minor');
    assert.equal(byName.get('mid-minor')?.wanted, '1.2.0'); // ~1.2.0 pins the minor
    assert.equal(byName.get('big-major')?.grade, 'major');
    assert.equal(byName.get('big-major')?.reviewFirst, true);
    assert.equal(byName.get('fresh')?.grade, 'up-to-date');
    assert.equal(byName.get('ghost-pkg')?.grade, 'unknown');
    assert.equal(byName.get('ghost-pkg')?.latest, null);
  });

  it('summary counts are right', () => {
    const plan = buildUpgradePlan(installed(), registry(), { generatedAt: '2026-10-22T00:00:00.000Z' });
    assert.deepEqual(plan.summary, {
      total: 5, upToDate: 1, patch: 1, minor: 1, major: 1, unknown: 1, cveAffected: 0,
    });
  });

  it('commands put review-first upgrades last', () => {
    const plan = buildUpgradePlan(installed(), registry(), { generatedAt: '2026-10-22T00:00:00.000Z' });
    assert.deepEqual(plan.commands, [
      'npm install mid-minor@1.4.2',
      'npm install tiny-patch@1.0.5',
      'npm install -D big-major@3.1.0',
    ]);
  });

  it('is deterministic: same input, same output', () => {
    const a = JSON.stringify(buildUpgradePlan(installed(), registry(), { generatedAt: 'x' }));
    const b = JSON.stringify(buildUpgradePlan(installed(), registry(), { generatedAt: 'x' }));
    assert.equal(a, b);
  });
});

describe('CVE cross-reference', () => {
  it('attaches hits and marks reviewFirst', () => {
    const plan = buildUpgradePlan(installed(), registry(), {
      generatedAt: '2026-10-22T00:00:00.000Z',
      cveMatcher: (name, version) =>
        name === 'big-major' && version === '2.0.0'
          ? [{ id: 'CVE-2099-0001', severity: 'error', note: 'test fixture' }]
          : [],
    });
    const big = plan.advisories.find((a) => a.name === 'big-major')!;
    assert.equal(big.cves.length, 1);
    assert.equal(big.cves[0].id, 'CVE-2099-0001');
    assert.equal(big.reviewFirst, true);
    assert.equal(plan.summary.cveAffected, 1);
  });

  it('a throwing matcher never breaks the plan', () => {
    const plan = buildUpgradePlan(installed(), registry(), {
      generatedAt: '2026-10-22T00:00:00.000Z',
      cveMatcher: () => { throw new Error('boom'); },
    });
    assert.equal(plan.advisories.length, 5);
    assert.equal(plan.summary.cveAffected, 0);
  });
});

describe('urgencyRank', () => {
  it('orders CVE > major > minor > patch > unknown > up-to-date', () => {
    const plan = buildUpgradePlan(installed(), registry(), {
      generatedAt: 'x',
      cveMatcher: (n) => (n === 'tiny-patch' ? [{ id: 'CVE-1', severity: 'error' }] : []),
    });
    const ordered = [...plan.advisories].sort((a, b) => urgencyRank(a) - urgencyRank(b));
    assert.deepEqual(ordered.map((a) => a.name), [
      'tiny-patch', 'big-major', 'mid-minor', 'ghost-pkg', 'fresh',
    ]);
  });
});
