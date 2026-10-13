/**
 * Tests for the §8.2 relative permission ceiling (spec §5 / §8.2).
 *
 * enforcePolicy() enforces absolute ceilings (§19: allow-lists, counts,
 * budgets). On top of that, a grant may not exceed the delegator's own
 * grantable set: requested tools/permissions must be a subset of the
 * granter agent's tools/permissions. Denials throw GovernanceError
 * (reason 'grant-exceeds-granter') and emit RELATIVE_CEILING_DENIED to
 * the audit sink before the throw.
 *
 * Run: node --test dist/tests/relative-ceiling.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@ai-factory/core';
import {
  enforcePolicy,
  createEmployee,
  GovernanceError,
  type FactoryPolicy,
  type RelativeCeilingDeniedIntent,
  type TaskScopeCeilingDeniedIntent,
} from '../src/index';

function basePolicy(): FactoryPolicy {
  return {
    maxChildren: 10,
    maxDepth: 5,
    maxConcurrentAgents: 10,
    maxTotalAgents: 100,
    maxRuntimeMs: 3_600_000,
    maxBudget: 1000,
    allowedRoles: ['engineer', 'specialist', 'lead'],
    allowedModels: ['reasoning', 'default'],
    allowedTools: ['Repository', 'Terminal', 'Static Analyzer'],
    allowedPermissions: [
      'filesystem.read',
      'filesystem.write',
      'shell.execute',
      'git.commit',
    ],
  };
}

/** A granter holding only Repository + filesystem.read. */
function registryWithGranter() {
  const registry = new AgentRegistry();
  const granter = registry.register({
    name: 'mgr',
    jobTitle: 'Manager Lead',
    tools: ['Repository'],
    permissions: ['filesystem.read'],
  });
  return { registry, granter };
}

function collectSink() {
  const intents: RelativeCeilingDeniedIntent[] = [];
  return {
    intents,
    sink: (intent: RelativeCeilingDeniedIntent | TaskScopeCeilingDeniedIntent) => {
      if (intent.action === 'RELATIVE_CEILING_DENIED') intents.push(intent);
    },
  };
}

describe('§8.2 relative ceiling', () => {
  it('denies tools the granter does not hold (越级授权被拒)', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            granterAgentId: granter.id,
            jobTitle: 'Backend Engineer',
            model: 'reasoning',
            tools: ['Terminal'], // granter only has Repository
            permissions: ['filesystem.read'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (e: unknown) =>
        e instanceof GovernanceError && e.reason === 'grant-exceeds-granter',
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0].action, 'RELATIVE_CEILING_DENIED');
    assert.equal(intents[0].actor, granter.id);
    assert.deepEqual(intents[0].details.exceededTools, ['Terminal']);
    assert.deepEqual(intents[0].details.exceededPermissions, []);
  });

  it('denies permissions the granter does not hold', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            granterAgentId: granter.id,
            jobTitle: 'Backend Engineer',
            model: 'reasoning',
            tools: ['Repository'],
            permissions: ['shell.execute'], // granter only has filesystem.read
          },
          basePolicy(),
          { audit: sink },
        ),
      (e: unknown) =>
        e instanceof GovernanceError && e.reason === 'grant-exceeds-granter',
    );
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0].details.exceededTools, []);
    assert.deepEqual(intents[0].details.exceededPermissions, ['shell.execute']);
  });

  it('allows equal and lower grants (平级/降级通过)', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    // Equal: exactly the granter's set.
    assert.doesNotThrow(() =>
      enforcePolicy(
        registry,
        {
          granterAgentId: granter.id,
          jobTitle: 'Backend Engineer',
          model: 'reasoning',
          tools: ['Repository'],
          permissions: ['filesystem.read'],
        },
        basePolicy(),
        { audit: sink },
      ),
    );
    // Lower: a strict subset (and empty grants).
    assert.doesNotThrow(() =>
      enforcePolicy(
        registry,
        {
          granterAgentId: granter.id,
          jobTitle: 'Backend Engineer',
          model: 'reasoning',
          tools: [],
          permissions: [],
        },
        basePolicy(),
        { audit: sink },
      ),
    );
    assert.equal(intents.length, 0);
  });

  it('skips the relative check when the granter is not a registry agent', () => {
    const { registry } = registryWithGranter();
    const { intents, sink } = collectSink();
    // 'human' is not an agent in the registry: no recorded grantable
    // set exists, so the check is skipped rather than fabricated.
    assert.doesNotThrow(() =>
      enforcePolicy(
        registry,
        {
          granterAgentId: 'human',
          jobTitle: 'Backend Engineer',
          model: 'reasoning',
          tools: ['Terminal', 'Static Analyzer'],
          permissions: ['shell.execute'],
        },
        basePolicy(),
        { audit: sink },
      ),
    );
    assert.equal(intents.length, 0);
    // The absolute (§19) checks still apply for an unknown granter.
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            granterAgentId: 'human',
            jobTitle: 'Backend Engineer',
            model: 'reasoning',
            tools: ['Root Shell'], // not in the policy allow-list
            permissions: ['shell.execute'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (e: unknown) =>
        e instanceof GovernanceError && e.reason === 'tool-not-allowed',
    );
    assert.equal(intents.length, 0);
  });

  it('is absent when no granterAgentId is given (pre-existing behavior)', () => {
    const { registry } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.doesNotThrow(() =>
      enforcePolicy(
        registry,
        {
          jobTitle: 'Backend Engineer',
          model: 'reasoning',
          tools: ['Terminal'],
          permissions: ['shell.execute'],
        },
        basePolicy(),
        { audit: sink },
      ),
    );
    assert.equal(intents.length, 0);
  });

  it('keeps the absolute allow-list check ahead of the relative one', () => {
    const { registry, granter } = registryWithGranter();
    // Tool is inside the granter's set but outside the policy: the
    // absolute (§19) denial fires first, no relative audit.
    const { intents, sink } = collectSink();
    const wideGranter = registry.register({
      name: 'wide',
      jobTitle: 'Manager Lead',
      tools: ['Repository', 'Root Shell'],
      permissions: ['filesystem.read'],
    });
    void granter;
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            granterAgentId: wideGranter.id,
            jobTitle: 'Backend Engineer',
            model: 'reasoning',
            tools: ['Root Shell'],
            permissions: ['filesystem.read'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (e: unknown) =>
        e instanceof GovernanceError && e.reason === 'tool-not-allowed',
    );
    assert.equal(intents.length, 0);
  });
});

describe('createEmployee wires requestedBy as the granter', () => {
  it('denies an over-grant requested by an agent', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.throws(
      () =>
        createEmployee(
          registry,
          granter.id, // requestedBy = the delegating agent
          {
            jobTitle: 'Backend Engineer',
            tools: ['Terminal'], // granter lacks it
            permissions: ['filesystem.read'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (e: unknown) =>
        e instanceof GovernanceError && e.reason === 'grant-exceeds-granter',
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0].action, 'RELATIVE_CEILING_DENIED');
  });

  it('creates when requested by a human (no relative ceiling to compare)', () => {
    const { registry } = registryWithGranter();
    const { intents, sink } = collectSink();
    const agent = createEmployee(
      registry,
      'human',
      {
        jobTitle: 'Backend Engineer',
        tools: ['Terminal'],
        permissions: ['shell.execute'],
      },
      basePolicy(),
      { audit: sink },
    );
    assert.ok(agent.id);
    assert.deepEqual(agent.tools, ['Terminal']);
    assert.equal(intents.length, 0);
  });

  it('creates when the grant is within the granter set', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    const agent = createEmployee(
      registry,
      granter.id,
      {
        jobTitle: 'Backend Engineer',
        tools: ['Repository'],
        permissions: ['filesystem.read'],
      },
      basePolicy(),
      { audit: sink },
    );
    assert.ok(agent.id);
    assert.equal(intents.length, 0);
  });
});
