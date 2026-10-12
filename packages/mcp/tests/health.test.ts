/**
 * Tests for §34.4 graded health: launch / protocol / tools / execution
 * are exercised in order, reported separately, and a level that cannot
 * be exercised is 'unknown' — never promoted to a pass.
 * Run: node --test dist/tests/health.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpHealthChecker, McpRegistry } from '../src/index';
import { FakeMcpConnector, errJsonRpc, errSpawnMissing, errUnreachable } from './fixtures/fake-mcp-server';

const def = {
  name: 'fs-mcp',
  version: '2.1.0',
  provider: 'Acme',
  transport: 'stdio' as const,
  tools: [{ name: 'read_file' }, { name: 'ping' }],
};

function setup(connector: FakeMcpConnector) {
  const registry = new McpRegistry();
  registry.register(def);
  return { registry, checker: new McpHealthChecker(registry, connector) };
}

describe('§34.4 graded health', () => {
  it('all four levels pass → healthy, and the report + negotiation land on the record', async () => {
    const connector = new FakeMcpConnector({
      protocolVersion: '2026-07-28',
      extensions: ['tasks'],
      tools: [{ name: 'read_file' }, { name: 'ping' }],
    });
    const { registry, checker } = setup(connector);
    const report = await checker.check('fs-mcp', '2.1.0');
    assert.equal(report.overall, 'healthy');
    assert.deepEqual(
      report.levels.map((l) => `${l.level}:${l.status}`),
      ['launch:pass', 'protocol:pass', 'tools:pass', 'execution:pass'],
    );
    assert.deepEqual(connector.calls, ['launch', 'initialize', 'listTools', 'callTool:ping', 'close']);
    const saved = registry.get('fs-mcp', '2.1.0');
    assert.equal(saved?.health?.overall, 'healthy');
    assert.equal(saved?.negotiatedVersion, '2026-07-28'); // the health handshake persists negotiation (§34.2)
    assert.deepEqual(saved?.extensionSet, ['tasks']);
  });

  it('launch failure → down at level 1, nothing deeper is claimed', async () => {
    const connector = new FakeMcpConnector({ launchError: errSpawnMissing() });
    const { checker } = setup(connector);
    const report = await checker.check('fs-mcp', '2.1.0');
    assert.equal(report.overall, 'down');
    assert.equal(report.failureClass, 'unreachable');
    assert.deepEqual(report.levels.map((l) => l.level), ['launch']);
    assert.equal(report.levels[0].status, 'fail');
  });

  it('handshake failure → launch passes, protocol fails, tools/execution are not reported as anything', async () => {
    const connector = new FakeMcpConnector({ initializeError: errJsonRpc('Unsupported protocol version') });
    const { checker } = setup(connector);
    const report = await checker.check('fs-mcp', '2.1.0');
    assert.equal(report.overall, 'down');
    assert.equal(report.failureClass, 'protocol');
    assert.deepEqual(
      report.levels.map((l) => `${l.level}:${l.status}`),
      ['launch:pass', 'protocol:fail'],
    );
  });

  it('tools/list failure → down at the tools level after two passes', async () => {
    const connector = new FakeMcpConnector({ listToolsError: errUnreachable() });
    const { checker } = setup(connector);
    const report = await checker.check('fs-mcp', '2.1.0');
    assert.equal(report.overall, 'down');
    assert.equal(report.failureClass, 'unreachable');
    assert.deepEqual(
      report.levels.map((l) => `${l.level}:${l.status}`),
      ['launch:pass', 'protocol:pass', 'tools:fail'],
    );
  });

  it('no probe tool → execution is unknown and the server is degraded, NOT healthy', async () => {
    const connector = new FakeMcpConnector({ tools: [{ name: 'read_file' }] });
    const { checker } = setup(connector);
    const report = await checker.check('fs-mcp', '2.1.0');
    const exec = report.levels.find((l) => l.level === 'execution');
    assert.equal(exec?.status, 'unknown');
    assert.equal(report.overall, 'degraded');
    assert.ok(!connector.calls.some((c) => c.startsWith('callTool')));
  });

  it('a probe tool returning an error payload → execution fails as a tool failure', async () => {
    const connector = new FakeMcpConnector({
      tools: [{ name: 'ping' }],
      callResults: { ping: { ok: false, isError: true, errorText: 'boom' } },
    });
    const { checker } = setup(connector);
    const report = await checker.check('fs-mcp', '2.1.0');
    const exec = report.levels.find((l) => l.level === 'execution');
    assert.equal(exec?.status, 'fail');
    assert.equal(exec?.failureClass, 'tool');
    assert.equal(report.overall, 'down');
  });

  it('an explicitly configured probe tool is used for the execution level', async () => {
    const connector = new FakeMcpConnector({ tools: [{ name: 'search' }] });
    const { checker } = setup(connector);
    const report = await checker.check('fs-mcp', '2.1.0', { probeTool: 'search' });
    assert.equal(report.overall, 'healthy');
    assert.ok(connector.calls.includes('callTool:search'));
  });
});
