/**
 * MCP registry durability across restarts — §46 / §34.1 (Batch 21).
 *
 * Until Batch 21 the registry and the trust assessments were process
 * memory: a restart sent every approved server back to BLOCKED. Now
 * registrations, trust/assessments and install records are written
 * through to fdb.mcpServers and hydrated at startup. Pinned on the
 * REAL server binary (boot → SIGKILL → reboot on the same DB file):
 *
 *  - register (BLOCKED) -> approve (AUTO) -> install -> launch 201,
 *    SIGKILL, reboot: the trust view still shows AUTO (not BLOCKED)
 *    and launch answers 201 again, not 403 MCP_TRUST_NOT_APPROVED;
 *  - health is point-in-time: a persisted health report is marked
 *    stale on hydrate and NOT loaded into the live registry (unit
 *    half below: the registry shows health null, the row keeps the
 *    old report flagged stale);
 *  - credentialRefs are names only AND a smuggled
 *    runtimePolicy.stdioEnvFixed VALUE never reaches disk: the raw DB
 *    file bytes are scanned for the sentinel value (absent) while the
 *    ref names and the (nulled) keys are present;
 *  - hydration restores registeredAt / append-only history verbatim
 *    and generates no new history events.
 *
 * Boots dist/index.js, so this file runs after the server build.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryDatabase } from '@ai-factory/db';
import { McpRegistry, McpManager, type McpServer } from '@ai-factory/mcp';
import {
  hydrateMcpRegistry,
  serverToRow,
  installToRow,
} from '../src/mcp-persistence.ts';

const ADMIN = 'mcp-persist-admin-xyz';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

// A secret VALUE smuggled into the registration. It must never appear
// in the persisted rows (the refs are names; fixed-env values are
// resolved at launch time).
const SMUGGLED_VALUE = 'mcp-smuggled-value-7d2a-must-never-reach-disk';

async function bootRealServer(dbFile: string): Promise<{ child: ChildProcess; port: number }> {
  const port = 27_000 + Math.floor(Math.random() * 15_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKENS: `admin:${ADMIN}`,
    FACTORY_SECRETS_BACKEND: 'memory',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopRealServer(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
}

describe('MCP registry survives restarts (§46, Batch 21)', () => {
  it('register -> approve -> install -> launch 201 -> SIGKILL -> reboot -> launch 201 (not 403)', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-persist-e2e-'));
    const dbFile = join(dir, 'factory.db');
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const name = `persist-probe-${suffix}`;
    const version = '1.0.0';
    const id = `${name}@${version}`;

    const boot1 = await bootRealServer(dbFile);
    const call = async (port: number, method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${ADMIN}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
      return { status: res.status, body: parsed };
    };

    try {
      // Register with credentialRefs AND a smuggled fixed-env value.
      const reg = await call(boot1.port, 'POST', '/api/mcp/register', {
        server: {
          name,
          version,
          provider: 'local',
          transport: 'stdio',
          tools: [{ name: 'probe' }],
          credentialRefs: ['PERSIST_PROBE_REF'],
          runtimePolicy: {
            stdioEnvAllowlist: ['PATH'],
            stdioEnvFixed: { PERSIST_PROBE_VAR: SMUGGLED_VALUE },
            allowedCredentialHeaders: [],
            followRedirects: false,
            tlsMode: 'system',
            requireTlsForCredentials: true,
            allowDynamicUrl: false,
            maxResourceBytes: 1024,
          },
        },
      });
      assert.equal(reg.status, 201, JSON.stringify(reg.body).slice(0, 300));
      assert.equal((reg.body.server as Record<string, unknown>).approvalPolicy, 'BLOCKED');

      // Launch is still correctly refused before approval.
      const l0 = await call(boot1.port, 'POST', '/api/mcp/launch', {
        name, version, command: 'node', args: ['-e', '1'],
      });
      assert.equal(l0.status, 403);
      assert.equal(l0.body.code, 'MCP_TRUST_NOT_APPROVED');

      // Approve (AUTO) -> install -> launch 201.
      const ap = await call(boot1.port, 'POST', `/api/mcp/servers/${id}/trust/approve`, {
        trustLevel: 'HIGH', approvalPolicy: 'AUTO', reviewer: 'human',
      });
      assert.equal(ap.status, 200, JSON.stringify(ap.body).slice(0, 300));
      const ins = await call(boot1.port, 'POST', '/api/mcp/install', { name, version });
      assert.equal(ins.status, 200, JSON.stringify(ins.body).slice(0, 300));
      const l1 = await call(boot1.port, 'POST', '/api/mcp/launch', {
        name, version, command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
      });
      assert.equal(l1.status, 201, JSON.stringify(l1.body).slice(0, 300));
    } finally {
      boot1.child.kill('SIGKILL');
      await new Promise((r) => boot1.child.once('exit', r));
    }

    // The smuggled value must not be on disk, anywhere. The DB runs
    // in WAL mode, so committed rows may live in the -wal file —
    // scan every byte the database owns.
    const raw = Buffer.concat(
      [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]
        .map((p) => {
          try {
            return readFileSync(p);
          } catch {
            return Buffer.alloc(0);
          }
        }),
    );
    assert.ok(
      !raw.includes(Buffer.from(SMUGGLED_VALUE)),
      'smuggled secret value must never reach the DB files',
    );
    const rawText = raw.toString('utf8');
    assert.ok(rawText.includes('PERSIST_PROBE_REF'), 'ref NAMES are persisted');
    assert.ok(rawText.includes('PERSIST_PROBE_VAR'), 'fixed-env keys stay visible');

    // Reboot on the same DB file.
    const boot2 = await bootRealServer(dbFile);
    try {
      // Trust survived: still AUTO, not BLOCKED.
      const tv = await call(boot2.port, 'GET', `/api/mcp/servers/${id}/trust`);
      assert.equal(tv.status, 200, JSON.stringify(tv.body).slice(0, 300));
      assert.equal(tv.body.approvalPolicy, 'AUTO');
      assert.equal(tv.body.trustLevel, 'HIGH');
      assert.ok(tv.body.assessment, 'the assessment itself survived');
      assert.equal((tv.body.assessment as Record<string, unknown>).assessedBy, 'human');

      // Launch works again — no re-approval needed.
      const l2 = await call(boot2.port, 'POST', '/api/mcp/launch', {
        name, version, command: 'node', args: ['-e', 'setTimeout(()=>{},1000)'],
      });
      assert.equal(l2.status, 201, `launch after restart must be 201, got ${JSON.stringify(l2.body).slice(0, 300)}`);

      // The running launch is process-local, but the registration list
      // still shows the server installed+enabled.
      const list = await call(boot2.port, 'GET', '/api/mcp');
      const found = (list.body.servers as Array<Record<string, unknown>>).find(
        (s) => s.name === name && s.version === version,
      );
      assert.ok(found, 'server still listed after restart');
      assert.equal(found?.installStatus, 'INSTALLED');
      assert.equal(found?.enabled, true);
      assert.equal(found?.health, null, 'no health check ran this process');

      // Stop the sleeper launch before leaving.
      const launches = await call(boot2.port, 'GET', '/api/mcp/launches');
      for (const rec of (launches.body.launches as Array<Record<string, unknown>>) ?? []) {
        if (rec.server === name && rec.alive) {
          await call(boot2.port, 'POST', `/api/mcp/launches/${rec.id}/stop`, {});
        }
      }
    } finally {
      await stopRealServer(boot2.child);
    }
  });
});

describe('hydrate semantics (§46, Batch 21)', () => {
  it('health is marked stale, not inherited; history and registeredAt are verbatim; no new events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-hydrate-'));
    const dbFile = join(dir, 'factory.db');
    const server: McpServer = {
      name: 'hydrate-probe',
      version: '2.0.0',
      provider: 'test',
      transport: 'stdio',
      tools: [{ name: 't' }],
      resources: [],
      scopes: [],
      permissions: [],
      trustLevel: 'VERIFIED',
      approvalPolicy: 'HUMAN_APPROVAL',
      credentialRefs: ['REF_X'],
      health: {
        server: 'hydrate-probe',
        version: '2.0.0',
        checkedAt: 1700000005000,
        overall: 'healthy',
        levels: [],
      },
      history: [
        { at: 1700000000000, kind: 'REGISTERED' },
        { at: 1700000001000, kind: 'TRUST_ASSESSED', actor: 'human', detail: 'VERIFIED/HUMAN_APPROVAL' },
      ],
      negotiatedVersion: '1.0',
      extensionSet: ['x'],
      registeredAt: 1700000000000,
    };
    const fdb = new FactoryDatabase(dbFile);
    fdb.mcpServers.saveServer(
      serverToRow(server, {
        trustLevel: 'VERIFIED',
        approvalPolicy: 'HUMAN_APPROVAL',
        assessedAt: 1700000001000,
        assessedBy: 'human',
      }),
    );
    fdb.mcpServers.saveInstall(
      installToRow({
        name: 'hydrate-probe',
        version: '2.0.0',
        status: 'INSTALLED',
        installedAt: 1700000002000,
        scopeEnabled: {},
      }),
    );

    const registry = new McpRegistry();
    const manager = new McpManager(registry);
    const result = hydrateMcpRegistry({ registry, manager, store: fdb.mcpServers });
    assert.equal(result.restoredServers, 1);
    assert.equal(result.restoredInstalls, 1);
    assert.equal(result.staleHealthMarked, 1);

    const back = registry.get('hydrate-probe', '2.0.0');
    assert.ok(back);
    assert.equal(back?.trustLevel, 'VERIFIED');
    assert.equal(back?.approvalPolicy, 'HUMAN_APPROVAL');
    assert.equal(back?.health, undefined, 'stale health is NOT loaded into the live registry');
    assert.equal(back?.registeredAt, 1700000000000, 'registeredAt restored verbatim');
    assert.deepEqual(
      back?.history,
      server.history,
      'append-only history restored verbatim, no new events',
    );
    assert.deepEqual(back?.credentialRefs, ['REF_X']);
    assert.equal(back?.negotiatedVersion, '1.0');
    assert.equal(
      fdb.mcpServers.getServer('hydrate-probe', '2.0.0')?.healthStale,
      true,
      'the row keeps the old report flagged stale',
    );
    assert.equal(
      manager.getAssessment('hydrate-probe', '2.0.0')?.assessedAt,
      1700000001000,
      'assessment restored without re-stamping',
    );
    assert.equal(manager.getInstall('hydrate-probe', '2.0.0')?.status, 'INSTALLED');
  });

  it('corrupt rows are skipped loudly, not fatally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-mcp-hydrate-bad-'));
    const dbFile = join(dir, 'factory.db');
    const fdb = new FactoryDatabase(dbFile);
    fdb.mcpServers.saveServer({
      name: 'bad',
      version: '0.0.1',
      trustLevel: 'UNKNOWN',
      approvalPolicy: 'BLOCKED',
      healthStale: false,
      recordJson: '{not json',
      assessmentJson: null,
      updatedAt: new Date().toISOString(),
      rowVersion: 0,
    });
    const registry = new McpRegistry();
    const manager = new McpManager(registry);
    const result = hydrateMcpRegistry({ registry, manager, store: fdb.mcpServers });
    assert.equal(result.restoredServers, 0);
    assert.equal(registry.has('bad', '0.0.1'), false);
  });
});
