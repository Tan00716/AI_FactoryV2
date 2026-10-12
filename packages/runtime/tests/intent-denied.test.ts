/**
 * Batch 12-4 — §28.1: StepIntent is persisted BEFORE the permission gate.
 *
 * Independent re-audit observation 1 (gap-audit/REAUDIT_BATCH_1_10.md):
 * Harness.runTool used to check permissions first and persist the intent
 * only after the gate passed, so a default-denied tool call left NO
 * intent record at all — only an audit event — while §28.1 requires the
 * intent to be persisted before execution ("先持久化 intent"). A refusal
 * is itself a fact reconciliation must see.
 *
 * Contract pinned here:
 *  - every runTool attempt persists exactly one intent, gate outcome
 *    notwithstanding;
 *  - a permission refusal commits the intent as DENIED (a decided
 *    terminal state): never EXECUTED, never left PENDING, so the startup
 *    scan (pendingIntents) never mistakes it for an interrupted run;
 *  - the denial commits via recordResult()'s single channel with the
 *    { ok:false, denied:true, reason } payload, whose hash the record
 *    carries — store implementations map that payload to DENIED;
 *  - granted/failed flows are byte-for-byte the pre-fix behavior.
 *
 * Run: node --test dist/tests/intent-denied.test.js (after tsc)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Agent, Permission, Task } from '@ai-factory/core';
import {
  AuditEvent,
  Harness,
  PermissionDenied,
  StepIntentStore,
  StubAdapter,
  isStepIntentDenial,
  runAgent,
  type HarnessOptions,
} from '../src/index';

const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

const denialHash = (reason: string) =>
  sha256Hex(JSON.stringify({ ok: false, denied: true, reason }));

function makeHarness(extra: Partial<HarnessOptions> = {}) {
  const audits: AuditEvent[] = [];
  const intentStore = new StepIntentStore();
  const harness = new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 500,
    permissions: ['filesystem.read'] as Permission[],
    evidence: { collect: () => undefined },
    onAudit: (e) => audits.push(e),
    intentStore,
    runId: 'run-denied-test',
    ...extra,
  });
  return { harness, audits, intentStore };
}

describe('StepIntentStore.recordDenied (§28.1)', () => {
  it('commits a PENDING intent as DENIED — decided, never pending, never executed', () => {
    const store = new StepIntentStore();
    const intent = store.persistIntent('run-1', 'shell', { cmd: 'rm -rf /' });
    const committed = store.recordDenied(intent.id, "Tool 'shell' denied: missing permission 'shell.execute'");
    assert.equal(committed.status, 'DENIED');
    assert.equal(committed.resultHash, denialHash("Tool 'shell' denied: missing permission 'shell.execute'"));
    // Decided terminal state: the startup scan only surfaces PENDING.
    assert.equal(store.pendingIntents('run-1').length, 0);
    assert.equal(store.pendingIntents().length, 0);
    // Still visible to reconciliation via the full listing.
    const listed = store.listIntents('run-1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'DENIED');
  });

  it('recordResult with a denial payload also lands on DENIED (the store contract)', () => {
    const store = new StepIntentStore();
    const intent = store.persistIntent('run-1', 'write', { path: 'x.ts' });
    // Even if a caller passes ok=false through the plain channel, the
    // denial marker — not the flag — decides the terminal status.
    const committed = store.recordResult(intent.id, false, {
      ok: false,
      denied: true,
      reason: 'not allowlisted',
    });
    assert.equal(committed.status, 'DENIED');
    assert.ok(isStepIntentDenial({ ok: false, denied: true, reason: 'x' }));
    assert.equal(isStepIntentDenial({ ok: false }), false);
    assert.equal(isStepIntentDenial(null), false);
  });

  it('recordDenied on an unknown intent id fails with INTENT_NOT_FOUND', () => {
    const store = new StepIntentStore();
    assert.throws(
      () => store.recordDenied('no-such-intent', 'denied'),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'INTENT_NOT_FOUND',
    );
  });
});

describe('Harness.runTool persists the intent before the permission gate (§28.1)', () => {
  it('default-deny (unknown tool): one DENIED intent, tool never invoked, denial still thrown + audited', async () => {
    const { harness, audits, intentStore } = makeHarness({
      permissions: ['shell.execute'] as Permission[],
    });
    let invoked = false;
    await assert.rejects(
      harness.runTool('launch-missiles', {}, async () => {
        invoked = true;
        return 'nope';
      }),
      (err: unknown) => err instanceof PermissionDenied,
    );
    assert.equal(invoked, false, 'a denied tool must never execute');
    const intents = intentStore.listIntents('run-denied-test');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].tool, 'launch-missiles');
    assert.equal(intents[0].status, 'DENIED');
    assert.equal(
      intents[0].resultHash,
      denialHash("Tool 'launch-missiles' denied: unknown tool — default deny"),
    );
    assert.equal(intentStore.pendingIntents().length, 0);
    assert.ok(audits.some((a) => a.action === 'permission.denied'));
  });

  it('missing permission: the intent is DENIED with the gate reason committed', async () => {
    const { harness, intentStore } = makeHarness({
      permissions: ['filesystem.read'] as Permission[],
    });
    let invoked = false;
    await assert.rejects(
      harness.runTool('shell', { cmd: 'pytest' }, async () => {
        invoked = true;
        return 'nope';
      }),
      (err: unknown) => err instanceof PermissionDenied,
    );
    assert.equal(invoked, false);
    const intents = intentStore.listIntents('run-denied-test');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, 'DENIED');
    assert.equal(
      intents[0].resultHash,
      denialHash("Tool 'shell' denied: missing permission 'shell.execute'"),
    );
  });

  it('allowlist-shaped denial: permissions granted only for allowlisted tools (the FACTORY_RUNTIME_TOOLS surface in runtime)', async () => {
    // The server builds the harness permission set from its tool
    // allowlist: a tool outside the list simply has no granted
    // permission, so in runtime the refusal IS this permission denial.
    const allowlist = ['read'];
    const granted: Permission[] = allowlist.map(
      (t) => ({ read: 'filesystem.read', write: 'filesystem.write' })[t] as Permission,
    );
    const { harness, intentStore } = makeHarness({ permissions: granted });
    let invoked = false;
    await assert.rejects(
      harness.runTool('write', { path: 'x.ts' }, async () => {
        invoked = true;
        return 'nope';
      }),
      (err: unknown) => err instanceof PermissionDenied,
    );
    assert.equal(invoked, false);
    const intents = intentStore.listIntents('run-denied-test');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].tool, 'write');
    assert.equal(intents[0].status, 'DENIED');
    // And the allowlisted tool still flows exactly as before.
    const ok = await harness.runTool('read', { path: 'x.ts' }, async () => 'content');
    assert.equal(ok, 'content');
    const after = intentStore.listIntents('run-denied-test');
    assert.equal(after.length, 2);
    assert.equal(after[1].status, 'EXECUTED');
    assert.equal(after[1].resultHash, sha256Hex(JSON.stringify({ ok: true })));
  });

  it('granted call flow is unchanged: intent EXECUTED with the plain ok commit', async () => {
    const { harness, intentStore } = makeHarness();
    const out = await harness.runTool('read', { path: 'a.txt' }, async () => 'content');
    assert.equal(out, 'content');
    const intents = intentStore.listIntents('run-denied-test');
    assert.equal(intents.length, 1);
    assert.equal(intents[0].status, 'EXECUTED');
    assert.equal(intents[0].resultHash, sha256Hex(JSON.stringify({ ok: true })));
  });

  it('without an intent store, denials behave exactly as before (no record, same throw)', async () => {
    const audits: AuditEvent[] = [];
    const harness = new Harness({
      allowedRoots: ['/tmp/ai-factory-ws'],
      stepTimeoutMs: 500,
      permissions: ['filesystem.read'] as Permission[],
      evidence: { collect: () => undefined },
      onAudit: (e) => audits.push(e),
    });
    await assert.rejects(
      harness.runTool('shell', {}, async () => 'nope'),
      (err: unknown) => err instanceof PermissionDenied,
    );
    assert.ok(audits.some((a) => a.action === 'permission.denied'));
  });
});

describe('runAgent intentSummary counts denials in their own bucket (§28.1)', () => {
  function makeAgent(): Agent {
    return {
      id: 'agent-coder-1', name: 'Cody', displayName: 'Cody', jobTitle: 'AI Coder',
      department: 'engineering', parentAgentId: null, mission: 'Write correct code.',
      instructions: 'Follow the loop.', skills: ['typescript'], rules: [],
      model: 'code-coder', reasoningLevel: 'MEDIUM', tools: ['read', 'write'],
      permissions: ['filesystem.read', 'filesystem.write'], autonomyLevel: 3,
      status: 'WORKING', version: 1,
      createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    };
  }

  function makeTask(): Task {
    return {
      id: 'task-1', projectId: 'proj-1', parentTaskId: null,
      title: 'Run the test suite', goal: 'See it pass.',
      description: '', priority: 'P2', severity: 'MAJOR',
      acceptanceCriteria: ['unit tests pass'], constraints: [],
      workspace: '/tmp/ai-factory-ws', creator: 'tan', status: 'IN_PROGRESS',
      currentAgentId: 'agent-coder-1', assignedAgentIds: ['agent-coder-1'],
      subtaskIds: [], dependencies: [], risk: 'LOW',
      createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
      completedAt: null,
    };
  }

  it('a run whose only tool call is permission-denied reports denied, not failed/executed/pending', async () => {
    const store = new StepIntentStore();
    // Harness grants read/write only — the adapter's shell call is denied.
    const harness = new Harness({
      allowedRoots: ['/tmp/ai-factory-ws'],
      stepTimeoutMs: 2000,
      permissions: ['filesystem.read', 'filesystem.write'] as Permission[],
      evidence: { collect: () => undefined },
      runId: 'run-denied-summary',
    });
    let invoked = false;
    const result = await runAgent({
      agent: makeAgent(),
      task: makeTask(),
      harness,
      adapter: new StubAdapter([
        { text: 'done', toolCalls: [{ tool: 'shell', args: { cmd: 'pytest' } }] },
      ]),
      tools: {
        shell: async () => {
          invoked = true;
          return 'ran';
        },
      },
      intentStore: store,
    });
    assert.equal(invoked, false, 'the denied shell impl must never run');
    const intents = store.listIntents('run-denied-summary');
    assert.ok(intents.length >= 1);
    assert.ok(
      intents.every((i) => i.status === 'DENIED'),
      'every recorded intent for the denied call must be DENIED',
    );
    assert.equal(result.intentSummary?.count, intents.length);
    assert.equal(result.intentSummary?.denied, intents.length);
    assert.equal(result.intentSummary?.executed, 0);
    assert.equal(result.intentSummary?.failed, 0);
    assert.equal(result.intentSummary?.pending, 0);
    assert.equal(store.pendingIntents().length, 0);
  });
});
