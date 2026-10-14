/**
 * Batch 41 — §81 'policy-violation' emission on repeated §8.2 ceiling denials.
 *
 * What this pins:
 *  1. A single denial is the policy WORKING ("拒绝 ≠ 违规") — no emission.
 *     The emission fires on the deterministic pattern "多次被拒绝仍尝试":
 *     POLICY_DENIAL_ESCALATION_THRESHOLD (3) ceiling denials by the same
 *     granter, counted over the hash-chained audit (facts, not heuristics).
 *  2. The record is honest: detail says the attempts were DENIED and the
 *     policy held — no elevation occurred. reason 'policy-violation',
 *     severity 'critical' (from @ai-factory/autonomy's REASON_SEVERITY),
 *     recipient null (no named human accounts), requiredDeciderLevel
 *     'operator'.
 *  3. Dedup: at most one OPEN upgrade per granter; further denials while
 *     OPEN do not re-emit; after a human resolves it, the next denial at /
 *     over threshold opens a new episode.
 *  4. The emission never suppresses the denial itself: every denial is
 *     still audited and the GovernanceError → 403 path is untouched (the
 *     sink runs before the throw; this file drives recordCeilingDenial,
 *     the extracted sink body).
 *
 * Tests import the route from src (dual-mode: workforce.ts has no
 * extensionless relative VALUE imports — './context' is type-only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, InMemoryAuditStore } from '@ai-factory/core';
import { InMemoryNeedsHumanStore } from '@ai-factory/db';
import {
  POLICY_CEILING_DENIAL_ACTIONS,
  POLICY_DENIAL_ESCALATION_THRESHOLD,
  buildPolicyViolationUpgradeRecord,
  recordCeilingDenial,
} from '../src/routes/workforce.ts';
import { handleNeedsHumanRoutes } from '../src/routes/needs-human.ts';
import type { RouteContext } from '../src/routes/context.ts';
import type { CeilingDenialIntent } from '../src/routes/workforce.ts';

function makeCtx() {
  const audit = new AuditLog(new InMemoryAuditStore());
  const needsHuman = new InMemoryNeedsHumanStore();
  const ctx = {
    audit,
    fdb: { needsHuman },
  } as unknown as RouteContext;
  return { ctx, audit, needsHuman };
}

function relativeDenial(granter: string): CeilingDenialIntent {
  return {
    action: 'RELATIVE_CEILING_DENIED',
    actor: granter,
    details: {
      granterAgentId: granter,
      requestedTools: ['shell', 'git'],
      requestedPermissions: [],
      exceededTools: ['shell'],
      exceededPermissions: [],
    },
  };
}

function taskScopeDenial(granter: string): CeilingDenialIntent {
  return {
    action: 'TASK_SCOPE_CEILING_DENIED',
    actor: granter,
    details: {
      granterAgentId: granter,
      taskScope: ['tool:read'],
      requestedTools: ['shell'],
      requestedPermissions: [],
      exceededTools: ['shell'],
      exceededPermissions: [],
    },
  };
}

function openPolicyRecords(needsHuman: InMemoryNeedsHumanStore) {
  return needsHuman
    .list('open')
    .filter((r) => r.reason === 'policy-violation');
}

describe("§81 'policy-violation' on repeated ceiling denials (Batch 41)", () => {
  it('threshold is the documented value (3, stagnationLimit precedent)', () => {
    assert.equal(POLICY_DENIAL_ESCALATION_THRESHOLD, 3);
    assert.deepEqual([...POLICY_CEILING_DENIAL_ACTIONS], [
      'RELATIVE_CEILING_DENIED',
      'TASK_SCOPE_CEILING_DENIED',
    ]);
  });

  it('record shape: honest about denied attempts, no invented person', () => {
    const rec = buildPolicyViolationUpgradeRecord({
      granter: 'agent-g1',
      denialCount: 3,
      relativeCeilingDenials: 2,
      taskScopeDenials: 1,
      exceededTools: ['shell'],
      exceededPermissions: [],
    });
    assert.equal(rec.reason, 'policy-violation');
    assert.equal(rec.reasonZh, '策略违规');
    assert.equal(rec.severity, 'critical');
    assert.equal(rec.source, 'policy-denial:agent-g1');
    assert.equal(rec.recipient, null);
    assert.equal(rec.requiredDeciderLevel, 'operator');
    assert.equal(rec.status, 'open');
    const detail = JSON.parse(rec.detailJson) as Record<string, unknown>;
    assert.equal(detail['granter'], 'agent-g1');
    assert.equal(detail['denialCount'], 3);
    assert.deepEqual(detail['exceededTools'], ['shell']);
    // F19 (Batch 44): the honest narrative must survive persistence — it is
    // copied into detailJson, not only the transient autonomy record.
    assert.match(
      String(detail['narrative']),
      /The policy held on every attempt — no elevation occurred/,
    );
    const context = JSON.parse(rec.contextJson) as Record<string, string>;
    assert.equal(context['denialCount'], '3');
    // The human-readable detail (in the autonomy record) must say the
    // policy HELD — never claim a breach occurred.
  });

  it('F19: GET /api/needs-human returns the persisted narrative (read path)', async () => {
    const { ctx, needsHuman } = makeCtx();
    const rec = buildPolicyViolationUpgradeRecord({
      granter: 'agent-g1',
      denialCount: 3,
      relativeCeilingDenials: 2,
      taskScopeDenials: 1,
      exceededTools: ['shell'],
      exceededPermissions: [],
    });
    needsHuman.submit(rec);
    let status = 0;
    let body: unknown = null;
    const readCtx = {
      ...ctx,
      json: (_res: unknown, s: number, b: unknown) => {
        status = s;
        body = b;
      },
    } as unknown as RouteContext;
    const handled = await handleNeedsHumanRoutes(
      { method: 'GET' } as never,
      {} as never,
      new URL('http://localhost/api/needs-human'),
      readCtx,
    );
    assert.equal(handled, true);
    assert.equal(status, 200);
    const items = (body as { items: Array<{ detailJson: string }> }).items;
    assert.equal(items.length, 1);
    const detail = JSON.parse(items[0]!.detailJson) as Record<string, unknown>;
    assert.match(
      String(detail['narrative']),
      /The policy held on every attempt — no elevation occurred/,
    );
  });

  it('below threshold: denials audited, no emission', () => {
    const { ctx, audit, needsHuman } = makeCtx();
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    assert.equal(openPolicyRecords(needsHuman).length, 0);
    assert.equal(
      audit.countByActorAction('agent-g1', [
        'RELATIVE_CEILING_DENIED',
      ]),
      2,
    );
  });

  it('at threshold: exactly one OPEN upgrade, NEEDS_HUMAN_RAISED audited', () => {
    const { ctx, audit, needsHuman } = makeCtx();
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    const open = openPolicyRecords(needsHuman);
    assert.equal(open.length, 1);
    assert.equal(open[0].source, 'policy-denial:agent-g1');
    const detail = JSON.parse(open[0].detailJson) as Record<string, unknown>;
    assert.equal(detail['denialCount'], 3);
    const raised = audit
      .list()
      .filter((r) => r.action === 'NEEDS_HUMAN_RAISED');
    assert.equal(raised.length, 1);
  });

  it('dedup: further denials while OPEN do not re-emit', () => {
    const { ctx, needsHuman } = makeCtx();
    for (let i = 0; i < 5; i++) {
      recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    }
    assert.equal(openPolicyRecords(needsHuman).length, 1);
    assert.equal(needsHuman.list().length, 1);
  });

  it('after human resolve: next denial opens a new episode', () => {
    const { ctx, needsHuman } = makeCtx();
    for (let i = 0; i < 3; i++) recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    const first = openPolicyRecords(needsHuman)[0];
    assert.ok(
      needsHuman.resolve(first.id, 'resolved', 'human:op', 'grant fixed', Date.now()),
    );
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    const open = openPolicyRecords(needsHuman);
    assert.equal(open.length, 1);
    assert.notEqual(open[0].id, first.id);
    assert.equal(needsHuman.list().length, 2);
  });

  it('counting is per granter', () => {
    const { ctx, needsHuman } = makeCtx();
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    recordCeilingDenial(ctx, relativeDenial('agent-g2'));
    recordCeilingDenial(ctx, relativeDenial('agent-g2'));
    assert.equal(openPolicyRecords(needsHuman).length, 0);
    recordCeilingDenial(ctx, relativeDenial('agent-g2'));
    const open = openPolicyRecords(needsHuman);
    assert.equal(open.length, 1);
    assert.equal(open[0].source, 'policy-denial:agent-g2');
  });

  it('both ceiling kinds count toward the same pattern', () => {
    const { ctx, needsHuman } = makeCtx();
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    recordCeilingDenial(ctx, taskScopeDenial('agent-g1'));
    assert.equal(openPolicyRecords(needsHuman).length, 0);
    recordCeilingDenial(ctx, taskScopeDenial('agent-g1'));
    const open = openPolicyRecords(needsHuman);
    assert.equal(open.length, 1);
    const detail = JSON.parse(open[0].detailJson) as Record<string, unknown>;
    assert.equal(detail['denialCount'], 3);
    assert.equal(detail['relativeCeilingDenials'], 1);
    assert.equal(detail['taskScopeDenials'], 2);
  });

  it('write-through failure audits NEEDS_HUMAN_PERSIST_FAILED and never throws', () => {
    const { ctx, audit } = makeCtx();
    // Break the needs-human store: duplicate-id submit always throws.
    const broken = {
      submit: () => {
        throw new Error('db is down');
      },
      list: () => [],
    };
    (ctx.fdb as unknown as { needsHuman: unknown }).needsHuman = broken;
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    // Must not throw even though the 3rd denial tries to emit.
    recordCeilingDenial(ctx, relativeDenial('agent-g1'));
    const failed = audit
      .list()
      .filter((r) => r.action === 'NEEDS_HUMAN_PERSIST_FAILED');
    assert.equal(failed.length, 1);
    // The denial itself was still recorded (3 denials in the chain).
    assert.equal(
      audit.countByActorAction('agent-g1', [...POLICY_CEILING_DENIAL_ACTIONS]),
      3,
    );
  });
});
