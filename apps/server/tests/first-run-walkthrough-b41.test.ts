/**
 * First-run walkthrough, fifth edition — B37–B40 chains (Batch 41-4).
 *
 * Walks the chains that landed in B37–B40 on the real compiled server over
 * a fresh temp SQLite file (plus in-process legs against the real compiled
 * packages — real code paths, never mocks):
 *
 *   M1 — MCP real handshake (Batch 37): the test process spawns the real
 *        third-party MCP server (@modelcontextprotocol/server-filesystem,
 *        via MCP_TEST_REAL_SERVER or npx) and completes a real JSON-RPC
 *        initialize → tools/list → tools/call handshake through
 *        StdioMcpConnector. No server in this environment → a LOUD
 *        diagnostic skip of this leg only (the walkthrough continues with
 *        the other legs), never a faked handshake (finding F15).
 *   S1 — sandboxed build (Batch 37): a landed merge triggers a REAL build;
 *        the audit log must show BUILD_SANDBOXED (bwrap available) or
 *        SANDBOX_UNAVAILABLE (honest fallback) — environment-adaptive
 *        (finding F16).
 *   A1 — dev attestation (Batch 38): with FACTORY_ATTESTATION_KEY set, the
 *        SUCCEEDED build carries attestationRef; the envelope verifies via
 *        verifyDevAttestation, subject == the build's real §40 digest, and
 *        the predicate is plaintext dev-only. The null path (no key →
 *        attestationRef null) is pinned in-process against the real
 *        attestationKeyFromEnv (finding F17) — no second boot.
 *   T1 — §81 new triggers (Batch 38/39), over pure HTTP:
 *        · repeated-failure: the adapter keeps requesting a nonexistent
 *          tool → same error signature 3× → LoopStagnation → outcome
 *          'escalated' → 'repeated-failure' upgrade (recipient null,
 *          'operator', classified by machine code LOOP_STAGNATION);
 *        · high-risk-deployment: a PROD deploy parks on approval; the
 *          ticket carries the ASSESSED risk level (computed HIGH, not
 *          hardcoded) and a 'high-risk-deployment' upgrade is raised
 *          (recipient null, 'manager');
 *        · budget-exceeded: HONEST SKIP — the route's default stepFn
 *          COMPLETES at the first EVALUATE (~6 steps), so no HTTP run can
 *          reach maxSteps 40; covered at package level
 *          (runner-reason-code.test.ts) — finding F14.
 *   E1 — environment error codes (Batch 40), in-process against the real
 *        compiled @ai-factory/runtime: runCommandPipe on a nonexistent
 *        binary throws MissingBinaryError (code ENV_BINARY_MISSING);
 *        assertSandboxAvailable on a bogus bwrap binary throws
 *        SandboxUnavailableError (code ENV_SANDBOX_UNAVAILABLE).
 *
 * Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md (Batch 41 section).
 * v4 (B31–B36) remains the authority for the governance chains; v5 covers
 * B37–B40 only (finding F18).
 *
 * Requires the workspace build (root `npm run build`); run with
 * `npm run demo:e2e-v5`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  StdioMcpConnector,
  performHandshake,
  McpRegistry,
  CLIENT_PROTOCOL_VERSIONS,
} from '@ai-factory/mcp';
import { verifyDevAttestation, attestationKeyFromEnv } from '@ai-factory/cicd';
import {
  runCommandPipe,
  MissingBinaryError,
  SandboxUnavailableError,
} from '@ai-factory/runtime';
// Dual-mode note: build-sandbox.ts value-imports a sibling extensionless,
// so this test imports the COMPILED ../dist/build-sandbox.js (root build
// must run first). See AGENTS.md dual-mode import rule.
import { assertSandboxAvailable } from '../dist/build-sandbox.js';

// ---------------------------------------------------------------- helpers --

type Json = Record<string, unknown>;

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(
  dbFile: string,
  extraEnv: Record<string, string> = {},
): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets: the booted server's cwd is apps/server, whose
    // local data/secrets/ may carry a stale vault from earlier dev runs
    // (fail-closed decrypt errors). Point the file vault at the temp dir.
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-b41-secrets-${port}`),
    ...extraEnv,
  };
  delete env['FACTORY_API_TOKEN'];
  delete env['FACTORY_API_TOKENS'];
  if (!('FACTORY_RUNTIME_TOOLS' in extraEnv)) delete env['FACTORY_RUNTIME_TOOLS'];
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not become healthy in 20000ms');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function stopServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => s.child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** Real repo whose lockfile carries real package entries (for SBOM). */
function makeRepoWithDeps(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-walkb41-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'walk']);
  git(dir, ['config', 'user.email', 'walk@example.com']);
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/left-pad': { version: '1.3.0' },
      },
    }),
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'root']);
  git(dir, ['checkout', '-qb', 'feat']);
  writeFileSync(join(dir, 'f.txt'), 'f\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

/** Poll the pure-HTTP builds surface until the record leaves NOT_EXECUTED. */
async function waitForTerminalBuildHttp(
  port: number,
  prId: string,
  timeoutMs = 90_000,
): Promise<Json | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Json | null = null;
  for (;;) {
    try {
      const res = await api(port, 'GET', `/api/builds?prId=${encodeURIComponent(prId)}`);
      if (res.status === 200) {
        const items = (res.body['items'] ?? []) as Array<Json>;
        last = items[0] ?? null;
        if (last && last['status'] !== 'NOT_EXECUTED') return last;
      }
    } catch {
      /* transient — retry */
    }
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Poll a runtime run until it leaves RUNNING. */
async function waitForRun(port: number, runId: string, timeoutMs = 60_000): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
    assert.equal(r.status, 200);
    const rec = r.body as Json;
    if (rec['status'] !== 'RUNNING') return rec;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 200));
  }
}

function auditActions(body: Json | unknown[]): string[] {
  const recs = (Array.isArray(body) ? body : ((body as Json)['records'] ?? [])) as Array<{
    action?: string;
  }>;

  return recs.map((r) => r.action ?? '').filter(Boolean);
}

/**
 * The server never came up in this environment (npx could not fetch it,
 * spawn ENOENT, the child died before serving). That is an environment
 * problem, not a handshake problem: skip loudly instead of failing.
 * Anything AFTER a running server answers is a real assertion.
 * (Mirrors packages/mcp/tests/real-handshake.test.ts.)
 */
function serverNeverCameUp(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const actual = (err as { actual?: unknown } | null)?.actual;
  const actualMsg = actual instanceof Error ? actual.message : '';
  return /server process exited|spawn .* ENOENT|EACCES/i.test(msg + ' ' + actualMsg);
}

async function openNeedsHuman(port: number): Promise<Array<Json>> {
  const r = await api(port, 'GET', '/api/needs-human?status=open');
  assert.equal(r.status, 200);
  return (r.body['items'] ?? []) as Array<Json>;
}

// ------------------------------------------------------------------ the run --

describe('first-run walkthrough, fifth edition — B37–B40 chains (Batch 41-4)', () => {
  it('MCP real handshake → sandboxed build → dev attestation → §81 new triggers → env error codes', { timeout: 600_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b41-'));
    const dbFile = join(dir, 'factory.db');
    const sbomDir = join(dir, 'sboms');
    const workRoot = mkdtempSync(join(tmpdir(), 'walk-b41-buildwork-'));
    const repo = makeRepoWithDeps();
    const attestSeed = randomBytes(32).toString('hex'); // FACTORY_ATTESTATION_KEY (64-hex seed)
    let server: BootedServer | undefined;
    try {
      // --------------------------------------------------------------- M1 --
      // MCP real handshake (Batch 37) — in this process, real server.
      {
        const workspaceDir = mkdtempSync(join(tmpdir(), 'mcp-walk-b41-'));
        writeFileSync(join(workspaceDir, 'probe.txt'), 'hello-walk-b41\n');
        const envEntry = (process.env.MCP_TEST_REAL_SERVER ?? '').trim();
        const spec = envEntry
          ? { command: process.execPath, args: [envEntry, workspaceDir], describe: `MCP_TEST_REAL_SERVER=${envEntry}` }
          : { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', workspaceDir], describe: 'npx -y @modelcontextprotocol/server-filesystem@1.0.0' };
        const registry = new McpRegistry();
        registry.register({
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
          source: 'npm:@modelcontextprotocol/server-filesystem@1.0.0',
        });
        const connector = new StdioMcpConnector({
          command: spec.command,
          args: spec.args,
          requestTimeoutMs: 150_000,
          clientInfo: { name: 'ai-factory-walkthrough-b41', version: '0.0.0-walk' },
        });
        const getServer = () => {
          const s = registry.get('real-filesystem', '1.0.0');
          assert.ok(s, 'server must be registered');
          return s;
        };
        let launched = false;
        try {
          await connector.launch(getServer());
          launched = true;
        } catch (err) {
          // F15: launch-stage failure is an environment problem, not a
          // handshake problem — note loudly and continue with the other
          // legs; never fake the handshake.
          t.diagnostic(`M1 LOUD SKIP: no real MCP server in this environment (${spec.describe}): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        }
        if (launched) {
          let hs;
          try {
            hs = await performHandshake(registry, connector, 'real-filesystem', '1.0.0');
          } catch (err) {
            if (serverNeverCameUp(err)) {
              // F15: the server process died before serving (npx fetch
              // failed, registry unreachable) — environment problem. Note
              // loudly, continue with the other legs, never fake it.
              t.diagnostic(`M1 LOUD SKIP: real MCP server died before serving (${spec.describe}): ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
              await connector.close(getServer()).catch(() => undefined);
              hs = null;
            } else {
              throw err;
            }
          }
          if (hs) {
            assert.ok(
              (CLIENT_PROTOCOL_VERSIONS as readonly string[]).includes(hs.negotiatedVersion),
              `negotiated version must be one the client listed, got '${hs.negotiatedVersion}'`,
            );
            assert.ok(hs.serverInfo?.name, 'real server reports serverInfo.name');
            const tools = await connector.listTools(getServer());
            assert.ok(tools.length > 0, 'real server lists tools');
            assert.ok(tools.some((x) => x.name === 'read_text_file'), 'filesystem server offers read_text_file');
            const read = await connector.callTool(getServer(), 'read_text_file', {
              path: join(workspaceDir, 'probe.txt'),
            });
            assert.equal(read.ok, true);
            assert.ok(
              JSON.stringify(read.content).includes('hello-walk-b41'),
              'tools/call returns the real probe file content',
            );
            t.diagnostic(`M1 real handshake OK: server='${hs.serverInfo?.name}' protocol='${hs.negotiatedVersion}' tools=${tools.length}`);
            await connector.close(getServer());
          }
        }
      }

      // ------------------------------------------------------------ boot A --
      server = await bootServer(dbFile, {
        FACTORY_BUILD_COMMAND: `node -e \"require('fs').writeFileSync('built.txt','ok')\"`,
        FACTORY_BUILD_WORK_ROOT: workRoot,
        FACTORY_BUILD_TIMEOUT_MS: '30000',
        FACTORY_SBOM_DIR: sbomDir,
        FACTORY_BUILD_CONFIG_FILES: 'package-lock.json',
        FACTORY_ATTESTATION_KEY: attestSeed,
        FACTORY_RUNTIME_TOOLS: 'echo',
      });
      const port = server.port;

      // --------------------------------------------------------------- S1 --
      // A landed merge triggers a REAL build; the sandbox decision is
      // observed in the audit log — environment-adaptive (F16).
      const project = await api(port, 'POST', '/api/projects', { name: 'Walk B41' });
      assert.equal(project.status, 201);
      const task = await api(port, 'POST', '/api/tasks', {
        projectId: project.body['id'],
        title: 'walk b41 build',
        goal: 'exercise the Batch 37–40 chains',
      });
      assert.equal(task.status, 201);
      const taskId = task.body['id'] as string;
      const pr = await api(port, 'POST', '/api/git/pr', {
        repo,
        taskId,
        sourceBranch: 'feat',
        targetBranch: 'main',
        title: 'Merge feat',
      });
      assert.equal(pr.status, 201);
      const prId = pr.body['id'] as string;
      const merged = await api(port, 'POST', `/api/git/pr/${prId}/merge`, { repo, actor: 'human' });
      assert.equal(merged.status, 200);
      const buildRow = await waitForTerminalBuildHttp(port, prId);
      assert.ok(buildRow, 'build record reached a terminal state over HTTP');
      assert.equal(buildRow!['status'], 'SUCCEEDED', `build really ran; failureReason=${buildRow!['failureReason']}`);
      const digest = String(buildRow!['digest'] ?? '');
      assert.match(digest, /^[0-9a-f]{64}$/, 'real 64-hex §40 digest');
      const buildId = buildRow!['id'] as string;

      const audit = await api(port, 'GET', '/api/audit?limit=2000');
      assert.equal(audit.status, 200);
      const actions = auditActions(audit.body);
      const sandboxed = actions.includes('BUILD_SANDBOXED');
      const fellBack = actions.includes('SANDBOX_UNAVAILABLE');
      assert.ok(
        sandboxed || fellBack,
        'the build ran either sandboxed (BUILD_SANDBOXED) or via the honest fallback (SANDBOX_UNAVAILABLE)',
      );
      t.diagnostic(`S1 build ${buildId} SUCCEEDED; sandbox: ${sandboxed ? 'BUILD_SANDBOXED' : 'SANDBOX_UNAVAILABLE fallback'}`);

      // --------------------------------------------------------------- A1 --
      // Dev attestation (Batch 38): the SUCCEEDED build carries a
      // verifiable dev-only attestation.
      const byId = await api(port, 'GET', `/api/builds/${buildId}`);
      assert.equal(byId.status, 200);
      const buildFull = byId.body['build'] as Json;
      const attestationRef = buildFull['attestationRef'] as string | null;
      assert.ok(attestationRef, 'attestationRef is set when the key is configured');
      assert.equal(buildFull['attestationFile'], 'present', 'attestation file is present on disk');
      const envelope = JSON.parse(readFileSync(attestationRef, 'utf8')) as unknown;
      assert.equal(verifyDevAttestation(envelope), true, 'dev attestation verifies');
      const statement = (envelope as { statement?: Json })['statement'] as Json;
      const subjects = (statement['subject'] ?? []) as Array<Json>;
      assert.ok(
        subjects.some((s) => (s['digest'] as Json)?.['sha256'] === digest),
        'attestation subject is the build\u2019s real §40 digest',
      );
      const predicate = statement['predicate'] as Json;
      assert.equal(predicate['devOnly'], true, 'predicate is plaintext-marked dev-only');
      t.diagnostic(`A1 attestation verifies; subject digest == build digest ${digest.slice(0, 12)}…`);
      // F17: the honest-absence path (no key → null) is pinned in-process
      // against the real attestationKeyFromEnv — no second boot needed.
      assert.equal(attestationKeyFromEnv({}), null, 'no key configured → attestationKeyFromEnv() is null');

      // --------------------------------------------------------------- T1 --
      // §81 new triggers (Batch 38/39) over pure HTTP.
      const agent = await api(port, 'POST', '/api/agents', { name: 'walker-b41', jobTitle: 'Engineer' });
      assert.equal(agent.status, 201);
      const agentId = agent.body['id'] as string;

      // budget-exceeded: 45 echo steps against maxSteps 40.
      // F14 (revised): this does NOT work — the route's default stepFn
      // returns COMPLETE at the first EVALUATE, so every HTTP run finishes
      // in ~6 steps and can never reach maxSteps 40. There is no
      // HTTP-reachable trigger for BUDGET_EXCEEDED; the emission code
      // path (buildRunUpgradeRecord/emitRunNeedsHuman) is covered at
      // package level (runner-reason-code.test.ts). The walkthrough does
      // not fake it — this leg is an honest skip.
      t.diagnostic('T1 budget-exceeded: honest skip — no HTTP-reachable trigger (finding F14)');

      // repeated-failure: the adapter keeps requesting a tool that does
      // not exist. The loop sees the same error signature
      // ('adapter:unknown-tool') 3 times in a row → LoopStagnation →
      // outcome 'escalated' → the server emits 'repeated-failure'.
      // Deterministic, over pure HTTP — no mocks.
      const failScript = Array.from({ length: 4 }, (_, i) => ({
        text: `broken step ${i}`,
        toolCalls: [{ tool: 'no-such-tool-walk-b41', args: {} }],
      }));
      const run = await api(port, 'POST', '/api/runtime/runs', { agentId, taskId, script: failScript });
      assert.equal(run.status, 202);
      const runId = run.body['id'] as string;
      const finished = await waitForRun(port, runId);
      assert.equal(finished['status'], 'ESCALATED', `run escalated on repeated failure, got ${finished['status']}`);
      const upgrades1 = await openNeedsHuman(port);
      const stallUp = upgrades1.find((u) => u['reason'] === 'repeated-failure');
      assert.ok(stallUp, 'a repeated-failure upgrade was raised');
      assert.equal(stallUp!['recipient'], null, 'recipient is null — no named human accounts');
      assert.equal(stallUp!['requiredDeciderLevel'], 'operator');
      assert.ok(String(stallUp!['source'] ?? '').startsWith('runtime-run:'), 'source names the run');
      const stallCtx = JSON.parse(String(stallUp!['contextJson'] ?? '{}')) as Json;
      assert.equal(stallCtx['reasonCode'], 'LOOP_STAGNATION', 'classified by machine code, not message');
      t.diagnostic(`T1 repeated-failure → needs-human ${String(stallUp!['id']).slice(0, 8)}… (operator)`);

      // high-risk-deployment: a PROD deploy parks on approval; the ticket
      // carries the ASSESSED level (computed HIGH, not hardcoded).
      const pl = await api(port, 'POST', '/api/pipelines', { taskId });
      assert.equal(pl.status, 201);
      const pipelineId = pl.body['id'] as string;
      const dep = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId,
        actor: 'walk-b41',
      });
      assert.equal(dep.status, 200);
      assert.ok(dep.body['pendingApproval'], 'PROD deploy parks on a human-approval ticket');
      const ticket = dep.body['approval'] as Json;
      assert.equal(ticket['risk_level'], 'HIGH', 'ticket carries the assessed HIGH level');
      const upgrades2 = await openNeedsHuman(port);
      const deployUp = upgrades2.find((u) => u['reason'] === 'high-risk-deployment');
      assert.ok(deployUp, 'a high-risk-deployment upgrade was raised');
      assert.equal(deployUp!['recipient'], null);
      assert.equal(deployUp!['requiredDeciderLevel'], 'manager');
      t.diagnostic(`T1 high-risk-deployment → needs-human ${String(deployUp!['id']).slice(0, 8)}… (manager)`);

      // --------------------------------------------------------------- E1 --
      // Environment error codes (Batch 40), in-process against the real
      // compiled @ai-factory/runtime — no mocks, no server round-trip.
      await assert.rejects(
        runCommandPipe(['/nonexistent-binary-walk-b41-xyz']),
        (err: unknown) => {
          assert.ok(err instanceof MissingBinaryError, 'throws MissingBinaryError');
          assert.equal((err as MissingBinaryError).code, 'ENV_BINARY_MISSING');
          return true;
        },
        'missing binary → MissingBinaryError with code ENV_BINARY_MISSING',
      );
      await assert.rejects(
        assertSandboxAvailable('/nonexistent/bwrap-walk-b41-xyz'),
        (err: unknown) => {
          assert.ok(err instanceof SandboxUnavailableError, 'throws SandboxUnavailableError');
          assert.equal((err as SandboxUnavailableError).code, 'ENV_SANDBOX_UNAVAILABLE');
          return true;
        },
        'failed sandbox probe → SandboxUnavailableError with code ENV_SANDBOX_UNAVAILABLE',
      );
      t.diagnostic('E1 env error codes: ENV_BINARY_MISSING + ENV_SANDBOX_UNAVAILABLE both real');

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
