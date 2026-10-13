/**
 * Tests for the §8.2 task-scope dimension of the relative permission
 * ceiling (spec §8.2 "任务范围": 委托不能超过委托者可授予集合、
 * 任务范围和组织上限；有效权限取所有限制交集).
 *
 * Step 6 of enforcePolicy(): when request.taskScope is present, the
 * requested tools/permissions must be covered by the task scope's
 * "tool:<name>" / "permission:<name>" tokens. Denials throw
 * GovernanceError (reason 'grant-exceeds-task-scope') and emit
 * TASK_SCOPE_CEILING_DENIED to the audit sink before the throw.
 *
 * - Absolute (§19) checks keep their first position and are unchanged.
 * - Granter check (step 5) runs before the task-scope check (step 6):
 *   exceeding both reports the granter reason.
 * - Absent taskScope → the dimension is skipped, never fabricated.
 * - Domain tokens ("project:", "path:", …) never cap capability grants.
 * - requested ⊆ granter ∩ taskScope is the implemented intersection.
 *
 * Run: node --test dist/tests/task-scope-ceiling.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@ai-factory/core';
import type { Permission } from '@ai-factory/core';
import {
  enforcePolicy,
  createEmployee,
  GovernanceError,
  capabilityTokensFromScope,
  type FactoryPolicy,
  type GovernanceAuditSink,
  type TaskScopeCeilingDeniedIntent,
  type RelativeCeilingDeniedIntent,
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

function registryWithGranter(granterTools = ['Repository', 'Terminal']) {
  const registry = new AgentRegistry();
  const granter = registry.register({
    name: 'mgr',
    jobTitle: 'Manager Lead',
    tools: granterTools,
    permissions: ['filesystem.read', 'filesystem.write', 'git.commit'],
  });
  return { registry, granter };
}

function collectSink() {
  const intents: (RelativeCeilingDeniedIntent | TaskScopeCeilingDeniedIntent)[] = [];
  const sink: GovernanceAuditSink = (intent) => {
    intents.push(intent);
  };
  return { intents, sink };
}

function baseRequest(granterId: string) {
  return {
    granterAgentId: granterId,
    jobTitle: 'Backend Engineer',
    model: 'reasoning',
    tools: ['Repository'],
    permissions: ['filesystem.read'] as Permission[],
  };
}

describe('§8.2 task-scope ceiling', () => {
  it('denies tools outside the task scope (超任务范围被拒)', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            ...baseRequest(granter.id),
            tools: ['Terminal'], // granter holds it; task scope does not
            taskScope: ['tool:Repository', 'permission:filesystem.read'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (err: unknown) =>
        err instanceof GovernanceError &&
        err.reason === 'grant-exceeds-task-scope',
    );
    assert.equal(intents.length, 1);
    const intent = intents[0]!;
    assert.equal(intent.action, 'TASK_SCOPE_CEILING_DENIED');
    assert.equal(intent.actor, granter.id);
    assert.deepEqual(intent.details.exceededTools, ['Terminal']);
    assert.deepEqual(intent.details.exceededPermissions, []);
    assert.deepEqual(intent.details.taskScope, [
      'tool:Repository',
      'permission:filesystem.read',
    ]);
  });

  it('denies permissions outside the task scope', () => {
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
            permissions: ['filesystem.read', 'git.commit'],
            taskScope: ['tool:Repository', 'permission:filesystem.read'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (err: unknown) =>
        err instanceof GovernanceError &&
        err.reason === 'grant-exceeds-task-scope',
    );
    assert.equal(intents.length, 1);
    assert.deepEqual(intents[0]!.details.exceededTools, []);
    assert.deepEqual(intents[0]!.details.exceededPermissions, ['git.commit']);
  });

  it('passes when the grant is inside granter ∩ taskScope (交集内通过)', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    enforcePolicy(
      registry,
      {
        ...baseRequest(granter.id),
        taskScope: [
          'tool:Repository',
          'permission:filesystem.read',
          'project:crm',
          'path:/workspace/crm',
        ],
      },
      basePolicy(),
      { audit: sink },
    );
    assert.equal(intents.length, 0);
  });

  it('skips the check when taskScope is absent (never fabricated)', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    // No taskScope at all: tools inside the granter's set pass.
    enforcePolicy(registry, baseRequest(granter.id), basePolicy(), {
      audit: sink,
    });
    assert.equal(intents.length, 0);
  });

  it('granter check fires first when the grant exceeds both', () => {
    const { registry, granter } = registryWithGranter(['Repository']);
    const { intents, sink } = collectSink();
    // Terminal is inside the task scope but outside the granter's set.
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            granterAgentId: granter.id,
            jobTitle: 'Backend Engineer',
            model: 'reasoning',
            tools: ['Terminal'],
            permissions: ['filesystem.read'],
            taskScope: ['tool:Terminal', 'permission:filesystem.read'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (err: unknown) =>
        err instanceof GovernanceError &&
        err.reason === 'grant-exceeds-granter',
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.action, 'RELATIVE_CEILING_DENIED');
  });

  it('absolute checks keep their first position ahead of both relative dimensions', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            granterAgentId: granter.id,
            jobTitle: 'Backend Engineer',
            model: 'nope',
            tools: ['Static Analyzer'], // exceeds BOTH granter and task scope
            taskScope: ['tool:Repository'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (err: unknown) =>
        err instanceof GovernanceError && err.reason === 'model-not-allowed',
    );
    assert.equal(intents.length, 0);
  });

  it('empty taskScope grants zero tools/permissions (strict intersection)', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          { ...baseRequest(granter.id), taskScope: [] },
          basePolicy(),
          { audit: sink },
        ),
      (err: unknown) =>
        err instanceof GovernanceError &&
        err.reason === 'grant-exceeds-task-scope',
    );
    assert.equal(intents.length, 1);
  });

  it('domain tokens never cap capability grants', () => {
    const { registry, granter } = registryWithGranter();
    const { intents, sink } = collectSink();
    // A scope of only domain tokens grants no tools: still a denial.
    assert.throws(
      () =>
        enforcePolicy(
          registry,
          {
            ...baseRequest(granter.id),
            taskScope: ['project:crm', 'path:/workspace/crm', 'no-colon-token'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (err: unknown) =>
        err instanceof GovernanceError &&
        err.reason === 'grant-exceeds-task-scope',
    );
    assert.equal(intents.length, 1);
    const denied = intents[0] as TaskScopeCeilingDeniedIntent;
    assert.deepEqual(denied.details.exceededTools, ['Repository']);
    // And the inverse: capabilityTokensFromScope ignores domain tokens.
    assert.deepEqual(capabilityTokensFromScope(['project:crm', 'path:/x']), {
      tools: [],
      permissions: [],
    });
    assert.deepEqual(
      capabilityTokensFromScope([
        'tool:Repository',
        'permission:filesystem.read',
        'project:crm',
      ]),
      { tools: ['Repository'], permissions: ['filesystem.read'] },
    );
  });

  it('createEmployee wires spec.taskScope into the check', () => {
    const { registry } = registryWithGranter();
    const { intents, sink } = collectSink();
    assert.throws(
      () =>
        createEmployee(
          registry,
          'human',
          {
            jobTitle: 'Backend Engineer',
            tools: ['Terminal'],
            permissions: ['filesystem.read'],
            taskScope: ['tool:Repository', 'permission:filesystem.read'],
          },
          basePolicy(),
          { audit: sink },
        ),
      (err: unknown) =>
        err instanceof GovernanceError &&
        err.reason === 'grant-exceeds-task-scope',
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.action, 'TASK_SCOPE_CEILING_DENIED');
  });

  it('createEmployee passes without taskScope (legacy shape unchanged)', () => {
    const { registry } = registryWithGranter();
    const { intents, sink } = collectSink();
    const agent = createEmployee(
      registry,
      'human',
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
