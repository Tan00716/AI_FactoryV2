/**
 * Durability seams — §46 (Batch 21).
 *
 * The McpRegistry / McpManager stay storage-agnostic; a host that
 * wants durability attaches observers. This pins the seam contract:
 *  - the registry sink fires on register / recordNegotiation /
 *    recordHealth / appendHistory with the current record;
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
  type McpServer,
  type InstallRecord,
  type TrustAssessment,
} from '../src/index';

const DEF = {
  name: 'sink-probe',
  version: '1.0.0',
  provider: 'test',
  transport: 'stdio' as const,
};

describe('mcp durability seams (§46, Batch 21)', () => {
  it('registry sink fires on every mutation', () => {
    const seen: McpServer[] = [];
    const registry = new McpRegistry({
      sink: { onServerChanged: (s) => seen.push({ ...s }) },
    });
    registry.register(DEF);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].approvalPolicy, 'BLOCKED');
    registry.recordNegotiation('sink-probe', '1.0.0', { negotiatedVersion: '1.0' });
    // recordNegotiation → appendHistory (fires) + its own emit (fires).
    assert.ok(seen.length >= 2);
    assert.equal(seen[seen.length - 1].negotiatedVersion, '1.0');
    registry.recordHealth('sink-probe', '1.0.0', {
      server: 'sink-probe',
      version: '1.0.0',
      checkedAt: 1,
      overall: 'healthy',
      levels: [],
    });
    assert.equal(seen[seen.length - 1].health?.overall, 'healthy');
    registry.appendHistory('sink-probe', '1.0.0', { kind: 'ENABLED' });
    assert.ok(
      seen[seen.length - 1].history?.some((h) => h.kind === 'ENABLED'),
      'history append fires the sink',
    );
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
