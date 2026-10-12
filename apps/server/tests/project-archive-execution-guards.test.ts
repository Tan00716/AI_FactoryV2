/**
 * Project archive write guard, third wave — Batch 15.
 *
 * Batch 14 guarded the task/approval/review/QA/run surfaces (see
 * project-archive.test.ts and project-archive-guards.test.ts) and
 * left the pipelines/git EXECUTION surfaces unguarded on the record:
 * they hang evidence on tasks. This file pins the same
 * 409 { code: 'PROJECT_ARCHIVED', projectId } refusal — with
 * no-side-effect probes — on:
 *
 *   - POST /api/pipelines            (taskId given)  no record created
 *   - POST /api/pipelines/:id/run                    no stage evidence
 *   - POST /api/pipelines/:id/deploy                 no deployment, no evidence
 *   - POST /api/pipelines/:id/approve                deployment stays parked
 *   - POST /api/pipelines/:id/rollback               deployment not rolled back
 *   - POST /api/git/commit (taskId)                  no commit, no evidence
 *   - POST /api/git/task-branch                      no branch created
 *   - POST /api/git/pr                               no PR (merge stays 404-free path)
 *   - POST /api/git/pr/:id/merge                     no merge, no evidence
 *
 * …and pins the deliberate NON-guarding of the pure repository
 * operations (POST /api/git/branch, /checkout — no task binding):
 * they keep working while the project is archived.
 *
 * History: when this file was written (Batch 15), /pipelines/:id/
 * approve could never complete a resume even for an ACTIVE project —
 * each cicd handler constructed a fresh DeploymentService, and the
 * parked job lived in the instance the /deploy request created — so
 * the active-phase probes could only pin "not a PROJECT_ARCHIVED
 * refusal". Batch 16 fixed that defect (parked jobs live in a
 * module-level registry shared by every service instance), and the
 * probes below now assert the real thing: approve while active
 * resumes the parked deployment to SUCCEEDED.
 *
 * Real compiled server, one boot over a temp DB, plus a real temp
 * git repository for the git surface. The workspace must be built
 * (dist/index.js), like the sibling archive tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'archive-exec-guards-test-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, never> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, never> = {};
  try {
    parsed = JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

interface BootedServer {
  child: ChildProcess;
  port: number;
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(dbFile: string): Promise<BootedServer> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
  };
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
    new Promise<boolean>((r) => s.child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);
  if (!exited) {
    s.child.kill('SIGKILL');
    await new Promise((r) => s.child.once('exit', r));
  }
}

function assertArchivedRefusal(
  r: { status: number; body: Record<string, never> },
  pid: string,
): void {
  assert.equal(r.status, 409);
  assert.equal(r.body['code'], 'PROJECT_ARCHIVED');
  assert.equal(r.body['projectId'], pid);
  assert.equal(typeof r.body['error'], 'string');
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

describe('project archive guard — pipelines & git execution surfaces (Batch 15)', () => {
  it('archived project refuses pipeline and task-bound git writes with no side effects; pure repo ops stay open; unarchive restores', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-server-arch-exec-'));
    const dbFile = join(dir, 'factory.db');
    const repo = join(dir, 'repo');
    let server: BootedServer | undefined;
    try {
      // A real repository for the git surface.
      execFileSync('git', ['init', '-b', 'main', repo]);
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Archive Guard Test');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      git(repo, 'add', 'a.txt');

      server = await bootServer(dbFile);
      const port = server.port;

      // ---------------------------------------------------------- setup
      const p = await api(port, 'POST', '/api/projects', { name: 'ExecGuardMe' });
      assert.equal(p.status, 201);
      const pid = p.body['id'] as unknown as string;

      const t = await api(port, 'POST', '/api/tasks', { projectId: pid, title: 'Exec task' });
      assert.equal(t.status, 201);
      const tid = t.body['id'] as unknown as string;

      const evidenceTotal = async (): Promise<number> => {
        const rep = await api(port, 'GET', `/api/projects/${pid}/final-report`);
        assert.equal(rep.status, 200);
        const report = rep.body['report'] as unknown as {
          extensions: { evidence: { total: number } };
        };
        return report.extensions.evidence.total;
      };
      const pipelineCount = async (): Promise<number> => {
        const list = await api(port, 'GET', '/api/pipelines');
        return (list.body as unknown as unknown[]).length;
      };
      const deploymentCount = async (): Promise<number> => {
        const list = await api(port, 'GET', '/api/deployments');
        return (list.body as unknown as unknown[]).length;
      };
      const branchNames = async (): Promise<string[]> => {
        const r = await api(port, 'GET', `/api/git/branches?repo=${encodeURIComponent(repo)}`);
        assert.equal(r.status, 200);
        return (r.body['all'] as unknown as string[]).slice().sort();
      };
      const logCount = async (): Promise<number> => {
        const r = await api(port, 'GET', `/api/git/log?repo=${encodeURIComponent(repo)}&limit=50`);
        assert.equal(r.status, 200);
        return (r.body as unknown as unknown[]).length;
      };
      const pipelineDeployments = async (
        pipelineId: string,
      ): Promise<Array<Record<string, unknown>>> => {
        const r = await api(port, 'GET', `/api/pipelines/${pipelineId}`);
        assert.equal(r.status, 200);
        return r.body['deployments'] as unknown as Array<Record<string, unknown>>;
      };

      // ------------------------------------------- phase 1: all active
      const ev0 = await evidenceTotal();

      // git commit bound to the task: commits AND hangs evidence.
      const commit1 = await api(port, 'POST', '/api/git/commit', {
        repo,
        message: 'first commit',
        taskId: tid,
      });
      assert.equal(commit1.status, 201);
      assert.ok(commit1.body['evidence']);
      assert.equal(await logCount(), 1);
      const evAfterCommit = await evidenceTotal();
      assert.ok(evAfterCommit > ev0, 'commit added task evidence');

      // Task branch + PR for the task.
      const tb = await api(port, 'POST', '/api/git/task-branch', {
        repo,
        taskId: tid,
        title: 'Exec task',
      });
      assert.equal(tb.status, 201);
      const taskBranch = tb.body['branch'] as unknown as string;
      assert.ok((await branchNames()).includes(taskBranch));

      const pr = await api(port, 'POST', '/api/git/pr', {
        repo,
        taskId: tid,
        sourceBranch: taskBranch,
        targetBranch: 'main',
        title: 'Exec PR',
      });
      assert.equal(pr.status, 201);
      const prId = pr.body['id'] as unknown as string;

      // Pipeline bound to the task: run hangs stage evidence, DEV
      // deploy succeeds with a snapshot, PROD deploy parks on an
      // approval ticket.
      const pl = await api(port, 'POST', '/api/pipelines', { taskId: tid });
      assert.equal(pl.status, 201);
      const pipelineId = pl.body['id'] as unknown as string;
      assert.equal(await pipelineCount(), 1);

      const run1 = await api(port, 'POST', `/api/pipelines/${pipelineId}/run`, {});
      assert.equal(run1.status, 200);
      const evAfterRun = await evidenceTotal();
      assert.ok(evAfterRun > evAfterCommit, 'pipeline run added stage evidence');

      const depDev = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'DEV',
        taskId: tid,
        actor: 'deploy-bot',
      });
      assert.equal(depDev.status, 200);
      assert.equal(
        (depDev.body['deployment'] as Record<string, unknown>)['status'],
        'SUCCEEDED',
      );
      assert.equal(await deploymentCount(), 1);
      const evAfterDeploy = await evidenceTotal();
      assert.ok(evAfterDeploy > evAfterRun, 'deploy added evidence');

      const depProd = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId: tid,
        actor: 'deploy-bot',
      });
      assert.equal(depProd.status, 200);
      assert.ok(depProd.body['pendingApproval']);
      const approval = depProd.body['approval'] as unknown as Record<string, unknown>;
      const approvalId = approval['approval_id'] as string;
      assert.equal(await deploymentCount(), 2);

      // Decide the ticket (requester deploy-bot ≠ decider human).
      const decision = await api(port, 'POST', `/api/approvals/${approvalId}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(decision.status, 200);

      // Approve while ACTIVE: the archive guard must NOT fire, and
      // since Batch 16 the resume itself completes — the parked PROD
      // deployment runs to SUCCEEDED. (Batch 15 could only pin "not a
      // PROJECT_ARCHIVED refusal" here; the assertion was upgraded
      // when the per-instance jobs defect was fixed, see header.)
      const approveActive = await api(port, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId,
      });
      assert.equal(approveActive.status, 200);
      assert.equal(
        (approveActive.body['deployment'] as Record<string, unknown>)['status'],
        'SUCCEEDED',
      );
      const depsActive = await pipelineDeployments(pipelineId);
      assert.equal(
        depsActive.find((d) => d['environment'] === 'PROD')?.['status'],
        'SUCCEEDED',
      );

      // Park a SECOND PROD deployment so the archived phase has a
      // live parked deployment to probe approve/rollback against.
      const depProd2 = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'PROD',
        taskId: tid,
        actor: 'deploy-bot',
      });
      assert.equal(depProd2.status, 200);
      assert.ok(depProd2.body['pendingApproval']);
      const prod2Id = (depProd2.body['deployment'] as Record<string, unknown>)['id'] as unknown as string;
      const approval2 = depProd2.body['approval'] as unknown as Record<string, unknown>;
      const approvalId2 = approval2['approval_id'] as string;
      assert.equal(await deploymentCount(), 3);
      const decision2 = await api(port, 'POST', `/api/approvals/${approvalId2}/decision`, {
        approved: true,
        decided_by: 'human',
      });
      assert.equal(decision2.status, 200);

      // Evidence baseline for the archived phase, taken only now:
      // the approval DECISIONs above auto-attach `approval` evidence
      // records to the task, so any earlier total is stale.
      const evPhase1 = await evidenceTotal();

      // --------------------------------------------- phase 2: archived
      const arch = await api(port, 'POST', `/api/projects/${pid}/archive`, {});
      assert.equal(arch.status, 200);
      assert.equal(arch.body['changed'], true);

      // Stage a second change so a commit COULD happen if unguarded.
      writeFileSync(join(repo, 'b.txt'), 'two\n');
      git(repo, 'add', 'b.txt');

      const branchesBefore = await branchNames();
      const logsBefore = await logCount();

      const commitArchived = await api(port, 'POST', '/api/git/commit', {
        repo,
        message: 'second commit',
        taskId: tid,
      });
      assertArchivedRefusal(commitArchived, pid);
      assert.equal(await logCount(), logsBefore, 'no commit was created');
      assert.equal(await evidenceTotal(), evPhase1, 'no evidence was created');

      const tbArchived = await api(port, 'POST', '/api/git/task-branch', {
        repo,
        taskId: tid,
        title: 'Another title',
      });
      assertArchivedRefusal(tbArchived, pid);
      assert.deepEqual(await branchNames(), branchesBefore, 'no branch was created');

      const prArchived = await api(port, 'POST', '/api/git/pr', {
        repo,
        taskId: tid,
        sourceBranch: taskBranch,
        targetBranch: 'main',
        title: 'Second PR',
      });
      assertArchivedRefusal(prArchived, pid);

      const mergeArchived = await api(port, 'POST', `/api/git/pr/${prId}/merge`, { repo });
      assertArchivedRefusal(mergeArchived, pid);
      assert.equal(await logCount(), logsBefore, 'no merge commit was created');
      assert.equal(await evidenceTotal(), evPhase1, 'no merge evidence was created');

      const plArchived = await api(port, 'POST', '/api/pipelines', { taskId: tid });
      assertArchivedRefusal(plArchived, pid);
      assert.equal(await pipelineCount(), 1, 'no pipeline record was created');

      const runArchived = await api(port, 'POST', `/api/pipelines/${pipelineId}/run`, {});
      assertArchivedRefusal(runArchived, pid);
      assert.equal(await evidenceTotal(), evPhase1, 'no stage evidence was created');

      const depArchived = await api(port, 'POST', `/api/pipelines/${pipelineId}/deploy`, {
        environment: 'DEV',
        taskId: tid,
      });
      assertArchivedRefusal(depArchived, pid);
      assert.equal(await deploymentCount(), 3, 'no deployment was created');
      assert.equal(await evidenceTotal(), evPhase1);

      const approveArchived = await api(port, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId: approvalId2,
      });
      assertArchivedRefusal(approveArchived, pid);
      const depsArchived = await pipelineDeployments(pipelineId);
      assert.equal(
        depsArchived.find((d) => d['id'] === prod2Id)?.['status'],
        'AWAITING_APPROVAL',
        'parked deployment was not resumed',
      );

      const rollbackArchived = await api(port, 'POST', `/api/pipelines/${pipelineId}/rollback`, {});
      assertArchivedRefusal(rollbackArchived, pid);
      const depsAfterRollbackAttempt = await pipelineDeployments(pipelineId);
      assert.ok(
        depsAfterRollbackAttempt.every((d) => d['status'] !== 'ROLLED_BACK'),
        'no deployment was rolled back',
      );

      // Deliberately UNGUARDED pure repository operations still work.
      const freeBranch = await api(port, 'POST', '/api/git/branch', {
        repo,
        name: 'free-branch',
      });
      assert.equal(freeBranch.status, 201);
      assert.ok((await branchNames()).includes('free-branch'));
      const checkout = await api(port, 'POST', '/api/git/checkout', { repo, ref: 'main' });
      assert.equal(checkout.status, 200);
      const status = await api(port, 'GET', `/api/git/status?repo=${encodeURIComponent(repo)}`);
      assert.equal(status.status, 200);

      // ------------------------------------------- phase 3: unarchived
      const un = await api(port, 'POST', `/api/projects/${pid}/unarchive`, {});
      assert.equal(un.status, 200);
      assert.equal(un.body['changed'], true);

      // The change staged in phase 2 commits now.
      const commit2 = await api(port, 'POST', '/api/git/commit', {
        repo,
        message: 'second commit',
        taskId: tid,
      });
      assert.equal(commit2.status, 201);
      assert.equal(await logCount(), logsBefore + 1);
      assert.ok((await evidenceTotal()) > evPhase1);

      // A pipeline that already ran is terminal (the runner refuses
      // a second run with a lifecycle 409 of its own), so the
      // recovery probe creates and runs a fresh pipeline instead.
      const pl2 = await api(port, 'POST', '/api/pipelines', { taskId: tid });
      assert.equal(pl2.status, 201);
      const run2 = await api(port, 'POST', `/api/pipelines/${pl2.body['id'] as unknown as string}/run`, {});
      assert.equal(run2.status, 200);

      // Guard lifted on approve: the second parked PROD deployment
      // (approved ticket from phase 1) resumes and completes.
      const approveAfter = await api(port, 'POST', `/api/pipelines/${pipelineId}/approve`, {
        approvalId: approvalId2,
      });
      assert.equal(approveAfter.status, 200);
      assert.equal(
        (approveAfter.body['deployment'] as Record<string, unknown>)['status'],
        'SUCCEEDED',
      );

      const rollback = await api(port, 'POST', `/api/pipelines/${pipelineId}/rollback`, {});
      assert.equal(rollback.status, 200);
      assert.equal(
        (rollback.body['deployment'] as Record<string, unknown>)['status'],
        'ROLLED_BACK',
      );

      const merge = await api(port, 'POST', `/api/git/pr/${prId}/merge`, { repo });
      assert.equal(merge.status, 200);
      assert.ok(merge.body['evidence'], 'merge evidence attached after unarchive');

      await stopServer(server);
      server = undefined;
    } finally {
      if (server) await stopServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
