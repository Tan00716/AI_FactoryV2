/**
 * Tests for self-modification proposal decisions (spec §59).
 * Run: node --test dist/tests/proposals.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { proposeChange, type FactoryPolicy } from '../src/index';

function policy(): FactoryPolicy {
  return {
    maxChildren: 6,
    maxDepth: 3,
    maxConcurrentAgents: 10,
    maxTotalAgents: 50,
    maxRuntimeMs: 3_600_000,
    maxBudget: 1000,
    allowedRoles: ['engineer', 'specialist', 'lead', 'coder', 'qa'],
    allowedModels: ['reasoning', 'default'],
    allowedTools: ['Repository', 'Terminal'],
    allowedPermissions: ['filesystem.read', 'filesystem.write', 'shell.execute'],
  };
}

const fixedClock = { now: () => 1_789_000_000_000 };

describe('proposeChange', () => {
  it('auto-approves an ordinary specialist creation (§59 example)', () => {
    const p = proposeChange(
      policy(),
      {
        kind: 'create',
        target: 'PostgreSQL Concurrency Specialist',
        rationale: 'Transaction isolation bug needs a specialist',
        requestedBy: 'tech-lead',
      },
      { clock: fixedClock },
    );
    assert.equal(p.status, 'auto-approved');
    assert.equal(p.decidedBy, 'policy');
    assert.equal(p.decidedAt, new Date(1_789_000_000_000).toISOString());
    assert.ok(p.id.length > 0);
  });

  it('denies creating a Production Administrator (§59 example: BLOCK)', () => {
    const p = proposeChange(
      policy(),
      {
        kind: 'create',
        target: 'Production Administrator',
        rationale: 'Need prod access',
        requestedBy: 'rogue-agent',
      },
    );
    assert.equal(p.status, 'denied');
    assert.match(p.reason, /privileged/i);
  });

  it('denies creation of admin-flavoured roles', () => {
    const p = proposeChange(
      policy(),
      { kind: 'create', target: 'Database Admin', rationale: 'x', requestedBy: 'y' },
    );
    assert.equal(p.status, 'denied');
  });

  it('denies creation requesting deploy.prod / secret permissions', () => {
    const p = proposeChange(
      policy(),
      {
        kind: 'create',
        target: 'Release Engineer',
        rationale: 'ship faster',
        requestedBy: 'devops',
        permissions: ['deploy.prod'],
      },
    );
    assert.equal(p.status, 'denied');
  });

  it('denies creation of a role outside the policy allow-list', () => {
    const p = proposeChange(
      policy(),
      { kind: 'create', target: 'Chief Happiness Officer', rationale: 'x', requestedBy: 'y' },
    );
    assert.equal(p.status, 'denied');
    assert.match(p.reason, /allowed roles/);
  });

  it('sends retirement of core roles (PM, Tech Lead) to human review', () => {
    for (const target of ['AI PM', 'Tech Lead']) {
      const p = proposeChange(
        policy(),
        { kind: 'retire', target, rationale: 'restructure', requestedBy: 'pm' },
      );
      assert.equal(p.status, 'needs-review');
      assert.match(p.reason, /human review/);
    }
  });

  it('auto-approves retirement of a non-core role', () => {
    const p = proposeChange(
      policy(),
      { kind: 'retire', target: 'Legacy QA Engineer', rationale: 'superseded', requestedBy: 'pm' },
    );
    assert.equal(p.status, 'auto-approved');
  });

  it('auto-approves ordinary modifications within policy', () => {
    const p = proposeChange(
      policy(),
      {
        kind: 'modify',
        target: 'Backend Engineer',
        rationale: 'add database skill',
        requestedBy: 'tech-lead',
      },
    );
    assert.equal(p.status, 'auto-approved');
  });

  it('denies modifications of non-allowed roles', () => {
    const p = proposeChange(
      policy(),
      { kind: 'modify', target: 'Production Administrator', rationale: 'x', requestedBy: 'y' },
    );
    assert.equal(p.status, 'denied');
  });
});
