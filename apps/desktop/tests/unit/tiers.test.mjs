/**
 * Desktop unit tests for tiered navigation + golden path (V3-#3).
 * node:test + node:assert/strict. React-free pure module, no DOM:
 * persistence goes through an injectable storage shim.
 * Run: node --test apps/desktop/tests/unit/tiers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tiers = await import('../../src/navigation/tiers.ts');
const {
  CENTER_TABS, COMMON_TABS, EXPERT_TABS, ADVANCED_TABS,
  DEFAULT_NAV_TIER_STATE, GOLDEN_PATH_STEPS, PANEL_GUIDE_KEYS,
  tierOf, tabsOfTier, visibleTabs,
  loadNavTierState, saveNavTierState,
  loadGoldenPathProgress, saveGoldenPathProgress,
} = tiers;

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, v); },
  };
}

test('common tier is capped at 12 tabs (V3-#3 success standard)', () => {
  assert.ok(COMMON_TABS.length <= 12, `common has ${COMMON_TABS.length} tabs`);
  assert.equal(COMMON_TABS.length, 12);
});

test('every center tab belongs to exactly one tier', () => {
  const all = [...COMMON_TABS, ...ADVANCED_TABS, ...EXPERT_TABS];
  assert.equal(new Set(all).size, all.length, 'tier lists must not overlap');
  assert.equal(new Set(all).size, CENTER_TABS.length);
  for (const t of CENTER_TABS) {
    assert.ok(['common', 'advanced', 'expert'].includes(tierOf(t)));
  }
});

test('default state shows only common tabs; showAll shows everything', () => {
  const def = { ...DEFAULT_NAV_TIER_STATE };
  assert.deepEqual(def, { expandedAdvanced: false, expandedExpert: false, showAll: false });
  assert.deepEqual([...visibleTabs(def)].sort(), [...COMMON_TABS].sort());
  assert.deepEqual(visibleTabs({ ...def, showAll: true }), [...CENTER_TABS]);
  assert.deepEqual(
    [...visibleTabs({ ...def, expandedAdvanced: true })].sort(),
    [...CENTER_TABS.filter((t) => tierOf(t) !== 'expert')].sort(),
  );
});

test('nav tier state persists and corrupt storage falls back to default', () => {
  const s = memStorage();
  saveNavTierState({ expandedAdvanced: true, expandedExpert: false, showAll: false }, s);
  assert.equal(loadNavTierState(s).expandedAdvanced, true);
  s.setItem('ai-factory.navTiers.v1', '{not json');
  assert.deepEqual(loadNavTierState(s), { ...DEFAULT_NAV_TIER_STATE });
  assert.deepEqual(loadNavTierState(null), { ...DEFAULT_NAV_TIER_STATE });
});

test('golden path has 4 steps jumping to existing tabs', () => {
  assert.equal(GOLDEN_PATH_STEPS.length, 4);
  for (const step of GOLDEN_PATH_STEPS) {
    assert.ok(CENTER_TABS.includes(step.target), `step ${step.id} targets ${step.target}`);
    assert.ok(['goto-tab', 'open-create'].includes(step.action));
  }
});

test('golden path progress persists, drops unknown step ids', () => {
  const s = memStorage();
  saveGoldenPathProgress({ done: ['project', 'bogus'], dismissed: true }, s);
  const loaded = loadGoldenPathProgress(s);
  assert.deepEqual(loaded.done, ['project']);
  assert.equal(loaded.dismissed, true);
});

test('panel guides cover exactly the Top 20 list panels', () => {
  assert.equal(PANEL_GUIDE_KEYS.length, 20);
  assert.equal(new Set(PANEL_GUIDE_KEYS).size, 20);
});

test('tabsOfTier matches tierOf for every tab', () => {
  for (const tier of ['common', 'advanced', 'expert']) {
    for (const t of tabsOfTier(tier)) assert.equal(tierOf(t), tier);
  }
});
