/**
 * Tests for the dynamic AI employee factory (spec §18).
 * Run: node --test dist/tests/factory.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@ai-factory/core';
import {
  createEmployee,
  templateFor,
  type FactoryPolicy,
} from '../src/index';

function permissivePolicy(): FactoryPolicy {
  return {
    maxChildren: 10,
    maxDepth: 5,
    maxConcurrentAgents: 10,
    maxTotalAgents: 100,
    maxRuntimeMs: 3_600_000,
    maxBudget: 1000,
    allowedRoles: ['engineer', 'specialist', 'lead', 'coder', 'qa', 'reviewer'],
    allowedModels: ['reasoning', 'default', 'fast'],
    allowedTools: ['SQL Sandbox', 'Repository', 'Terminal', 'Static Analyzer'],
    allowedPermissions: [
      'filesystem.read',
      'filesystem.write',
      'shell.execute',
      'git.commit',
      'github.pull_request',
      'database.read',
      'database.write',
      'deploy.dev',
    ],
  };
}

describe('templateFor', () => {
  it('maps PostgreSQL specialty to the MVCC/transactions template (§18 example)', () => {
    const t = templateFor('PostgreSQL');
    assert.equal(t.mission, 'Investigate concurrency and transaction issues.');
    assert.deepEqual(t.skills, [
      'PostgreSQL',
      'MVCC',
      'Transactions',
      'Isolation',
      'Locks',
      'Deadlocks',
    ]);
    assert.ok(t.instructions.includes('MVCC'));
    assert.ok(t.instructions.includes('isolation'));
  });

  it('maps Security specialty to OWASP-ish review rules', () => {
    const t = templateFor('Security');
    assert.ok(t.skills.includes('OWASP Top 10'));
    assert.ok(t.rules.some((r) => r.includes('injection')));
    assert.ok(t.instructions.includes('OWASP'));
  });

  it('falls back to the generic coder template for unknown specialties', () => {
    const t = templateFor('Underwater Basket Weaving');
    assert.equal(t.mission, 'Design, implement, and verify software changes.');
    assert.ok(t.skills.includes('Debugging'));
  });

  it('matches on job title fragments when specialty is absent', () => {
    assert.ok(templateFor('Database Performance Specialist').skills.includes('MVCC'));
  });
});

describe('createEmployee', () => {
  it('creates the §18 example: PostgreSQL Concurrency Specialist under Tech Lead', () => {
    const registry = new AgentRegistry();
    const lead = registry.register({ name: 'tech-lead', jobTitle: 'Tech Lead' });
    const agent = createEmployee(
      registry,
      'tech-lead',
      {
        jobTitle: 'PostgreSQL Concurrency Specialist',
        specialty: 'PostgreSQL',
        parentId: lead.id,
      },
      permissivePolicy(),
    );
    assert.equal(agent.jobTitle, 'PostgreSQL Concurrency Specialist');
    assert.equal(agent.mission, 'Investigate concurrency and transaction issues.');
    assert.deepEqual(agent.skills, [
      'PostgreSQL',
      'MVCC',
      'Transactions',
      'Isolation',
      'Locks',
      'Deadlocks',
    ]);
    assert.deepEqual(agent.tools, ['SQL Sandbox', 'Repository', 'Terminal']);
    assert.equal(agent.parentAgentId, lead.id);
    assert.equal(agent.reasoningLevel, 'HIGH');
  });

  it('lets explicit spec fields override template generation', () => {
    const registry = new AgentRegistry();
    const agent = createEmployee(
      registry,
      'human',
      {
        jobTitle: 'PostgreSQL Concurrency Specialist',
        specialty: 'PostgreSQL',
        mission: 'Custom mission.',
        skills: ['Custom'],
      },
      permissivePolicy(),
    );
    assert.equal(agent.mission, 'Custom mission.');
    assert.deepEqual(agent.skills, ['Custom']);
    assert.equal(agent.parentAgentId, null);
  });

  it('rejects an empty job title', () => {
    const registry = new AgentRegistry();
    assert.throws(
      () => createEmployee(registry, 'human', { jobTitle: '  ' }, permissivePolicy()),
      /jobTitle is required/,
    );
  });
});
