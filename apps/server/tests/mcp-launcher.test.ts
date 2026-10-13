/**
 * MCP stdio launch with secret injection — Batch 19 (§46.2), server layer.
 *
 * McpServerLauncher is exercised directly (unit level) with a real
 * SecretBroker over a memory store, spawning real `node -e` children:
 *
 *  - declared credentialRefs resolve through broker LEASES and land in
 *    the child env; the child prints the value's length so the test can
 *    prove arrival without the value appearing anywhere in the log
 *    (logs are redacted at capture time — the sentinel never appears);
 *  - fail-closed preconditions: uninstalled server, non-stdio transport,
 *    missing ref, ref not declared on credentialRefs — each refuses
 *    with a machine-readable code and spawns nothing;
 *  - rotation: broker.set() revokes the launch's leases; the launch
 *    reports leasesLive=false (secretLeaseState='revoked') while the
 *    already-running child keeps its copied env (the honest OS
 *    reality); a NEW launch resolves the rotated value.
 *
 * The HTTP surface (/api/mcp/launch) is covered for RBAC
 * classification only (requiredRoleFor) — the full HTTP install flow
 * cannot reach INSTALLED for a freshly registered server (default
 * approval policy is BLOCKED with no HTTP trust-assessment surface;
 * that is a pre-existing §46 gap, not something this batch invents).
 * Imports mcp-launcher.ts from src; @ai-factory/* resolve to dist, so
 * this test runs after the package build like the other src tests.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySecretStore, SecretBroker } from '@ai-factory/secrets';
import type { AuditLog } from '@ai-factory/core';
import type { McpServer } from '@ai-factory/mcp';
import { McpServerLauncher, McpLaunchError } from '../src/mcp-launcher.ts';
import { requiredRoleFor } from '../src/auth.ts';

const SENTINEL = 'mcp-launch-sentinel-9f3c-must-never-appear';
const SENTINEL_ROTATED = 'mcp-launch-rotated-41de-must-never-appear';

function fakeServer(over: Partial<McpServer> = {}): McpServer {
  return {
    name: 'test-stdio', version: '1.0.0', provider: 'local',
    transport: 'stdio', tools: [], resources: [], scopes: [],
    permissions: [], trustLevel: 'UNKNOWN', approvalPolicy: 'BLOCKED',
    credentialRefs: ['mcp-token'], registeredAt: Date.now(),
    ...over,
  } as McpServer;
}

function fakeAudit(): { audit: AuditLog; records: unknown[] } {
  const records: unknown[] = [];
  const audit = {
    record: (actor: unknown, event: unknown, entity: unknown, id: unknown, details: unknown) => {
      records.push({ actor, event, entity, id, details });
    },
  } as unknown as AuditLog;
  return { audit, records };
}

async function makeBroker(value = SENTINEL): Promise<SecretBroker> {
  const broker = new SecretBroker({ stores: [new MemorySecretStore()] });
  await broker.set('mcp-token', value, { actor: 'test', purpose: 'test setup' });
  return broker;
}

// The child under test: prints the injected value's LENGTH (proves the
// value arrived without printing the value) and echoes the raw value
// once (the log capture must redact it).
const CHILD_SCRIPT = `
const v = process.env.MCP_TEST_TOKEN || '';
console.log('LEN=' + v.length);
console.log('RAW=' + v);
setTimeout(() => process.exit(0), 300);
`;

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('requiredRoleFor /api/mcp launch surface (§46.2 RBAC)', () => {
  it('launch and stop are admin, reads are viewer', () => {
    assert.equal(requiredRoleFor('POST', '/api/mcp/launch'), 'admin');
    assert.equal(requiredRoleFor('POST', '/api/mcp/launches/abc/stop'), 'admin');
    assert.equal(requiredRoleFor('GET', '/api/mcp/launches'), 'viewer');
    assert.equal(requiredRoleFor('GET', '/api/mcp/launches/abc/logs'), 'viewer');
  });
});

describe('McpServerLauncher (real broker + real child processes)', () => {
  const launched: McpServerLauncher[] = [];
  after(() => {
    for (const l of launched) {
      for (const rec of l.list()) {
        if (rec.alive) l.stop(rec.id, 'test-teardown', fakeAudit().audit);
      }
    }
  });

  it('injects leased secret values into the child env; logs are redacted', async () => {
    const broker = await makeBroker();
    const { audit, records } = fakeAudit();
    const launcher = new McpServerLauncher();
    launched.push(launcher);
    const rec = await launcher.launch({
      server: fakeServer(),
      installed: true, enabled: true,
      command: process.execPath,
      args: ['-e', CHILD_SCRIPT],
      secretEnv: { MCP_TEST_TOKEN: 'mcp-token' },
      actor: 'test', broker, audit,
    });
    assert.equal(rec.server, 'test-stdio');
    assert.ok(rec.pid !== null && rec.pid > 0);
    assert.deepEqual(rec.secretEnvVars, ['MCP_TEST_TOKEN']);
    assert.deepEqual(rec.credentialRefs, ['mcp-token']);
    assert.equal(rec.leasesLive, true);

    await waitFor(() => !launcher.list()[0].alive);
    const { logs } = launcher.logs(rec.id)!;
    // The value ARRIVED (length matches the sentinel) but never appears.
    assert.ok(logs.includes(`LEN=${SENTINEL.length}`), `child did not see the value:\n${logs}`);
    assert.ok(logs.includes('RAW=***'), `value not redacted in logs:\n${logs}`);
    assert.ok(!logs.includes(SENTINEL), 'sentinel leaked into launch logs');

    // The audit trail carries ref names only.
    const auditText = JSON.stringify(records);
    assert.ok(auditText.includes('MCP_SERVER_LAUNCH'), 'launch not audited');
    assert.ok(auditText.includes('mcp-token'), 'ref name missing from audit');
    assert.ok(!auditText.includes(SENTINEL), 'sentinel leaked into audit records');
  });

  it('fail-closed: not installed, non-stdio, missing ref, undeclared ref', async () => {
    const broker = await makeBroker();
    const { audit } = fakeAudit();
    const base = {
      server: fakeServer(), installed: true, enabled: true,
      command: process.execPath, args: ['-e', '1'],
      actor: 'test', broker, audit,
    };

    await assert.rejects(
      launcher_new().launch({ ...base, installed: false }),
      (e: unknown) => e instanceof McpLaunchError && e.code === 'MCP_LAUNCH_NOT_INSTALLED',
    );
    await assert.rejects(
      launcher_new().launch({ ...base, server: fakeServer({ transport: 'http' }) }),
      (e: unknown) => e instanceof McpLaunchError && e.code === 'MCP_LAUNCH_UNSUPPORTED_TRANSPORT',
    );
    await assert.rejects(
      launcher_new().launch({ ...base, secretEnv: { X: 'no-such-secret' } }),
      // 'no-such-secret' is not declared on credentialRefs either — the
      // declaration check fires first, which is the stricter gate.
      (e: unknown) => e instanceof McpLaunchError && e.code === 'MCP_SECRET_REF_NOT_DECLARED',
    );
    await assert.rejects(
      launcher_new().launch({
        ...base,
        server: fakeServer({ credentialRefs: ['declared-but-missing'] }),
        secretEnv: { X: 'declared-but-missing' },
      }),
      (e: unknown) => e instanceof McpLaunchError && e.code === 'MCP_SECRET_NOT_FOUND',
    );

    function launcher_new(): McpServerLauncher {
      const l = new McpServerLauncher();
      launched.push(l);
      return l;
    }
  });

  it('refuses launch when the command is not found; nothing spawns', async () => {
    const broker = await makeBroker();
    const { audit } = fakeAudit();
    const launcher = new McpServerLauncher();
    launched.push(launcher);
    await assert.rejects(
      launcher.launch({
        server: fakeServer(), installed: true, enabled: true,
        command: 'definitely-not-a-real-command-xyz', actor: 'test', broker, audit,
      }),
      (e: unknown) => e instanceof McpLaunchError && e.code === 'MCP_LAUNCH_COMMAND_NOT_FOUND',
    );
    assert.deepEqual(launcher.list(), []);
  });

  it('rotation revokes launch leases; running child keeps its copy, new launch resolves fresh', async () => {
    const broker = await makeBroker(SENTINEL);
    const { audit } = fakeAudit();
    const launcher = new McpServerLauncher();
    launched.push(launcher);
    const rec = await launcher.launch({
      server: fakeServer(), installed: true, enabled: true,
      command: process.execPath,
      // Long-lived child so we can observe the post-rotation state.
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      secretEnv: { MCP_TEST_TOKEN: 'mcp-token' },
      actor: 'test', broker, audit,
    });
    assert.equal(launcher.secretLeaseState('test-stdio', '1.0.0'), 'active');

    // Rotate: the launcher's leases die; the child is untouched.
    await broker.set('mcp-token', SENTINEL_ROTATED, { actor: 'test', purpose: 'rotation' });
    const after = launcher.list().find((r) => r.id === rec.id)!;
    assert.equal(after.leasesLive, false);
    assert.equal(launcher.secretLeaseState('test-stdio', '1.0.0'), 'revoked');
    assert.equal(after.alive, true, 'rotation must not kill the running child');

    // A new launch resolves the ROTATED value (proven by its length).
    const rec2 = await launcher.launch({
      server: fakeServer(), installed: true, enabled: true,
      command: process.execPath, args: ['-e', CHILD_SCRIPT],
      secretEnv: { MCP_TEST_TOKEN: 'mcp-token' },
      actor: 'test', broker, audit,
    });
    await waitFor(() => !launcher.list().find((r) => r.id === rec2.id)!.alive);
    const { logs } = launcher.logs(rec2.id)!;
    assert.ok(logs.includes(`LEN=${SENTINEL_ROTATED.length}`), `rotated value not injected:\n${logs}`);
    assert.ok(!logs.includes(SENTINEL_ROTATED), 'rotated sentinel leaked into logs');
    assert.ok(!logs.includes(SENTINEL), 'old sentinel leaked into logs');
    assert.equal(launcher.secretLeaseState('test-stdio', '1.0.0'), 'revoked',
      'old launch lease stays revoked alongside the fresh one');
  });

  it('stop() terminates the child and unknown ids 404 cleanly', async () => {
    const broker = await makeBroker();
    const { audit, records } = fakeAudit();
    const launcher = new McpServerLauncher();
    launched.push(launcher);
    const rec = await launcher.launch({
      server: fakeServer(), installed: true, enabled: true,
      command: process.execPath, args: ['-e', 'setInterval(()=>{}, 1000)'],
      actor: 'test', broker, audit,
    });
    assert.equal(launcher.stop('no-such-id', 'test', audit), false);
    assert.equal(launcher.stop(rec.id, 'test', audit), true);
    await waitFor(() => !launcher.list()[0].alive);
    const auditText = JSON.stringify(records);
    assert.ok(auditText.includes('MCP_SERVER_STOPPED'), 'stop not audited');
  });
});
