/**
 * F58 follow-up — DATA_EXPORT → approvals authorization ticket (record-mode).
 *
 * Before a prompt is sent to a NON-LOCAL provider, the default StepFn's ACT
 * phase records a PENDING approval ticket in @ai-factory/approvals
 * (packages/runtime/src/export-approval.ts) and links it bidirectionally
 * with the DATA_EXPORT evidence event:
 *   - evidence → ticket: evidence.payload.approval_id
 *   - ticket → evidence: the ticket's APPROVAL_REQUESTED audit details
 *     carry evidence_id
 * plus an explicit DATA_EXPORT_AUTHORIZATION_RECORDED audit event.
 *
 * RECORD-MODE ONLY: the ticket is recorded, the adapter is invoked exactly
 * as before, and no UX changes. Blocking-mode gating is a product decision
 * reserved for Tan (F58).
 *
 * Run: node --test dist/tests/runner-export-approval.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalManager, InMemoryApprovalStore } from '@ai-factory/approvals';
import type { Agent, Permission, Task } from '@ai-factory/core';
import type { RouteRequest } from '@ai-factory/model-router';
import type {
  AdapterInput,
  AdapterOutput,
  AuditEvent,
  EvidenceInput,
  RuntimeAdapter,
} from '../src/index';
import {
  attachExportAuthorization,
  dataExportEventFor,
  Harness,
  runAgent,
} from '../src/index';

/** Adapter that counts invocations so the test can prove "called exactly once". */
class CountingAdapter implements RuntimeAdapter {
  readonly name = 'counting-stub';
  calls = 0;
  async invoke(_input: AdapterInput): Promise<AdapterOutput> {
    this.calls += 1;
    return { text: 'done', toolCalls: [] };
  }
}

function makeAgent(): Agent {
  return {
    id: 'agent-coder-1',
    name: 'Cody',
    displayName: 'Cody the Coder',
    jobTitle: 'AI Coder',
    department: 'engineering',
    parentAgentId: null,
    mission: 'Write correct, tested code.',
    instructions: 'Follow the loop.',
    skills: ['typescript'],
    rules: [],
    model: 'code-coder',
    reasoningLevel: 'MEDIUM',
    tools: [],
    permissions: ['filesystem.read'],
    autonomyLevel: 3,
    status: 'WORKING',
    version: 1,
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
  };
}

function makeTask(): Task {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    parentTaskId: null,
    title: 'Refactor the parser',
    goal: 'Refactor the parser for readability',
    description: '',
    priority: 'P2',
    severity: 'MAJOR',
    acceptanceCriteria: ['unit tests pass'],
    constraints: [],
    workspace: '/tmp/ai-factory-ws',
    creator: 'tan',
    status: 'IN_PROGRESS',
    currentAgentId: 'agent-coder-1',
    assignedAgentIds: ['agent-coder-1'],
    subtaskIds: [],
    dependencies: [],
    risk: 'LOW',
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
    completedAt: null,
  };
}

function makeHarness(audits: AuditEvent[], permissions: Permission[] = ['filesystem.read']) {
  return new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 2000,
    permissions,
    evidence: { collect: () => undefined },
    onAudit: (e) => audits.push(e),
  });
}

function baseRouteRequest(over: Partial<RouteRequest>): RouteRequest {
  return {
    taskType: 'coding',
    complexity: 4,
    requiredTools: [],
    latencyPref: 'low',
    costPref: 'low',
    privacy: 'public',
    needsReasoning: true,
    contextNeeded: 'large',
    needsVision: false,
    currentUsage: { usedPct: 10 },
    ...over,
  } as RouteRequest;
}

function makeExportEvent(): EvidenceInput {
  const ev = dataExportEventFor({
    provider: 'shared',
    model: 'code-coder',
    privacy: 'public',
    agentId: 'agent-coder-1',
    taskId: 'task-1',
  });
  assert.ok(ev, 'cloud provider must produce an export event');
  return ev;
}

describe('attachExportAuthorization (F58 record-mode unit)', () => {
  it('creates a PENDING data_export ticket and links it bidirectionally with the evidence', () => {
    const managerAudits: { action: string; entityId: string; details: Record<string, unknown> }[] = [];
    const manager = new ApprovalManager(new InMemoryApprovalStore(), {
      audit: (action, entityId, details) => managerAudits.push({ action, entityId, details }),
    });
    const runAudits: { action: string; detail: string }[] = [];
    const exportEvent = makeExportEvent();

    const { evidenceId, approval } = attachExportAuthorization({
      exportEvent,
      provider: 'shared',
      model: 'code-coder',
      privacy: 'public',
      agentId: 'agent-coder-1',
      taskId: 'task-1',
      approvals: manager,
      audit: (action, detail) => runAudits.push({ action, detail }),
    });

    // Ticket shape: a real approvals-package ticket, PENDING, recorded.
    assert.equal(approval.action, 'data_export');
    assert.equal(approval.status, 'PENDING');
    assert.equal(approval.task_id, 'task-1');
    assert.equal(approval.requester, 'agent:agent-coder-1');
    const stored = manager.get(approval.approval_id);
    assert.ok(stored, 'ticket must be retrievable from the approvals store');
    assert.equal(stored.status, 'PENDING');

    // Evidence → ticket half: the evidence event references the ticket.
    assert.equal(exportEvent.payload['approval_id'], approval.approval_id);
    assert.equal(exportEvent.payload['evidence_id'], evidenceId);
    assert.equal(exportEvent.payload['authorization_mode'], 'record');

    // Ticket → evidence half: the APPROVAL_REQUESTED audit carries the evidence id.
    const requested = managerAudits.find((a) => a.action === 'APPROVAL_REQUESTED');
    assert.ok(requested, 'manager must emit APPROVAL_REQUESTED');
    assert.equal(requested.entityId, approval.approval_id);
    assert.equal(requested.details['evidence_id'], evidenceId);

    // Explicit linkage audit event on the run's audit stream.
    assert.equal(runAudits.length, 1);
    assert.equal(runAudits[0].action, 'DATA_EXPORT_AUTHORIZATION_RECORDED');
    assert.ok(runAudits[0].detail.includes(approval.approval_id), 'audit names the ticket');
    assert.ok(runAudits[0].detail.includes(evidenceId), 'audit names the evidence');
    assert.ok(runAudits[0].detail.includes('NOT blocked'), 'record-mode is explicit');
  });
});

describe('runAgent ACT records the export ticket before adapter.invoke (F58 record-mode)', () => {
  it('cloud-routed call: ticket recorded + bidirectionally linked, adapter still invoked exactly once', async () => {
    const adapter = new CountingAdapter();
    const audits: AuditEvent[] = [];
    // The injected manager's audit is the caller's own wiring — mirror the
    // default wiring runAgent applies to its own manager (audit → run stream).
    const manager = new ApprovalManager(new InMemoryApprovalStore(), {
      audit: (action, entityId, details) =>
        audits.push({ t: Date.now(), action, detail: `${entityId}: ${JSON.stringify(details)}` }),
    });
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(audits),
      adapter,
      tools: {},
      // Empirically routes to shared:code-coder with the default catalog.
      routeRequest: baseRouteRequest({ privacy: 'public' }),
      exportApprovalManager: manager,
    });

    // Record-mode: nothing blocks the call.
    assert.equal(adapter.calls, 1, 'record-mode must NOT block the adapter call');

    const exports = result.evidence.filter((e) => e.type === 'data_export');
    assert.equal(exports.length, 1, 'exactly one data-export event per run');
    const approvalId = exports[0].payload['approval_id'];
    const evidenceId = exports[0].payload['evidence_id'];
    assert.ok(typeof approvalId === 'string' && approvalId.length > 0, 'evidence → ticket link');
    assert.ok(typeof evidenceId === 'string' && evidenceId.length > 0, 'evidence carries its id');
    assert.equal(exports[0].payload['authorization_mode'], 'record');

    // The ticket is a real, queryable approvals-package ticket.
    const ticket = manager.get(approvalId as string);
    assert.equal(ticket.action, 'data_export');
    assert.equal(ticket.status, 'PENDING');
    assert.equal(ticket.task_id, 'task-1');

    // Audit stream: the linkage event names both ids.
    const linkage = audits.find((a) => a.action === 'DATA_EXPORT_AUTHORIZATION_RECORDED');
    assert.ok(linkage, 'audit must carry DATA_EXPORT_AUTHORIZATION_RECORDED');
    assert.ok(linkage.detail.includes(approvalId as string));
    assert.ok(linkage.detail.includes(evidenceId as string));
    assert.ok(linkage.detail.includes('NOT blocked'));

    // Ticket → evidence half flows through the manager's audit into the run stream.
    const requested = audits.find((a) => a.action === 'APPROVAL_REQUESTED');
    assert.ok(requested, 'manager APPROVAL_REQUESTED must reach the run audit stream');
    assert.ok(requested.detail.includes(approvalId as string));
    assert.ok(requested.detail.includes(evidenceId as string));
  });

  it('unknown provider fails safe — ticket + evidence still recorded', async () => {
    const adapter = new CountingAdapter();
    const audits: AuditEvent[] = [];
    const manager = new ApprovalManager(new InMemoryApprovalStore(), {
      audit: (action, entityId, details) =>
        audits.push({ t: Date.now(), action, detail: `${entityId}: ${JSON.stringify(details)}` }),
    });
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(audits),
      adapter,
      tools: {},
      // No routeRequest: provider is unknown → fail-safe to "export".
      exportApprovalManager: manager,
    });

    assert.equal(adapter.calls, 1, 'the adapter must still be invoked exactly once');
    const exports = result.evidence.filter((e) => e.type === 'data_export');
    assert.equal(exports.length, 1, 'unknown provider must still record the export event');
    assert.equal(exports[0].payload['provider'], 'unknown');
    const approvalId = exports[0].payload['approval_id'];
    assert.ok(typeof approvalId === 'string' && approvalId.length > 0);
    assert.equal(manager.get(approvalId as string).status, 'PENDING');
    assert.ok(audits.some((a) => a.action === 'DATA_EXPORT_AUTHORIZATION_RECORDED'));
  });

  it('local-routed call: no ticket, no evidence, no linkage audit', async () => {
    const adapter = new CountingAdapter();
    const audits: AuditEvent[] = [];
    const manager = new ApprovalManager(new InMemoryApprovalStore(), {
      audit: (action, entityId, details) =>
        audits.push({ t: Date.now(), action, detail: `${entityId}: ${JSON.stringify(details)}` }),
    });
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness: makeHarness(audits),
      adapter,
      tools: {},
      // Sensitive data is refused non-local candidates by the router
      // (§26.3) — routes local.
      routeRequest: baseRouteRequest({
        privacy: 'sensitive',
        taskType: 'classification',
        complexity: 1,
        needsReasoning: false,
        contextNeeded: 'small',
      }),
      exportApprovalManager: manager,
    });

    assert.equal(adapter.calls, 1, 'the adapter must still be invoked exactly once');
    const exports = result.evidence.filter((e) => e.type === 'data_export');
    assert.equal(exports.length, 0, 'local providers are exempt — no export event');
    assert.equal(manager.list().length, 0, 'no ticket may be created for a local call');
    assert.ok(
      !audits.some((a) => a.action === 'DATA_EXPORT_AUTHORIZATION_RECORDED'),
      'no linkage audit for a local call',
    );
    assert.ok(
      !audits.some((a) => a.action === 'APPROVAL_REQUESTED'),
      'no ticket request audit for a local call',
    );
  });
});
