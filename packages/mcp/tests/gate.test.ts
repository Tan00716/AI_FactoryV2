/**
 * Tests for the tool-call gate (spec §46, §73).
 * Run: node --test dist/tests/gate.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry, McpManager, ToolCallGate } from '../src/index';

function fixedClock(start = 1000) {
  let t = start;
  return { now: () => t++ };
}

function installedGate() {
  const clock = fixedClock();
  const registry = new McpRegistry({ clock });
  const manager = new McpManager(registry, { clock });
  const gate = new ToolCallGate({ registry, manager });
  registry.register(
    {
      name: 'github-mcp',
      version: '1.0.0',
      provider: 'GitHub',
      transport: 'http',
      tools: [
        { name: 'create_issue', requiresPermissions: ['issues:write'] },
        { name: 'list_repos' },
      ],
      scopes: ['repo'],
      permissions: ['issues:write'],
    },
    { trust: 'VERIFIED', policy: 'AUTO' },
  );
  manager.requestInstall('github-mcp', '1.0.0');
  return { registry, manager, gate };
}

describe('ToolCallGate', () => {
  it('allows a tool call on an installed+enabled server', () => {
    const { gate } = installedGate();
    const v = gate.checkCall({ server: 'github-mcp', tool: 'create_issue', agentId: 'agent-1', taskId: 'task-7' });
    assert.equal(v.allowed, true);
    assert.equal(v.usedVersion, '1.0.0');
  });

  it('denies a call to an unregistered server (unknown = BLOCK)', () => {
    const { gate } = installedGate();
    const v = gate.checkCall({ server: 'nope-mcp', tool: 'x' });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /not registered/);
  });

  it('denies a call to a registered but uninstalled server', () => {
    const { registry, gate } = installedGate();
    registry.register({
      name: 'db-mcp',
      version: '1.0.0',
      provider: 'Acme',
      transport: 'stdio',
      tools: [{ name: 'query' }],
    });
    const v = gate.checkCall({ server: 'db-mcp', tool: 'query' });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /not installed/);
  });

  it('denies a call for an uninstalled version of an installed server', () => {
    const { registry, gate } = installedGate();
    registry.register({
      name: 'github-mcp',
      version: '2.0.0',
      provider: 'GitHub',
      transport: 'http',
      tools: [{ name: 'create_issue' }],
    });
    const v = gate.checkCall({ server: 'github-mcp', version: '2.0.0', tool: 'create_issue' });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /not installed/);
  });

  it('denies a call for a tool the server does not provide', () => {
    const { gate } = installedGate();
    const v = gate.checkCall({ server: 'github-mcp', tool: 'delete_everything' });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /not provided/);
  });

  it('denies a call when required permissions are missing, naming them', () => {
    const { registry, manager, gate } = installedGate();
    registry.register(
      {
        name: 'fs-mcp',
        version: '1.0.0',
        provider: 'Local',
        transport: 'stdio',
        tools: [{ name: 'read_file', requiresPermissions: ['fs:read'] }],
        permissions: [],
      },
      { trust: 'MEDIUM', policy: 'AUTO' },
    );
    manager.requestInstall('fs-mcp', '1.0.0');
    const v = gate.checkCall({ server: 'fs-mcp', tool: 'read_file' });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /fs:read/);
  });

  it('denies a call after the install is disabled for the agent scope', () => {
    const { manager, gate } = installedGate();
    manager.setEnabled('github-mcp', '1.0.0', false, { kind: 'agent', id: 'agent-1' });
    const v = gate.checkCall({ server: 'github-mcp', tool: 'create_issue', agentId: 'agent-1' });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /disabled/);
  });

  it('keeps the call working for other agents when one agent is disabled', () => {
    const { manager, gate } = installedGate();
    manager.setEnabled('github-mcp', '1.0.0', false, { kind: 'agent', id: 'agent-1' });
    const v = gate.checkCall({ server: 'github-mcp', tool: 'create_issue', agentId: 'agent-2' });
    assert.equal(v.allowed, true);
  });

  it('denies a call after global disable; allows again after re-enable', () => {
    const { manager, gate } = installedGate();
    manager.setEnabled('github-mcp', '1.0.0', false);
    assert.equal(gate.checkCall({ server: 'github-mcp', tool: 'list_repos' }).allowed, false);
    manager.setEnabled('github-mcp', '1.0.0', true);
    assert.equal(gate.checkCall({ server: 'github-mcp', tool: 'list_repos' }).allowed, true);
  });

  it('denies a call after uninstall', () => {
    const { manager, gate } = installedGate();
    manager.uninstall('github-mcp', '1.0.0');
    const v = gate.checkCall({ server: 'github-mcp', tool: 'list_repos' });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /not installed/);
  });

  it('routes a version-less call to the newest installed version and logs usage', () => {
    const { registry, manager, gate } = installedGate();
    registry.register(
      {
        name: 'github-mcp',
        version: '2.0.0',
        provider: 'GitHub',
        transport: 'http',
        tools: [{ name: 'create_issue' }],
        permissions: ['issues:write'],
      },
      { trust: 'VERIFIED', policy: 'AUTO' },
    );
    manager.requestInstall('github-mcp', '2.0.0');
    const v = gate.checkCall({ server: 'github-mcp', tool: 'create_issue' });
    assert.equal(v.allowed, true);
    assert.equal(v.usedVersion, '2.0.0');
    const log = manager.usageLog('github-mcp');
    assert.equal(log[log.length - 1].version, '2.0.0');
  });

  it('honours a task-scope disable', () => {
    const { manager, gate } = installedGate();
    manager.setEnabled('github-mcp', '1.0.0', false, { kind: 'task', id: 'task-7' });
    assert.equal(gate.checkCall({ server: 'github-mcp', tool: 'list_repos', taskId: 'task-7' }).allowed, false);
    assert.equal(gate.checkCall({ server: 'github-mcp', tool: 'list_repos', taskId: 'task-9' }).allowed, true);
  });

  it('honours a project-scope disable', () => {
    const { manager, gate } = installedGate();
    manager.setEnabled('github-mcp', '1.0.0', false, { kind: 'project', id: 'proj-a' });
    assert.equal(
      gate.checkCall({ server: 'github-mcp', tool: 'list_repos', scopes: [{ kind: 'project', id: 'proj-a' }] }).allowed,
      false,
    );
  });
});
