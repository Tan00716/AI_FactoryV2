/**
 * Tests for v1 → v2 migration — SPEC v2 §52.4.
 *
 * The golden rule: migration NEVER upgrades a claim. Old DONE is
 * legacy_completion_unverified unless proven otherwise, one task at a
 * time — a bulk "all old DONEs are Outcome Verified" is forbidden.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateMemoryText,
  migrateOrgEdges,
  migratePermissionsToCeilings,
  migrateProductionApproval,
  migrateTaskCompletion,
} from '../src/index';

describe('migrateOrgEdges (§52.4)', () => {
  it('converts parent_agent/children to PRIMARY_REPORTS_TO', () => {
    const { edges, warnings } = migrateOrgEdges([
      { id: 'pm', children: ['coder'] },
      { id: 'coder', parent_agent_id: 'pm' },
    ]);
    assert.deepEqual(warnings, []);
    assert.equal(edges.length, 1, 'no duplicate edge when both fields agree');
    assert.deepEqual(edges[0], {
      source_node_id: 'coder',
      target_node_id: 'pm',
      relationship_type: 'PRIMARY_REPORTS_TO',
      migrated_from: 'v1.parent_agent',
    });
  });

  it('children[] alone also migrates', () => {
    const { edges } = migrateOrgEdges([
      { id: 'pm', children: ['coder'] },
      { id: 'coder' },
    ]);
    assert.equal(edges[0].migrated_from, 'v1.children');
  });

  it('conflicts warn and parent_agent wins — never silent merge', () => {
    const { edges, warnings } = migrateOrgEdges([
      { id: 'pm-a', children: ['coder'] },
      { id: 'pm-b' },
      { id: 'coder', parent_agent_id: 'pm-b' },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /disagrees/);
    assert.ok(!edges.some((e) => e.source_node_id === 'coder' && e.target_node_id === 'pm-a'));
  });

  it('dangling references warn instead of creating ghost edges', () => {
    const { edges, warnings } = migrateOrgEdges([{ id: 'pm', children: ['ghost'] }]);
    assert.deepEqual(edges, []);
    assert.equal(warnings.length, 1);
  });
});

describe('migratePermissionsToCeilings (§52.4)', () => {
  it('old permissions become ceilings, not grants', () => {
    const [c] = migratePermissionsToCeilings([{ id: 'a1', permissions: ['deploy.prod', 'secret.read'] }]);
    assert.deepEqual(c.ceiling, ['deploy.prod', 'secret.read']);
    assert.deepEqual(c.migratedFrom, ['deploy.prod', 'secret.read']);
    assert.ok(!('granted' in c), 'no grant field — a ceiling authorizes nothing');
  });
});

describe('migrateTaskCompletion (§52.4)', () => {
  it('old DONE without full proof → legacy_completion_unverified', () => {
    const r = migrateTaskCompletion({ id: 't1', status: 'DONE' });
    assert.equal(r.status, 'legacy_completion_unverified');
  });

  it('non-DONE v1 statuses never become DONE', () => {
    const r = migrateTaskCompletion({ id: 't2', status: 'IN_PROGRESS' });
    assert.equal(r.status, 'legacy_completion_unverified');
  });

  it('only complete evidence + provable scope converts, one task at a time', () => {
    const ok = migrateTaskCompletion({
      id: 't3', status: 'DONE', evidenceComplete: true, requirementScopeProvable: true,
    });
    assert.equal(ok.status, 'VERIFIED');
    const half = migrateTaskCompletion({
      id: 't4', status: 'DONE', evidenceComplete: true, requirementScopeProvable: false,
    });
    assert.equal(half.status, 'legacy_completion_unverified');
  });
});

describe('migrateMemoryText (§52.4)', () => {
  it('free-text memory arrives UNVERIFIED', () => {
    const m = migrateMemoryText('deploy on fridays is fine');
    assert.equal(m.status, 'UNVERIFIED');
    assert.equal(m.migratedFrom, 'v1.free_text');
  });
});

describe('migrateProductionApproval (§52.4)', () => {
  it('v1 auto-approval is staged, not enabled', () => {
    const r = migrateProductionApproval({ production_approval: 'auto' });
    assert.equal(r.mode, 'auto_pending_checks');
    if (r.mode === 'auto_pending_checks') {
      assert.deepEqual(r.requiredChecks, ['risk_assessment', 'reversibility_classification', 'observe_definition']);
    }
  });

  it('v1 human approval is preserved', () => {
    const r = migrateProductionApproval({ production_approval: 'human' });
    assert.equal(r.mode, 'human');
  });
});
