/**
 * Real-handshake test (Batch 37): @ai-factory/mcp's StdioMcpConnector
 * against a REAL third-party MCP server over a REAL stdio process.
 *
 * This is NOT a fixture and NOT a mock. The server is
 * @modelcontextprotocol/server-filesystem (the official reference
 * filesystem server, published on the npm registry), and every byte on
 * the wire is real JSON-RPC 2.0 produced/consumed by real processes.
 *
 * Server resolution, in order:
 *  1. MCP_TEST_REAL_SERVER — path to a real MCP server entry .js file
 *     (run with process.execPath). Example:
 *       MCP_TEST_REAL_SERVER=/opt/mcp-servers/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js
 *  2. `npx -y @modelcontextprotocol/server-filesystem@1.0.0 <dir>`
 *     (needs the npm registry on first run).
 *
 * Honest skip contract: if no real server can be started in THIS
 * environment (npx missing, registry unreachable, spawn ENOENT), the
 * test SKIPS loudly instead of faking a handshake. A launch-stage
 * failure is an environment problem; a protocol-stage failure AFTER a
 * successful launch is a REAL test failure.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_PROTOCOL_VERSIONS,
  McpConnectionError,
  McpRegistry,
  StdioMcpConnector,
  performHandshake,
} from '../src/index';

const SERVER_PACKAGE = '@modelcontextprotocol/server-filesystem@1.0.0';

interface ServerSpec {
  command: string;
  args: string[];
  describe: string;
  /** true when the server comes from npx (may download on first run) */
  viaNpx: boolean;
}

function resolveServerSpec(workspaceDir: string): ServerSpec | null {
  const entry = (process.env.MCP_TEST_REAL_SERVER ?? '').trim();
  if (entry) {
    return { command: process.execPath, args: [entry, workspaceDir], describe: `MCP_TEST_REAL_SERVER=${entry}`, viaNpx: false };
  }
  // npx fallback: null only when npx itself cannot exist here is hard to
  // know cheaply; we return the spec and let launch-stage failure skip.
  return {
    command: 'npx',
    args: ['-y', SERVER_PACKAGE, workspaceDir],
    describe: `npx -y ${SERVER_PACKAGE}`,
    viaNpx: true,
  };
}


/**
 * The server never came up in this environment (npx could not fetch it,
 * spawn ENOENT, the child died before serving). That is an environment
 * problem, not a handshake problem: skip loudly instead of failing.
 * Anything AFTER a running server answers is a real assertion.
 */
function serverNeverCameUp(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  // assert.rejects wraps the real error in err.actual — unwrap it.
  const actual = (err as { actual?: unknown } | null)?.actual;
  const actualMsg = actual instanceof Error ? actual.message : '';
  return /server process exited|spawn .* ENOENT|EACCES/i.test(msg + ' ' + actualMsg);
}

function skipNoServer(t: import('node:test').TestContext, err: unknown, spec: ServerSpec): void {
  // NOTE: t.skip() marks the test skipped but does NOT throw — every
  // caller must `return` right after calling this.
  t.skip(`no real MCP server in this environment (${spec.describe}): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
}

function makeServerDef() {
  return {
    name: 'real-filesystem',
    version: '1.0.0',
    provider: 'modelcontextprotocol',
    transport: 'stdio' as const,
    tools: [],
    resources: [],
    scopes: [],
    permissions: [],
    trustLevel: 'HIGH' as const,
    approvalPolicy: 'AUTO' as const,
    source: `npm:${SERVER_PACKAGE}`,
  };
}

test('real handshake: stdio connector <-> real third-party MCP server', { timeout: 300_000 }, async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'mcp-real-handshake-'));
  writeFileSync(join(workspaceDir, 'probe.txt'), 'hello-real-mcp\n');
  const spec = resolveServerSpec(workspaceDir);
  if (!spec) {
    t.skip('no real MCP server configured (set MCP_TEST_REAL_SERVER)');
    return;
  }

  const registry = new McpRegistry();
  registry.register(makeServerDef());
  const connector = new StdioMcpConnector({
    command: spec.command,
    args: spec.args,
    // npx resolves+downloads the package on first run; give it room, env path is local and fast
    requestTimeoutMs: spec.viaNpx ? 150_000 : 30_000,
    clientInfo: { name: 'ai-factory-test', version: '0.0.0-test' },
  });
  const server = () => {
    const s = registry.get('real-filesystem', '1.0.0');
    assert.ok(s, 'server must be registered');
    return s;
  };

  // -- launch stage: failure here is environmental -> loud skip ----------
  try {
    await connector.launch(server());
  } catch (err) {
    t.skip(`real MCP server could not be launched in this environment (${spec.describe}): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // -- protocol stage -------------------------------------------------
  // If the server process died before serving (npx fetch failed, ...),
  // skip loudly; a live server that answers wrongly is a REAL failure.
  let hs;
  try {
    hs = await performHandshake(registry, connector, 'real-filesystem', '1.0.0');
  } catch (err) {
    if (serverNeverCameUp(err)) { skipNoServer(t, err, spec); return; }
    throw err;
  }
  try {
    assert.ok(
      CLIENT_PROTOCOL_VERSIONS.includes(hs.negotiatedVersion),
      `negotiated version must be one the client listed, got '${hs.negotiatedVersion}'`,
    );
    assert.ok(hs.serverInfo?.name, 'real server must report serverInfo.name');
    t.diagnostic(`handshake: server='${hs.serverInfo?.name}' version='${hs.serverInfo?.version}' protocol='${hs.negotiatedVersion}'`);

    const tools = await connector.listTools(server());
    assert.ok(tools.length > 0, 'real server must list at least one tool');
    assert.ok(tools.some((x) => x.name === 'read_text_file'), 'filesystem server must offer read_text_file');
    t.diagnostic(`tools/list -> ${tools.length} tools`);

    const read = await connector.callTool(server(), 'read_text_file', {
      path: join(workspaceDir, 'probe.txt'),
    });
    assert.equal(read.ok, true);
    const text = JSON.stringify(read.content);
    assert.ok(text.includes('hello-real-mcp'), `tool call must return real file content, got: ${text.slice(0, 120)}`);
    t.diagnostic('tools/call read_text_file returned the real probe file content');
  } finally {
    await connector.close(server());
  }
});

test('stdio connector refuses a protocol version it does not list (no fake session)', { timeout: 300_000 }, async (t) => {
  // Guards the Batch-37 lesson: before '2025-11-25' was added to
  // CLIENT_PROTOCOL_VERSIONS, the real server answered with it and the
  // connector correctly refused instead of pretending the session worked.
  const workspaceDir = mkdtempSync(join(tmpdir(), 'mcp-real-handshake-neg-'));
  const spec = resolveServerSpec(workspaceDir);
  if (!spec) {
    t.skip('no real MCP server configured (set MCP_TEST_REAL_SERVER)');
    return;
  }
  const registry = new McpRegistry();
  registry.register(makeServerDef());
  const connector = new StdioMcpConnector({
    command: spec.command,
    args: spec.args,
    requestTimeoutMs: spec.viaNpx ? 150_000 : 30_000,
  });
  const server = () => {
    const s = registry.get('real-filesystem', '1.0.0');
    assert.ok(s, 'server must be registered');
    return s;
  };
  try {
    await connector.launch(server());
  } catch (err) {
    t.skip(`real MCP server could not be launched (${spec.describe}): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // Propose ONLY a version the real server does not speak; a live server
  // answers with its own version and the connector must refuse.
  // (Server-never-came-up -> loud skip, same contract as above.)
  try {
    await assert.rejects(
      connector.initialize(server(), ['2099-01-01 fictional']),
      (err: unknown) =>
        err instanceof McpConnectionError &&
        err.failureClass === 'protocol' &&
        /not in the client's supported set/.test(err.message),
      'connector must refuse a session on an unlisted protocol version',
    );
  } catch (err) {
    if (serverNeverCameUp(err)) { skipNoServer(t, err, spec); return; }
    throw err;
  } finally {
    await connector.close(server());
  }
});
