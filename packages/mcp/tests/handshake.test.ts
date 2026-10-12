/**
 * Tests for §34.2 (handshake → negotiated version/extension persistence,
 * stale-binding detection) and §34.1 (server metadata + append-only
 * install/activate history).
 * Run: node --test dist/tests/handshake.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  McpConnectionError,
  McpManager,
  McpRegistry,
  performHandshake,
} from '../src/index';
import { FakeMcpConnector, errJsonRpc, errSpawnMissing } from './fixtures/fake-mcp-server';

const def = {
  name: 'fs-mcp',
  version: '2.1.0',
  provider: 'Acme',
  transport: 'stdio' as const,
  tools: [{ name: 'read_file' }, { name: 'ping' }],
};

describe('§34.2 handshake', () => {
  it('performHandshake persists the negotiated version + extension set on the record', async () => {
    const registry = new McpRegistry({ clock: { now: () => 5000 } });
    registry.register(def);
    const connector = new FakeMcpConnector({
      protocolVersion: '2026-07-28',
      extensions: ['tasks', 'elicitation'],
    });
    const result = await performHandshake(registry, connector, 'fs-mcp', '2.1.0');
    assert.equal(result.negotiatedVersion, '2026-07-28');
    assert.deepEqual(result.extensionSet, ['tasks', 'elicitation']);
    assert.equal(result.bindingStale, false);
    const saved = registry.get('fs-mcp', '2.1.0');
    assert.equal(saved?.negotiatedVersion, '2026-07-28');
    assert.deepEqual(saved?.extensionSet, ['tasks', 'elicitation']);
    assert.deepEqual(connector.calls, ['launch', 'initialize']);
    // the negotiation itself is part of the recorded history
    assert.ok(saved?.history?.some((h) => h.kind === 'NEGOTIATED' && h.detail === '2026-07-28'));
  });

  it('a launch failure is classified unreachable and persists nothing', async () => {
    const registry = new McpRegistry();
    registry.register(def);
    const connector = new FakeMcpConnector({ launchError: errSpawnMissing() });
    await assert.rejects(
      () => performHandshake(registry, connector, 'fs-mcp', '2.1.0'),
      (err: unknown) => {
        assert.ok(err instanceof McpConnectionError);
        assert.equal(err.failureClass, 'unreachable');
        assert.equal(err.stage, 'launch');
        return true;
      },
    );
    assert.equal(registry.get('fs-mcp', '2.1.0')?.negotiatedVersion, undefined);
  });

  it('an initialize JSON-RPC failure is classified protocol', async () => {
    const registry = new McpRegistry();
    registry.register(def);
    const connector = new FakeMcpConnector({ initializeError: errJsonRpc() });
    await assert.rejects(
      () => performHandshake(registry, connector, 'fs-mcp', '2.1.0'),
      (err: unknown) => {
        assert.ok(err instanceof McpConnectionError);
        assert.equal(err.failureClass, 'protocol');
        assert.equal(err.stage, 'protocol');
        return true;
      },
    );
    assert.equal(registry.get('fs-mcp', '2.1.0')?.negotiatedVersion, undefined);
  });

  it('a changed tool set in the handshake flags the binding stale without overwriting it (§34.2)', async () => {
    const registry = new McpRegistry();
    registry.register(def);
    const connector = new FakeMcpConnector({
      handshakeTools: [{ name: 'read_file' }, { name: 'delete_file' }],
    });
    const result = await performHandshake(registry, connector, 'fs-mcp', '2.1.0');
    assert.equal(result.bindingStale, true);
    assert.match(result.staleDetail ?? '', /delete_file/);
    assert.match(result.staleDetail ?? '', /ping/);
    // registered binding is untouched — it goes to a compatibility check, not a silent rewrite
    assert.deepEqual(
      registry.get('fs-mcp', '2.1.0')?.tools.map((t) => t.name),
      ['read_file', 'ping'],
    );
  });

  it('recordNegotiation on an unregistered server throws', () => {
    const registry = new McpRegistry();
    assert.throws(
      () => registry.recordNegotiation('nope', '1.0.0', { negotiatedVersion: '2026-07-28' }),
      /not registered/,
    );
  });
});

describe('§34.1 server metadata', () => {
  it('register carries source/package hash/protocol versions/prompts/credential refs/network targets', () => {
    const registry = new McpRegistry();
    const s = registry.register({
      ...def,
      source: 'npm:@acme/fs-mcp',
      packageHash: 'sha256:abc123',
      protocolVersions: ['2026-07-28', '2025-06-18'],
      prompts: [{ name: 'summarize', arguments: [{ name: 'path', required: true }] }],
      credentialRefs: ['vault:fs-mcp-token'],
      networkTargets: ['localhost'],
    });
    assert.equal(s.source, 'npm:@acme/fs-mcp');
    assert.equal(s.packageHash, 'sha256:abc123');
    assert.deepEqual(s.protocolVersions, ['2026-07-28', '2025-06-18']);
    assert.equal(s.prompts?.[0].name, 'summarize');
    assert.deepEqual(s.credentialRefs, ['vault:fs-mcp-token']);
    assert.deepEqual(s.networkTargets, ['localhost']);
  });

  it('a metadata-refresh re-registration preserves omitted §34.1 fields and updates supplied ones', () => {
    const registry = new McpRegistry();
    registry.register({ ...def, source: 'npm:@acme/fs-mcp', packageHash: 'sha256:old' });
    const s2 = registry.register({ ...def, packageHash: 'sha256:new' });
    assert.equal(s2.source, 'npm:@acme/fs-mcp');
    assert.equal(s2.packageHash, 'sha256:new');
  });
});

describe('§34.1 install/activate history (append-only)', () => {
  it('records the full lifecycle in order and survives uninstall', () => {
    const registry = new McpRegistry();
    const manager = new McpManager(registry);
    registry.register(def);
    manager.assessTrust('fs-mcp', '2.1.0', { trustLevel: 'HIGH', approvalPolicy: 'AUTO', assessedBy: 'sec' });
    manager.requestInstall('fs-mcp', '2.1.0');
    manager.setEnabled('fs-mcp', '2.1.0', false, { kind: 'agent', id: 'a1' });
    manager.setEnabled('fs-mcp', '2.1.0', true, { kind: 'agent', id: 'a1' });
    manager.uninstall('fs-mcp', '2.1.0');
    const kinds = registry.get('fs-mcp', '2.1.0')?.history?.map((h) => h.kind);
    assert.deepEqual(kinds, [
      'REGISTERED',
      'TRUST_ASSESSED',
      'INSTALL_REQUESTED',
      'INSTALLED',
      'DISABLED',
      'ENABLED',
      'UNINSTALLED',
    ]);
  });

  it('records pending and blocked install attempts too', () => {
    const registry = new McpRegistry();
    const manager = new McpManager(registry);
    registry.register(def);
    manager.requestInstall('fs-mcp', '2.1.0'); // BLOCKED by default policy
    manager.assessTrust('fs-mcp', '2.1.0', { trustLevel: 'MEDIUM', approvalPolicy: 'HUMAN_APPROVAL' });
    manager.requestInstall('fs-mcp', '2.1.0'); // pending
    manager.decideReview('fs-mcp', '2.1.0', { approved: false, reviewer: 'ops', reason: 'no' });
    const kinds = registry.get('fs-mcp', '2.1.0')?.history?.map((h) => h.kind);
    assert.deepEqual(kinds, [
      'REGISTERED',
      'INSTALL_REQUESTED',
      'INSTALL_BLOCKED',
      'TRUST_ASSESSED',
      'INSTALL_REQUESTED',
      'INSTALL_PENDING',
      'INSTALL_BLOCKED',
    ]);
  });
});
