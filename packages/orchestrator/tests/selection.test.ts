/**
 * Tests for agent selection (spec §94): scoring weights, ranking order,
 * §94 example (PostgreSQL locking bug → PostgreSQL Specialist), workload
 * and past-performance effects.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, scoreAgent, WEIGHTS } from '../src/index';
import type { Agent, Permission } from '@ai-factory/core';

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: 'agent-x',
    name: 'agent-x',
    displayName: 'Agent X',
    jobTitle: 'Engineer',
    department: 'eng',
    parentAgentId: null,
    mission: '',
    instructions: '',
    skills: [],
    rules: [],
    model: 'm',
    reasoningLevel: 'MEDIUM',
    tools: [],
    permissions: [],
    autonomyLevel: 2,
    status: 'IDLE',
    version: 1,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

const TASK = {
  requiredSkills: ['postgresql', 'locking'],
  requiredTools: ['psql'],
  requiredPermissions: ['database.read'] as Permission[],
  complexity: 4 as const,
  domainHint: 'PostgreSQL locking bug',
};

describe('selection', () => {
  it('weights sum to 100', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });

  it('ranks the best-matching specialist first (§94 example)', () => {
    const backend = agent({
      id: 'backend',
      jobTitle: 'Backend Engineer',
      skills: ['nodejs', 'rest'],
      tools: ['git'],
      permissions: ['filesystem.read', 'filesystem.write'],
      autonomyLevel: 3,
    });
    const db = agent({
      id: 'db',
      jobTitle: 'DB Specialist',
      skills: ['sql', 'indexing'],
      tools: ['psql'],
      permissions: ['database.read'],
      autonomyLevel: 3,
    });
    const pg = agent({
      id: 'pg',
      jobTitle: 'PostgreSQL Specialist',
      skills: ['postgresql', 'locking', 'mvcc'],
      tools: ['psql', 'pg_stat'],
      permissions: ['database.read', 'database.write'],
      autonomyLevel: 4,
    });
    const ranked = rankCandidates([backend, db, pg], TASK);
    assert.equal(ranked[0]!.agent.id, 'pg');
    assert.equal(ranked[1]!.agent.id, 'db');
    assert.equal(ranked[2]!.agent.id, 'backend');
  });

  it('penalizes high workload', () => {
    const fresh = agent({ id: 'fresh', skills: ['postgresql', 'locking'], tools: ['psql'], permissions: ['database.read'], autonomyLevel: 4 });
    const busy = agent({ id: 'busy', skills: ['postgresql', 'locking'], tools: ['psql'], permissions: ['database.read'], autonomyLevel: 4 });
    const ranked = rankCandidates([fresh, busy], TASK, {
      workloads: new Map([['busy', 3]]),
    });
    assert.equal(ranked[0]!.agent.id, 'fresh');
    const busyScore = ranked.find((r) => r.agent.id === 'busy')!;
    assert.equal(busyScore.breakdown.workload, 0);
  });

  it('rewards past performance', () => {
    const a = agent({ id: 'a', skills: ['postgresql'], tools: ['psql'], permissions: ['database.read'], autonomyLevel: 4 });
    const b = agent({ id: 'b', skills: ['postgresql'], tools: ['psql'], permissions: ['database.read'], autonomyLevel: 4 });
    const ranked = rankCandidates([a, b], TASK, {
      performances: [
        { agentId: 'a', successRate: 0.95 },
        { agentId: 'b', successRate: 0.4 },
      ],
    });
    assert.equal(ranked[0]!.agent.id, 'a');
  });

  it('score breakdown explains the total', () => {
    const scored = scoreAgent(
      agent({ skills: ['postgresql', 'locking'], tools: ['psql'], permissions: ['database.read'], autonomyLevel: 5 }),
      TASK,
    );
    const sum = Object.values(scored.breakdown).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(sum - scored.score) < 1e-9);
    assert.ok(scored.score > 80, 'strong match scores high');
  });

  it('excludes agents that cannot run', () => {
    const paused = agent({ id: 'paused', status: 'PAUSED', skills: ['postgresql', 'locking'] });
    const idle = agent({ id: 'idle', status: 'IDLE', skills: ['postgresql'] });
    const ranked = rankCandidates([paused, idle], TASK);
    assert.deepEqual(ranked.map((r) => r.agent.id), ['idle']);
  });

  it('empty requirements still produce a valid score', () => {
    const scored = scoreAgent(agent({}), {
      requiredSkills: [],
      requiredTools: [],
      requiredPermissions: [],
      complexity: 1,
    });
    assert.ok(scored.score >= 0 && scored.score <= 100);
  });
});
