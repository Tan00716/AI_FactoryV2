/**
 * Tests for the full §44 capability permission engine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CAPABILITIES,
  CapabilityDecision,
  checkCapability,
} from '../src/index';

const FULL = [...ALL_CAPABILITIES];

describe('checkCapability allow/deny', () => {
  it('allows when the agent holds the capability', () => {
    const d = checkCapability({ agentPermissions: ['filesystem.read'], capability: 'filesystem.read' });
    assert.equal(d.decision, 'allow');
    assert.match(d.reason, /holds capability/);
  });

  it('denies when the agent lacks the capability', () => {
    const d = checkCapability({
      agentId: 'a1',
      agentPermissions: ['filesystem.read'],
      capability: 'shell.execute',
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /lacks capability "shell.execute"/);
  });

  it('denies an unknown capability', () => {
    const d = checkCapability({
      agentPermissions: FULL,
      capability: 'teleport.somewhere' as never,
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /unknown capability/);
  });

  it('covers every §44 capability in the full list', () => {
    const expected = [
      'filesystem.read', 'filesystem.write', 'filesystem.delete', 'shell.execute',
      'git.commit', 'git.push', 'git.merge', 'database.read', 'database.write',
      'deploy.dev', 'deploy.uat', 'deploy.prod', 'secret.read', 'secret.write',
      'agent.create', 'agent.modify', 'agent.delete', 'mcp.install',
      'skill.install', 'workflow.modify',
    ];
    for (const c of expected) {
      assert.ok((ALL_CAPABILITIES as readonly string[]).includes(c), `missing ${c}`);
    }
  });

  it('deploy.prod is default-denied even when the agent holds it', () => {
    const d = checkCapability({ agentPermissions: FULL, capability: 'deploy.prod' });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /default-denied/);
  });

  it('deploy.prod is allowed with an explicit policy grant', () => {
    const d = checkCapability({
      agentPermissions: FULL,
      capability: 'deploy.prod',
      effectivePolicy: { 'capability.deploy.prod': 'allowed' },
    });
    assert.equal(d.decision, 'allow');
  });

  it('an explicit policy deny beats a granted capability', () => {
    const d = checkCapability({
      agentPermissions: FULL,
      capability: 'shell.execute',
      effectivePolicy: { 'capability.shell.execute': 'denied' },
    });
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /policy denies/);
  });

  it('production context is denied when security.production_write=denied', () => {
    const d = checkCapability({
      agentPermissions: FULL,
      capability: 'deploy.prod',
      context: { production: true, resource: 'prod-cluster' },
      effectivePolicy: { 'security.production_write': 'denied', 'capability.deploy.prod': 'allowed' },
    });
    // The explicit capability grant wins over the production_write policy…
    assert.equal(d.decision, 'allow');
    const d2 = checkCapability({
      agentPermissions: FULL,
      capability: 'database.write',
      context: { production: true },
      effectivePolicy: { 'security.production_write': 'denied' },
    });
    assert.equal(d2.decision, 'deny');
    assert.match(d2.reason, /production writes/);
  });

  it('every deny is reported to the audit hook', () => {
    const audited: CapabilityDecision[] = [];
    const hooks = { audit: (d: CapabilityDecision) => audited.push(d) };
    checkCapability({ agentPermissions: [], capability: 'git.push' }, hooks);
    checkCapability({ agentPermissions: FULL, capability: 'deploy.prod' }, hooks);
    checkCapability({ agentPermissions: FULL, capability: 'filesystem.read' }, hooks);
    assert.equal(audited.length, 2, 'only the two denies are audited');
    assert.ok(audited.every((d) => d.decision === 'deny'));
    assert.ok(audited[0].ts, 'decision carries a timestamp');
  });
});
