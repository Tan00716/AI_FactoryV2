/**
 * Tests for factory governance enforcement (spec §19).
 * Run: node --test dist/tests/governance.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@ai-factory/core';
import {
  enforcePolicy,
  GovernanceError,
  agentDepth,
  type FactoryPolicy,
} from '../src/index';

function basePolicy(): FactoryPolicy {
  return {
    maxChildren: 2,
    maxDepth: 2,
    maxConcurrentAgents: 10,
    maxTotalAgents: 10,
    maxRuntimeMs: 3_600_000,
    maxBudget: 1000,
    allowedRoles: ['engineer', 'specialist', 'lead'],
    allowedModels: ['reasoning', 'default'],
    allowedTools: ['Repository', 'Terminal'],
    allowedPermissions: ['filesystem.read', 'filesystem.write', 'shell.execute'],
  };
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    parentAgentId: null,
    jobTitle: 'Backend Engineer',
    model: 'reasoning',
    tools: ['Repository'],
    permissions: ['filesystem.read'],
    ...overrides,
  } as Parameters<typeof enforcePolicy>[1];
}

describe('enforcePolicy', () => {
  it('passes a compliant request', () => {
    const registry = new AgentRegistry();
    assert.doesNotThrow(() => enforcePolicy(registry, req(), basePolicy()));
  });

  it('denies too many children (§19 max_children)', () => {
    const registry = new AgentRegistry();
    const parent = registry.register({ name: 'lead', jobTitle: 'Tech Lead' });
    registry.register({ name: 'c1', jobTitle: 'Backend Engineer', parentAgentId: parent.id });
    registry.register({ name: 'c2', jobTitle: 'Backend Engineer', parentAgentId: parent.id });
    assert.throws(
      () => enforcePolicy(registry, req({ parentAgentId: parent.id }), basePolicy()),
      (e: unknown) =>
        e instanceof GovernanceError && e.reason === 'too-many-children',
    );
  });

  it('denies when the new agent would exceed max depth (§19 max_depth)', () => {
    const registry = new AgentRegistry();
    const root = registry.register({ name: 'pm', jobTitle: 'PM Lead' });
    const child = registry.register({
      name: 'lead',
      jobTitle: 'Tech Lead',
      parentAgentId: root.id,
    });
    // child is at depth 1; a new agent under it would be depth 2 — allowed.
    assert.doesNotThrow(() =>
      enforcePolicy(registry, req({ parentAgentId: child.id }), basePolicy()),
    );
    // Fill the policy to depth 1: grandchild under child would be depth 2 → allowed.
    const policy = { ...basePolicy(), maxDepth: 1 };
    assert.throws(
      () => enforcePolicy(registry, req({ parentAgentId: child.id }), policy),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'depth-exceeded',
    );
  });

  it('computes agent depth through the registry parent chain', () => {
    const registry = new AgentRegistry();
    const root = registry.register({ name: 'pm', jobTitle: 'PM Lead' });
    const child = registry.register({
      name: 'lead',
      jobTitle: 'Tech Lead',
      parentAgentId: root.id,
    });
    assert.equal(agentDepth(registry, root.id), 0);
    assert.equal(agentDepth(registry, child.id), 1);
    assert.equal(agentDepth(registry, null), 0);
  });

  it('denies when total agents would exceed the cap', () => {
    const registry = new AgentRegistry();
    registry.register({ name: 'a1', jobTitle: 'Backend Engineer' });
    registry.register({ name: 'a2', jobTitle: 'Backend Engineer' });
    const policy = { ...basePolicy(), maxTotalAgents: 2 };
    assert.throws(
      () => enforcePolicy(registry, req(), policy),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'total-agents-exceeded',
    );
  });

  it('denies when too many agents are concurrently active', () => {
    const registry = new AgentRegistry();
    const a = registry.register({ name: 'a1', jobTitle: 'Backend Engineer' });
    registry.setStatus(a.id, 'WORKING');
    const policy = { ...basePolicy(), maxConcurrentAgents: 1 };
    assert.throws(
      () => enforcePolicy(registry, req(), policy),
      (e: unknown) =>
        e instanceof GovernanceError && e.reason === 'too-many-concurrent-agents',
    );
  });

  it('denies a role outside the allow-list', () => {
    const registry = new AgentRegistry();
    assert.throws(
      () => enforcePolicy(registry, req({ jobTitle: 'Production Administrator' }), basePolicy()),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'role-not-allowed',
    );
  });

  it('denies a model outside the allow-list', () => {
    const registry = new AgentRegistry();
    assert.throws(
      () => enforcePolicy(registry, req({ model: 'giant-uncapped' }), basePolicy()),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'model-not-allowed',
    );
  });

  it('denies a tool outside the allow-list', () => {
    const registry = new AgentRegistry();
    assert.throws(
      () => enforcePolicy(registry, req({ tools: ['Root Shell'] }), basePolicy()),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'tool-not-allowed',
    );
  });

  it('denies a permission outside the allow-list', () => {
    const registry = new AgentRegistry();
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          req({ permissions: ['deploy.prod' as never] }),
          basePolicy(),
        ),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'permission-not-allowed',
    );
  });

  it('denies a missing parent', () => {
    const registry = new AgentRegistry();
    assert.throws(
      () => enforcePolicy(registry, req({ parentAgentId: 'nope' }), basePolicy()),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'parent-not-found',
    );
  });

  it('denies budgets beyond the limits', () => {
    const registry = new AgentRegistry();
    assert.throws(
      () => enforcePolicy(registry, req({ estimatedRuntimeMs: 99_999_999 }), basePolicy()),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'runtime-exceeds-budget',
    );
    assert.throws(
      () => enforcePolicy(registry, req({ estimatedBudget: 5_000 }), basePolicy()),
      (e: unknown) => e instanceof GovernanceError && e.reason === 'budget-exceeds-limit',
    );
  });
});
