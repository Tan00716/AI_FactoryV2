/**
 * Durability seams — §46 (Batch 21; op protocol since Batch 25).
 *
 * The McpRegistry / McpManager stay storage-agnostic; a host that
 * wants durability attaches observers. This pins the seam contract:
 *  - the registry sink fires on register / recordNegotiation /
 *    recordHealth / appendHistory with the mutation INTENT (an op),
 *    not a post-mutation full state — Batch 25: each server process
 *    holds its own in-memory registry, so a blind full-row upsert
 *    computed from stale memory silently reverts other processes'
 *    writes (a health write reverted a trust approval). Ops let the
 *    durability layer apply each mutation atomically against the
 *    fresh row.
 *  - the manager fires onInstallChanged on install lifecycle moves
 *    (AUTO install, review decision, uninstall) and
 *    onAssessmentChanged on assessTrust;
 *  - hydrateInstall / hydrateAssessment restore state WITHOUT new
 *    history events or re-stamped clocks (hydration is learning,
 *    not re-doing);
 *  - malformed hydrate payloads are rejected loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  McpRegistry,
  McpManager,
  applyMcpServerOp,
  type McpServerOp,
  type InstallRecord,
  type TrustAssessment,
} from '../src/index';

const DEF = {
  name: 'sink-probe',
  version: '1.0.0',
  provider: 'test',
  transport: 'stdio' as const,
};

describe('mcp durability seams (§46, Batch 21; ops since Batch 25)', () => {
  it('registry sink fires ops on every mutation', () => {
    const seen: Array<{ name: string; version: string; op: McpServerOp }> = [];
    const registry = new McpRegistry({
      sink: { onServerOp: (name, version, op) => seen.push({ name, version, op }) },
    });
    registry.register(DEF);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op.kind, 'register');
    registry.recordNegotiation('sink-probe', '1.0.0', { negotiatedVersion: '1.0' });
    // recordNegotiation → setFields op + appendHistory op.
    assert.equal(seen.length, 3);
    assert.equal(seen[1].op.kind, 'setFields');
    assert.equal(seen[2].op.kind, 'appendHistory');
    // Replaying the ops onto an empty base rebuilds an equivalent
    // record. Note: ops carry intent, not snapshots — replay re-stamps
    // clock times (registeredAt / event at), so only structure is
    // compared, not timestamps.
    let rebuilt = applyMcpServerOp('sink-probe', '1.0.0', undefined, seen[0].op);
    rebuilt = applyMcpServerOp('sink-probe', '1.0.0', rebuilt, seen[1].op);
    rebuilt = applyMcpServerOp('sink-probe', '1.0.0', rebuilt, seen[2].op);
    const live = registry.get('sink-probe', '1.0.0')!;
    assert.equal(rebuilt.negotiatedVersion, '1.0');
    assert.equal(rebuilt.negotiatedVersion, live.negotiatedVersion);
    assert.deepEqual(
      rebuilt.history?.map((h) => h.kind),
      live.history?.map((h) => h.kind),
    );
    assert.deepEqual(rebuilt.extensionSet, live.extensionSet);
    registry.recordHealth('sink-probe', '1.0.0', {
      server: 'sink-probe',
      version: '1.0.0',
      checkedAt: 1,
      overall: 'healthy',
      levels: [],
    });
    assert.equal(seen[seen.length - 1].op.kind, 'setFields');
    registry.appendHistory('sink-probe', '1.0.0', { kind: 'ENABLED' });
    const last = seen[seen.length - 1];
    assert.equal(last.op.kind, 'appendHistory');
    if (last.op.kind === 'appendHistory') {
      assert.ok(last.op.events.some((e) => e.kind === 'ENABLED'), 'history append fires the sink');
    }
  });

  it('setAssessment op carries the trust/policy intent without a full state', () => {
    const seen: McpServerOp[] = [];
    const registry = new McpRegistry({
      sink: { onServerOp: (_n, _v, op) => seen.push(op) },
    });
    registry.register(DEF);
    const base = registry.get('sink-probe', '1.0.0')!;
    const next = applyMcpServerOp('sink-probe', '1.0.0', base, {
      kind: 'setAssessment',
      assessment: { trustLevel: 'HIGH', approvalPolicy: 'AUTO', assessedAt: 5 },
    });
    assert.equal(next.trustLevel, 'HIGH');
    assert.equal(next.approvalPolicy, 'AUTO');
    // The base object is untouched — the pure function returns new objects.
    assert.equal(base.trustLevel, 'UNKNOWN');
    assert.equal(seen.filter((o) => o.kind === 'setAssessment').length, 0, 'registry itself never emits setAssessment (manager observer does)');
  });

  it('ops on unknown servers fail loudly, register merges against the base', () => {
    assert.throws(
      () => applyMcpServerOp('x', '1', undefined, { kind: 'setFields', fields: {} }),
      /not registered/,
    );
    assert.throws(
      () => applyMcpServerOp('x', '1', undefined, { kind: 'appendHistory', events: [] }),
      /not registered/,
    );
    // register() against a fresh base preserves nothing (new server);
    // against an existing base it preserves trust (stale re-registration
    // must not revert another process's approval — the durability layer
    // replays this merge on the FRESH row).
    const approved = applyMcpServerOp('s', '1', undefined, {
      kind: 'register',
      def: DEF,
      opts: { trust: 'HIGH', policy: 'AUTO' },
    });
    const rere = applyMcpServerOp('s', '1', approved, { kind: 'register', def: DEF });
    assert.equal(rere.trustLevel, 'HIGH');
    assert.equal(rere.approvalPolicy, 'AUTO');
    assert.ok(rere.history?.some((h) => h.kind === 'RE_REGISTERED'));
  });

  it('no sink, no behavior change (backwards compatibility)', () => {
    const registry = new McpRegistry();
    const s = registry.register(DEF);
    assert.equal(s.approvalPolicy, 'BLOCKED');
    registry.recordHealth('sink-probe', '1.0.0', {
      server: 'sink-probe',
      version: '1.0.0',
      checkedAt: 1,
      overall: 'down',
      levels: [],
    });
    assert.equal(registry.get('sink-probe', '1.0.0')?.health?.overall, 'down');
  });

  it('manager install + assessment observers fire on lifecycle moves', () => {
    const registry = new McpRegistry();
    const installs: Array<{ install: InstallRecord | undefined; name: string; version: string }> = [];
    const assessments: TrustAssessment[] = [];
    const manager = new McpManager(registry, {
      onInstallChanged: (install, name, version) => installs.push({ install, name, version }),
      onAssessmentChanged: (a) => assessments.push(a),
    });
    registry.register(DEF);
    manager.assessTrust('sink-probe', '1.0.0', {
      trustLevel: 'HIGH',
      approvalPolicy: 'AUTO',
      assessedBy: 'human',
    });
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0].trustLevel, 'HIGH');
    const outcome = manager.requestInstall('sink-probe', '1.0.0');
    assert.equal(outcome.status, 'INSTALLED');
    assert.equal(installs.length, 1);
    assert.equal(installs[0].install?.status, 'INSTALLED');
    manager.uninstall('sink-probe', '1.0.0');
    assert.equal(installs.length, 2);
    assert.equal(installs[1].install, undefined);
  });

  it('hydrate restores state without new history or re-stamped clocks', () => {
    const registry = new McpRegistry();
    const manager = new McpManager(registry);
    registry.register(DEF);
    manager.hydrateAssessment(
      {
        trustLevel: 'VERIFIED',
        approvalPolicy: 'HUMAN_APPROVAL',
        assessedAt: 1700000001000,
        assessedBy: 'human',
        notes: 'reviewed',
      },
      'sink-probe',
      '1.0.0',
    );
    manager.hydrateInstall({
      name: 'sink-probe',
      version: '1.0.0',
      status: 'INSTALLED',
      installedAt: 1700000002000,
      scopeEnabled: {},
    });
    assert.equal(manager.getAssessment('sink-probe', '1.0.0')?.assessedAt, 1700000001000);
    assert.equal(manager.getInstall('sink-probe', '1.0.0')?.status, 'INSTALLED');
    assert.ok(
      !registry
        .get('sink-probe', '1.0.0')
        ?.history?.some((h) => h.kind === 'TRUST_ASSESSED'),
      'hydrate must not append a TRUST_ASSESSED event',
    );
    assert.throws(
      () => manager.hydrateInstall({} as InstallRecord),
      /no name\/version/,
    );
    assert.throws(
      () => manager.hydrateAssessment({} as TrustAssessment, 'x', '1'),
      /malformed/,
    );
  });
});
