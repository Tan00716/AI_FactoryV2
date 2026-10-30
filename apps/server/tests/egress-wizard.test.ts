/**
 * Egress first-run wizard tests (V3-#5) — store-level + pure merge.
 * Run: node --test apps/server/tests/egress-wizard.test.ts (type-stripping;
 * egress.ts imports node builtins only, so src import is safe).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EGRESS_WIZARD_TEMPLATES,
  EgressStore,
  mergeWizardRules,
  wizardTemplateRules,
} from '../src/egress.ts';

function tmpStore(): { store: EgressStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-egress-wiz-'));
  return { store: new EgressStore(path.join(dir, 'data')), dir };
}

test('factory default: missing file is enabled + deny, not legacy', () => {
  const { store, dir } = tmpStore();
  const g = store.getGlobal();
  assert.equal(g.enabled, true);
  assert.equal(g.defaultPolicy, 'deny');
  assert.deepEqual(g.rules, []);
  assert.equal(g.factoryDefault, true);
  assert.equal(g.legacy, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy: pre-wizard file is kept verbatim and flagged legacy', () => {
  const { store, dir } = tmpStore();
  const file = store.globalFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Old-format file: no policyVersion, no wizard fields.
  fs.writeFileSync(file, JSON.stringify({
    enabled: false,
    defaultPolicy: 'deny',
    rules: [{ domain: 'old.example', action: 'allow' }],
    updatedAt: new Date().toISOString(),
    updatedBy: 'human',
  }));
  const g = store.getGlobal();
  assert.equal(g.enabled, false);
  assert.equal(g.legacy, true);
  assert.equal(g.factoryDefault, false);
  assert.deepEqual(g.rules, [{ domain: 'old.example', action: 'allow' }]);
  // A write by current code clears legacy and stamps policyVersion.
  const next = store.setGlobal({ enabled: true, defaultPolicy: 'deny', rules: g.rules }, 'human');
  assert.equal(next.policyVersion, 2);
  assert.equal(store.getGlobal().legacy, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupt file still fails safe to disabled + loadError', () => {
  const { store, dir } = tmpStore();
  const file = store.globalFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const g = store.getGlobal();
  assert.equal(g.enabled, false);
  assert.match(g.loadError ?? '', /unreadable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wizard templates: known ids expand, unknown ids reported', () => {
  const { rules, unknownIds } = wizardTemplateRules(['npm', 'nope']);
  assert.deepEqual(unknownIds, ['nope']);
  assert.ok(rules.some((r) => r.domain === 'registry.npmjs.org' && r.action === 'allow'));
  assert.ok(rules.every((r) => (r.note ?? '').startsWith('wizard-template:')));
  assert.ok(EGRESS_WIZARD_TEMPLATES.length >= 7);
  // Every template domain validates.
  for (const t of EGRESS_WIZARD_TEMPLATES) {
    assert.ok(t.domains.length >= 1);
    assert.ok(t.id && t.label && t.description && t.risk);
  }
});

test('mergeWizardRules: existing rules verbatim first, dedupe, never delete', () => {
  const existing = [{ domain: 'old.example', action: 'allow' as const }];
  const { merged, added, preserved } = mergeWizardRules(existing, [
    { domain: 'old.example', action: 'allow', note: 'wizard-template:x' },
    { domain: 'registry.npmjs.org', action: 'allow', note: 'wizard-template:npm' },
  ]);
  assert.equal(preserved, 1);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.domain, 'registry.npmjs.org');
  assert.deepEqual(merged[0], existing[0]);
  assert.equal(merged.length, 2);
});

test('wizard dismiss state lives outside egress.json', () => {
  const { store, dir } = tmpStore();
  assert.deepEqual(store.getWizardState(), {});
  const state = store.dismissWizard();
  assert.ok(state.dismissedAt);
  assert.deepEqual(store.getWizardState(), state);
  assert.equal(fs.existsSync(store.globalFile()), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
