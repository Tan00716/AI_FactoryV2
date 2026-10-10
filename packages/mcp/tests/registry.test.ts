/**
 * Tests for registry + install flow (spec §46, §73).
 * Run: node --test dist/tests/registry.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry, McpManager } from '../src/index';

function fixedClock(start = 1000) {
  let t = start;
  return { now: () => t++ };
}

const githubDef = {
  name: 'github-mcp',
  version: '1.0.0',
  provider: 'GitHub',
  transport: 'http' as const,
  tools: [{ name: 'create_issue', requiresPermissions: ['issues:write'] }],
  scopes: ['repo'],
  permissions: ['issues:write'],
};

function fresh() {
  const clock = fixedClock();
  const registry = new McpRegistry({ clock });
  const manager = new McpManager(registry, { clock });
  return { registry, manager };
}

describe('McpRegistry', () => {
  it('registers a server with trust UNKNOWN and policy BLOCKED by default', () => {
    const { registry } = fresh();
    const s = registry.register(githubDef);
    assert.equal(s.trustLevel, 'UNKNOWN');
    assert.equal(s.approvalPolicy, 'BLOCKED');
    assert.equal(s.registeredAt, 1000);
  });

  it('keeps multiple versions of the same server', () => {
    const { registry } = fresh();
    registry.register(githubDef);
    registry.register({ ...githubDef, version: '2.0.0' });
    const vs = registry.versionsOf('github-mcp');
    assert.deepEqual(vs.map((v) => v.version), ['1.0.0', '2.0.0']);
  });

  it('honours explicit trust/policy options on register', () => {
    const { registry } = fresh();
    const s = registry.register(githubDef, { trust: 'VERIFIED', policy: 'AUTO' });
    assert.equal(s.trustLevel, 'VERIFIED');
    assert.equal(s.approvalPolicy, 'AUTO');
  });
});

describe('McpManager install flow', () => {
  it('BLOCKS install of an unknown (unassessed) server by default (§73)', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef);
    const out = manager.requestInstall('github-mcp', '1.0.0');
    assert.equal(out.ok, false);
    assert.equal(out.status, 'BLOCKED');
    assert.match(out.reason ?? '', /BLOCKED/i);
    assert.equal(manager.getInstall('github-mcp', '1.0.0'), undefined);
  });

  it('BLOCKS install of a completely unregistered server', () => {
    const { manager } = fresh();
    const out = manager.requestInstall('evil-mcp', '9.9.9');
    assert.equal(out.ok, false);
    assert.equal(out.status, 'BLOCKED');
    assert.match(out.reason ?? '', /not registered/i);
  });

  it('installs immediately when policy is AUTO after trust assessment', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef);
    const a = manager.assessTrust('github-mcp', '1.0.0', {
      trustLevel: 'VERIFIED',
      approvalPolicy: 'AUTO',
      assessedBy: 'security-bot',
    });
    assert.equal(a.trustLevel, 'VERIFIED');
    const out = manager.requestInstall('github-mcp', '1.0.0');
    assert.equal(out.ok, true);
    assert.equal(out.status, 'INSTALLED');
    assert.equal(manager.getInstall('github-mcp', '1.0.0')?.installedAt, 1002); // trust assessment consumed tick 1001
  });

  it('AI_REVIEW leaves the install pending until approved', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef);
    manager.assessTrust('github-mcp', '1.0.0', { trustLevel: 'MEDIUM', approvalPolicy: 'AI_REVIEW' });
    const pending = manager.requestInstall('github-mcp', '1.0.0');
    assert.equal(pending.status, 'PENDING_REVIEW');
    assert.equal(pending.ok, false);
    const approved = manager.decideReview('github-mcp', '1.0.0', { approved: true, reviewer: 'ai-reviewer' });
    assert.equal(approved.ok, true);
    assert.equal(manager.getInstall('github-mcp', '1.0.0')?.status, 'INSTALLED');
  });

  it('HUMAN_APPROVAL denial keeps the install blocked', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef);
    manager.assessTrust('github-mcp', '1.0.0', { trustLevel: 'LOW', approvalPolicy: 'HUMAN_APPROVAL' });
    assert.equal(manager.requestInstall('github-mcp', '1.0.0').status, 'PENDING_REVIEW');
    const denied = manager.decideReview('github-mcp', '1.0.0', {
      approved: false,
      reviewer: 'ops',
      reason: 'untrusted provider',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 'BLOCKED');
  });

  it('BLOCKED policy denies install even after explicit assessment', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef);
    manager.assessTrust('github-mcp', '1.0.0', { trustLevel: 'UNKNOWN', approvalPolicy: 'BLOCKED' });
    const out = manager.requestInstall('github-mcp', '1.0.0');
    assert.equal(out.ok, false);
    assert.equal(out.status, 'BLOCKED');
  });

  it('installs two versions of the same server independently', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef, { trust: 'VERIFIED', policy: 'AUTO' });
    registry.register({ ...githubDef, version: '2.0.0' }, { trust: 'VERIFIED', policy: 'AUTO' });
    assert.equal(manager.requestInstall('github-mcp', '1.0.0').ok, true);
    assert.equal(manager.requestInstall('github-mcp', '2.0.0').ok, true);
    assert.equal(manager.installedVersions('github-mcp').length, 2);
  });

  it('uninstall removes only the specified version', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef, { trust: 'VERIFIED', policy: 'AUTO' });
    registry.register({ ...githubDef, version: '2.0.0' }, { trust: 'VERIFIED', policy: 'AUTO' });
    manager.requestInstall('github-mcp', '1.0.0');
    manager.requestInstall('github-mcp', '2.0.0');
    assert.equal(manager.uninstall('github-mcp', '1.0.0'), true);
    assert.deepEqual(
      manager.installedVersions('github-mcp').map((r) => r.version),
      ['2.0.0'],
    );
  });

  it('rejects enable/disable of a non-installed server', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef);
    assert.throws(() => manager.setEnabled('github-mcp', '1.0.0', false), /not installed/);
  });

  it('records tool usage with the exact version used', () => {
    const { registry, manager } = fresh();
    registry.register(githubDef, { trust: 'VERIFIED', policy: 'AUTO' });
    manager.requestInstall('github-mcp', '1.0.0');
    manager.recordUsage({ server: 'github-mcp', version: '1.0.0', tool: 'create_issue', agentId: 'agent-1' });
    assert.equal(manager.getInstall('github-mcp', '1.0.0')?.lastUsedVersion, '1.0.0');
    assert.equal(manager.usageLog('github-mcp').length, 1);
  });
});
