/**
 * Tests for the QA org chart helpers (spec §36).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@ai-factory/core';
import { createQaSpecialist, ensureQaLead, listQaOrg } from '../src/index';

describe('ensureQaLead', () => {
  it('registers the lead once (idempotent)', () => {
    const agents = new AgentRegistry();
    const first = ensureQaLead(agents);
    const second = ensureQaLead(agents);
    assert.equal(first.name, 'qa-lead');
    assert.equal(first.jobTitle, 'QA Lead');
    assert.equal(first.department, 'QA');
    assert.equal(first.autonomyLevel, 3);
    assert.equal(second.id, first.id, 'second call returns the existing lead');
    assert.equal(
      agents.list().filter((a) => a.name === 'qa-lead').length,
      1,
      'no duplicate lead registered',
    );
  });

  it('parents the lead under the tech lead when one exists', () => {
    const agents = new AgentRegistry();
    const tech = agents.register({ name: 'tech-lead', jobTitle: 'Tech Lead' });
    const lead = ensureQaLead(agents);
    assert.equal(lead.parentAgentId, tech.id);
  });

  it('registers a top-level lead when no tech lead exists', () => {
    const lead = ensureQaLead(new AgentRegistry());
    assert.equal(lead.parentAgentId, null);
  });
});

describe('createQaSpecialist', () => {
  it('registers a specialist parented under the lead (idempotent)', () => {
    const agents = new AgentRegistry();
    const lead = ensureQaLead(agents);
    const a = createQaSpecialist(agents, 'API');
    assert.equal(a.name, 'qa-api');
    assert.equal(a.jobTitle, 'API QA');
    assert.equal(a.parentAgentId, lead.id);
    assert.ok(a.skills.length > 0);
    const again = createQaSpecialist(agents, 'API');
    assert.equal(again.id, a.id, 'returns the existing specialist');
  });

  it('auto-creates the lead when missing', () => {
    const agents = new AgentRegistry();
    const s = createQaSpecialist(agents, 'Security');
    assert.equal(s.name, 'qa-security');
    const { lead } = listQaOrg(agents);
    assert.ok(lead);
    assert.equal(s.parentAgentId, lead?.id);
  });
});

describe('listQaOrg', () => {
  it('returns the lead plus specialists sorted by name', () => {
    const agents = new AgentRegistry();
    createQaSpecialist(agents, 'E2E');
    createQaSpecialist(agents, 'Functional');
    const { lead, specialists } = listQaOrg(agents);
    assert.ok(lead);
    assert.equal(lead?.name, 'qa-lead');
    assert.deepEqual(
      specialists.map((s) => s.name),
      ['qa-e2e', 'qa-functional'],
    );
  });

  it('returns a null lead when the org is empty', () => {
    const { lead, specialists } = listQaOrg(new AgentRegistry());
    assert.equal(lead, null);
    assert.deepEqual(specialists, []);
  });
});

describe('policy-gated specialist creation (INV-08)', () => {
  const generousPolicy = () => ({
    maxChildren: 10,
    maxDepth: 5,
    maxConcurrentAgents: 10,
    maxTotalAgents: 10,
    maxRuntimeMs: 3_600_000,
    maxBudget: 1000,
    allowedRoles: ['QA'],
    allowedModels: ['default'],
    allowedTools: ['shell', 'filesystem'],
    allowedPermissions: [],
  });

  it('a permitting policy lets the automatic creation through', () => {
    const agents = new AgentRegistry();
    const s = createQaSpecialist(agents, 'API', {
      policy: generousPolicy(),
      estimatedBudget: 10,
    });
    assert.equal(s.name, 'qa-api');
    assert.equal(agents.list().length, 2, 'lead + specialist');
  });

  it('a denying policy (population cap) refuses and registers nothing', () => {
    const agents = new AgentRegistry();
    const policy = { ...generousPolicy(), maxTotalAgents: 0 };
    assert.throws(
      () => createQaSpecialist(agents, 'API', { policy }),
      (err: unknown) =>
        (err as Error).name === 'GovernanceError' &&
        /total-agents-exceeded/.test((err as Error).message),
    );
    assert.equal(agents.list().length, 0, 'denied creation registers nothing');
  });

  it('a denying policy (budget ceiling) refuses the specialist', () => {
    const agents = new AgentRegistry();
    const policy = { ...generousPolicy(), maxBudget: 5 };
    assert.throws(
      () =>
        createQaSpecialist(agents, 'Security', { policy, estimatedBudget: 500 }),
      (err: unknown) =>
        (err as Error).name === 'GovernanceError' &&
        /budget-exceeds-limit/.test((err as Error).message),
    );
    assert.equal(agents.list().length, 0, 'denied creation registers nothing');
  });

  it('an existing specialist is returned without re-checking the gate', () => {
    const agents = new AgentRegistry();
    const first = createQaSpecialist(agents, 'API', { policy: generousPolicy() });
    const denyAll = { ...generousPolicy(), maxTotalAgents: 0 };
    const second = createQaSpecialist(agents, 'API', { policy: denyAll });
    assert.equal(second.id, first.id, 'idempotent find-or-return wins over the gate');
  });

  it('the gate also covers the auto-created lead', () => {
    const agents = new AgentRegistry();
    const policy = { ...generousPolicy(), maxTotalAgents: 0 };
    assert.throws(() => ensureQaLead(agents, { policy }), /GovernanceError/);
    assert.equal(agents.list().length, 0);
  });
});
