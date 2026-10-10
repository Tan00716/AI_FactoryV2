/**
 * Tests for ProjectAutonomyStore — §80 project settings.
 * Run: node --test dist/tests/store.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectAutonomyStore } from '../src/index';

const FIXED_NOW = 1728374400000;
const clock = () => FIXED_NOW;

describe('ProjectAutonomyStore', () => {
  it('defaults unknown projects to assisted', () => {
    const store = new ProjectAutonomyStore(clock);
    const s = store.get('p-new');
    assert.equal(s.projectId, 'p-new');
    assert.equal(s.mode, 'assisted');
    assert.equal(s.updatedBy, 'system');
  });

  it('set/get round-trips a mode change', () => {
    const store = new ProjectAutonomyStore(clock);
    const saved = store.set('p-1', 'full', 'tan');
    assert.equal(saved.mode, 'full');
    assert.equal(saved.updatedBy, 'tan');
    assert.equal(saved.updatedAt, new Date(FIXED_NOW).toISOString());
    assert.equal(store.get('p-1').mode, 'full');
  });

  it('rejects invalid modes without storing anything', () => {
    const store = new ProjectAutonomyStore(clock);
    assert.throws(() => store.set('p-1', 'god-mode', 'tan'), /invalid autonomy mode/);
    assert.equal(store.list().length, 0);
  });

  it('accepts all four modes', () => {
    const store = new ProjectAutonomyStore(clock);
    for (const mode of ['assisted', 'semi', 'autonomous', 'full']) {
      store.set(`p-${mode}`, mode, 'tan');
    }
    assert.equal(store.list().length, 4);
  });

  it('returns copies so callers cannot mutate the store', () => {
    const store = new ProjectAutonomyStore(clock);
    store.set('p-1', 'semi', 'tan');
    const a = store.get('p-1');
    a.mode = 'full';
    assert.equal(store.get('p-1').mode, 'semi');
  });
});
