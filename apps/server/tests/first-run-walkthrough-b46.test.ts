/**
 * First-run walkthrough, seventh edition — B43–B45 chains (Batch 46-3).
 *
 * Walks the Batch 43–45 links against the real compiled server over a
 * fresh temp SQLite file, pure HTTP, zero mocks (the E1-package leg runs
 * the real compiled @ai-factory/runtime in-process, also zero mocks):
 *
 *   N1 — narrative persistence (Batch 44, finding F19): trigger
 *        'policy-violation' (same granter, 3× §8.2 task-scope ceiling
 *        denials) → GET /api/needs-human?status=open → the persisted
 *        record's detailJson.narrative contains the honest qualifier
 *        ("The policy held on every attempt — no elevation occurred").
 *        Before Batch 44 the narrative died with the transient object.
 *   K1 — backup covers project working files (Batch 45): create a real
 *        project tree (working files + .ai/) → POST /api/projects with
 *        its path → POST /api/backup → the manifest scope is
 *        'factory-database+project-files' and lists per-file entries
 *        `projects/<id>/<rel>`; tamper one backed-up file →
 *        POST /api/restore/project-files → 422, the live tree untouched
 *        (validation runs before any write).
 *   E1 — env-error signals (Batch 43/45), two halves:
 *        (a) package-level, real runtime, default stepFn, zero custom
 *            stepFn: a tool throwing MissingBinaryError 3× → run
 *            ESCALATED, reasonCode LOOP_STAGNATION, stagnationSignature
 *            ENV_BINARY_MISSING (the Batch 45 narrow passthrough — only
 *            ENV_ERROR_CODES codes keep their code as the signature);
 *            a tool throwing a plain Error 3× → signature stays
 *            'tool:<name>:fail' (masking preserved for ordinary tools).
 *        (b) HTTP negative control (Batch 44): unknown-tool 3× over
 *            POST /api/runtime/runs → run ESCALATED → exactly one
 *            'repeated-failure' upgrade for that run and zero
 *            'irrecoverable-env-error' (the env gate does not
 *            false-positive; the HTTP positive path still does not
 *            exist — see F22).
 *
 * Findings are pinned in docs/FIRST_RUN_WALKTHROUGH.md (Batch 46 section,
 * F22+). v4 remains the authority for the B31–B36 governance chains, v5
 * for the B37–B40 chains, v6 for the B41–B42 §81 chains; v7 covers
 * B43–B45 only.
 *
 * Requires the workspace build (root `npm run build`); run with
 * `npm run demo:e2e-v7`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentLoop,
  Harness,
  isEnvErrorCode,
  MissingBinaryError,
  runAgent,
  StubAdapter,
} from '@ai-factory/runtime';
import type { Agent, Task } from '@ai-factory/core';

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
    headers: { ...(body ? { 'content-type': 'application/json' } : {}) },
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
    ...extraEnv,
    PORT: String(port),
    DB_PATH: dbFile,
    // Hermetic secrets: point the file vault at a temp dir so the walk
    // never inherits the developer's local (git-ignored) vault.
    FACTORY_SECRETS_DIR: join(tmpdir(), `factory-walk-b46-secrets-${port}`),
  };
  delete env['FACTORY_API_TOKEN'];
  if (!('FACTORY_RUNTIME_TOOLS' in env)) delete env['FACTORY_RUNTIME_TOOLS'];
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

async function killServer(s: BootedServer): Promise<void> {
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
}

async function openNeedsHuman(port: number): Promise<Array<Json>> {
  const r = await api(port, 'GET', '/api/needs-human?status=open');
  assert.equal(r.status, 200);
  return (r.body['items'] ?? []) as Array<Json>;
}

// --- package-level E1 helpers (mirrors the Batch 45-3 true-path test) ---

function makeAgent(): Agent {
  return {
    id: 'agent-walk-b46', name: 'Walk', displayName: 'Walk', jobTitle: 'AI Coder',
    department: 'engineering', parentAgentId: null, mission: 'Walk the env chain.',
    instructions: 'Follow the loop.', skills: ['typescript'], rules: [],
    model: 'code-coder', reasoningLevel: 'MEDIUM', tools: ['read', 'write'],
    permissions: ['filesystem.read', 'filesystem.write'], autonomyLevel: 3,
    status: 'WORKING', version: 1,
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
  };
}

function makeTask(): Task {
  return {
    id: 'task-walk-b46', projectId: 'proj-walk-b46', parentTaskId: null,
    title: 'Walk the env chain', goal: 'Pin the env-error signal chain.',
    description: '', priority: 'P2', severity: 'MAJOR',
    acceptanceCriteria: ['env chain pinned'], constraints: [],
    workspace: '/tmp/ai-factory-ws', creator: 'walk', status: 'IN_PROGRESS',
    currentAgentId: 'agent-walk-b46', assignedAgentIds: ['agent-walk-b46'],
    subtaskIds: [], dependencies: [], risk: 'LOW',
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
    completedAt: null,
  };
}

function boomScript(tool: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    text: `attempt ${i}`,
    toolCalls: [{ tool, args: {} }],
  }));
}

// ------------------------------------------------------------------ the run --

describe('first-run walkthrough, seventh edition — B43–B45 chains (Batch 46-3)', () => {
  it('narrative persistence → backup project files → env-error signals', { timeout: 600_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-walk-b46-'));
    const dbFile = join(dir, 'factory.db');
    let server: BootedServer | undefined;
    // The K1 project tree lives outside `dir` (the backup collector must
    // not see the backup dir as project content); track it for cleanup.
    // Batch 47-2 (F22): project working dirs must sit under the
    // operator-configured root, so the walk sets FACTORY_PROJECTS_ROOT
    // to its own temp base and builds the project tree inside it.
    let projDir = '';
    let projectsRoot = '';
    try {
      projectsRoot = mkdtempSync(join(tmpdir(), 'factory-walk-b46-root-'));
      server = await bootServer(dbFile, { FACTORY_PROJECTS_ROOT: projectsRoot });
      const port = server.port;

      // --------------------------------------------------------------- N1 --
      // Narrative persistence (Batch 44, finding F19): the honest
      // qualifier must survive into the persisted record, visible via
      // GET /api/needs-human.
      const denyOnce = async (granter: string) => {
        const r = await api(port, 'POST', '/api/workforce/employees', {
          jobTitle: 'Walk B46 Engineer',
          requestedBy: granter,
          taskScope: [],
        });
        assert.equal(r.status, 403, 'empty task scope → 403 ceiling denial');
      };
      const granter = 'walk-granter-b46';
      await denyOnce(granter);
      await denyOnce(granter);
      await denyOnce(granter);
      let upgrades = await openNeedsHuman(port);
      const pvRows = upgrades.filter((u) => u['reason'] === 'policy-violation');
      assert.equal(pvRows.length, 1, 'exactly one OPEN policy-violation upgrade after 3 denials');
      const pv = pvRows[0]!;
      assert.equal(pv['source'], `policy-denial:${granter}`);
      const pvDetail = JSON.parse(String(pv['detailJson'] ?? '{}')) as Json;
      assert.ok(
        String(pvDetail['narrative'] ?? '').includes('The policy held on every attempt'),
        'F19 fix: the honest qualifier survives persistence into detailJson.narrative',
      );
      t.diagnostic(`N1 narrative persisted in needs-human ${String(pv['id']).slice(0, 8)}…`);

      // --------------------------------------------------------------- K1 --
      // Backup covers project working files (Batch 45): a real project
      // tree (working files + .ai/) → POST /api/backup → manifest
      // lists per-file entries; tamper one backed-up file → restore
      // refuses with 422 and the live tree is untouched.
      projDir = mkdtempSync(join(projectsRoot, 'factory-walk-b46-proj-'));
      mkdirSync(join(projDir, '.ai'), { recursive: true });
      mkdirSync(join(projDir, 'src'), { recursive: true });
      writeFileSync(join(projDir, '.ai', 'config.yaml'), 'name: walk-b46\n');
      writeFileSync(join(projDir, 'src', 'index.ts'), 'export const walk = 46;\n');
      writeFileSync(join(projDir, 'README.md'), '# walk-b46\n');
      const proj = await api(port, 'POST', '/api/projects', {
        name: 'walk-b46',
        path: projDir,
      });
      assert.equal(proj.status, 201, 'project record created with a working-dir path');
      const projectId = String(proj.body['id']);
      assert.ok(projectId, 'project id returned');

      const bk = await api(port, 'POST', '/api/backup');
      assert.equal(bk.status, 201, 'backup created');
      const backupId = String(bk.body['backupId']);
      const backupDir = String(bk.body['dir']);
      const manifest = bk.body['manifest'] as Json;
      assert.equal(
        manifest['scope'],
        'factory-database+project-files',
        'scope is honest: project files were actually collected',
      );
      const files = (manifest['files'] ?? []) as Array<Json>;
      const names = files.map((f) => String(f['name']));
      assert.ok(
        names.includes(`projects/${projectId}/src/index.ts`),
        'manifest lists the project working file',
      );
      assert.ok(
        names.includes(`projects/${projectId}/.ai/config.yaml`),
        'manifest lists the .ai/ file',
      );
      const pfProjects = ((manifest['projectFiles'] as Json)['projects'] ?? []) as Array<Json>;
      assert.ok(
        pfProjects.some((p) => String(p['projectId']) === projectId),
        'manifest.projectFiles names the project',
      );
      t.diagnostic(`K1 backup ${backupId} scope=${manifest['scope']}, ${files.length} manifest entries`);

      // Tamper with one backed-up copy → restore must refuse BEFORE
      // touching the live tree.
      const backedCopy = join(backupDir, 'projects', projectId, 'src', 'index.ts');
      appendFileSync(backedCopy, '// TAMPERED BY WALKTHROUGH\n');
      const liveBefore = (await api(port, 'GET', '/api/projects')).body;
      const restore = await api(port, 'POST', '/api/restore/project-files', { backupId });
      assert.equal(restore.status, 422, 'tampered backup → restore refused with 422');
      const liveAfter = (await api(port, 'GET', '/api/projects')).body;
      assert.deepEqual(liveAfter, liveBefore, 'the live project tree is untouched by the refused restore');
      t.diagnostic('K1 tampered backup → 422, live tree untouched');

      // ------------------------------------------------------------ E1 (a) --
      // Package-level env-error chain (Batch 43 true path + Batch 45
      // narrow passthrough): default stepFn, zero custom stepFn. A tool
      // throwing MissingBinaryError 3× → ESCALATED with the ENV code as
      // the stagnation signature; a plain Error keeps the masked
      // 'tool:<name>:fail' signature.
      {
        const loop = new AgentLoop({
          budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 10 },
          stagnationLimit: 3,
        });
        const harness = new Harness({
          allowedRoots: ['/tmp/ai-factory-ws'],
          stepTimeoutMs: 2000,
          permissions: ['filesystem.read', 'filesystem.write', 'shell.execute'],
          toolPermissions: { boom: 'shell.execute' },
          evidence: { collect: () => undefined },
        });
        const envResult = await runAgent({
          agent: makeAgent(),
          task: makeTask(),
          harness,
          adapter: new StubAdapter(boomScript('boom', 6)),
          loop,
          tools: {
            boom: async () => {
              throw new MissingBinaryError('bwrap');
            },
          },
        });
        assert.equal(envResult.outcome, 'escalated');
        assert.equal(envResult.reasonCode, 'LOOP_STAGNATION');
        assert.equal(envResult.stagnationSignature, 'ENV_BINARY_MISSING');
        assert.equal(isEnvErrorCode(envResult.stagnationSignature), true);
        t.diagnostic('E1(a) tool MissingBinaryError 3× → escalated, signature ENV_BINARY_MISSING');

        const loop2 = new AgentLoop({
          budgets: { maxSteps: 40, timeMs: 60_000, maxRetries: 10 },
          stagnationLimit: 3,
        });
        const harness2 = new Harness({
          allowedRoots: ['/tmp/ai-factory-ws'],
          stepTimeoutMs: 2000,
          permissions: ['filesystem.read', 'filesystem.write', 'shell.execute'],
          toolPermissions: { boom2: 'shell.execute' },
          evidence: { collect: () => undefined },
        });
        const plainResult = await runAgent({
          agent: makeAgent(),
          task: makeTask(),
          harness: harness2,
          adapter: new StubAdapter(boomScript('boom2', 6)),
          loop: loop2,
          tools: {
            boom2: async () => {
              throw new Error('plain repeated boom');
            },
          },
        });
        assert.equal(plainResult.outcome, 'escalated');
        assert.equal(plainResult.reasonCode, 'LOOP_STAGNATION');
        assert.equal(plainResult.stagnationSignature, 'tool:boom2:fail');
        assert.equal(isEnvErrorCode(plainResult.stagnationSignature), false);
        t.diagnostic('E1(a) plain Error 3× → signature stays tool:boom2:fail (masking preserved)');
      }

      // ------------------------------------------------------------ E1 (b) --
      // HTTP negative control (Batch 44): a non-env stagnation over the
      // real HTTP surface emits exactly one 'repeated-failure' and zero
      // 'irrecoverable-env-error' for that run.
      {
        const agent = await api(port, 'POST', '/api/agents', { name: 'walk-b46', jobTitle: 'Engineer' });
        assert.equal(agent.status, 201);
        const project = await api(port, 'POST', '/api/projects', { name: 'walk-b46-run' });
        assert.equal(project.status, 201);
        const task = await api(port, 'POST', '/api/tasks', {
          projectId: project.body['id'],
          title: 'walk-b46-env',
          goal: 'pin the env-error HTTP boundary',
        });
        assert.equal(task.status, 201);
        const script = Array.from({ length: 4 }, (_, i) => ({
          text: `broken step ${i}`,
          toolCalls: [{ tool: 'no-such-tool-walk-b46', args: {} }],
        }));
        const run = await api(port, 'POST', '/api/runtime/runs', {
          agentId: agent.body['id'],
          taskId: task.body['id'],
          script,
        });
        assert.equal(run.status, 202);
        const runId = String(run.body['id']);
        const deadline = Date.now() + 60_000;
        let rec: Json = {};
        for (;;) {
          const r = await api(port, 'GET', `/api/runtime/runs/${runId}`);
          assert.equal(r.status, 200);
          rec = r.body;
          if (rec['status'] !== 'RUNNING') break;
          if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in 60000ms`);
          await new Promise((r2) => setTimeout(r2, 200));
        }
        assert.equal(rec['status'], 'ESCALATED', 'unknown-tool 3× → run escalates');
        upgrades = await openNeedsHuman(port);
        const runUpgrades = upgrades.filter(
          (u) => String(u['source'] ?? '') === `runtime-run:${runId}`,
        );
        assert.equal(runUpgrades.length, 1, 'exactly one upgrade record for the run');
        assert.equal(runUpgrades[0]!['reason'], 'repeated-failure');
        assert.ok(
          !runUpgrades.some((u) => u['reason'] === 'irrecoverable-env-error'),
          'the env gate stays silent on a non-env stagnation signature',
        );
        t.diagnostic(`E1(b) non-env stagnation → 1× repeated-failure, 0× irrecoverable-env-error (run ${runId.slice(0, 8)}…)`);
      }

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await killServer(server);
      rmSync(dir, { recursive: true, force: true });
      if (projDir) rmSync(projDir, { recursive: true, force: true });
      if (projectsRoot) rmSync(projectsRoot, { recursive: true, force: true });
    }
  });
});
