/**
 * Batch 33 — §6.1 project-record fields + Clone Repository entry point.
 *
 * Real server (compiled dist) + real git repos:
 *
 *   POST /api/projects        accepts the §6.1 record fields verbatim
 *                             (scalars as strings, refs as string arrays;
 *                             wrong shapes → 400; absent → null/[])
 *   GET  /api/projects/:id   full record, 404 when missing
 *   POST /api/projects/clone  {url, name?, dir?, branch?} → real
 *                             `git clone` into the dir + project record
 *                             with repository_refs=[url]
 *     - non-empty dir reuse → 409 PROJECT_DIR_NOT_EMPTY
 *     - invalid/ssh/-prefixed source → 400 (no clone attempted)
 *     - failed clone → 502, no project row
 *
 *   - §6.1 fields survive a true SIGKILL restart (records, not memory).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = 'projects-records-33-test-token-0123456789';

async function api(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

async function bootServer(
  dbFile: string,
  secretsDir: string,
): Promise<{ child: ChildProcess; port: number }> {
  const port = 24_000 + Math.floor(Math.random() * 20_000);
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv['FACTORY_BUILD_COMMAND'];
  delete baseEnv['FACTORY_GIT_BROKER_ACTIONS'];
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PORT: String(port),
    DB_PATH: dbFile,
    FACTORY_API_TOKEN: TOKEN,
    FACTORY_SECRETS_DIR: secretsDir,
  };
  const child = spawn(process.execPath, [serverMain], {
    cwd: serverCwd,
    env,
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return { child, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('server did not boot');
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/** Real local git repo to clone from (no network needed). */
function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-clonesrc-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-qm', 'fixture']);
  return dir;
}

const SECTION_FIELDS = [
  'organization_id', 'profile_version', 'repository_refs', 'workspace_refs',
  'instruction_refs', 'policy_version', 'default_manager_id', 'workflow_version',
  'environment_refs', 'data_classification', 'lifecycle_state',
];

describe('§6.1 project records + clone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'projects-rec33-'));
  let srv: { child: ChildProcess; port: number } | null = null;

  after(() => {
    srv?.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots', async () => {
    srv = await bootServer(join(dir, 'factory.db'), join(dir, 'secrets'));
    assert.ok(srv.port > 0);
  });

  it('POST /api/projects accepts §6.1 fields verbatim and reads them back', async () => {
    const r = await api(srv!.port, 'POST', '/api/projects', {
      name: 'fields-proj',
      organization_id: 'org-9',
      profile_version: 'v3',
      repository_refs: ['https://example.com/a.git'],
      workspace_refs: ['ws-a'],
      instruction_refs: ['in-a'],
      policy_version: 'pv-1',
      default_manager_id: 'mgr-1',
      workflow_version: 'wv-1',
      environment_refs: ['env-a'],
      data_classification: 'internal',
      lifecycle_state: 'active',
    });
    assert.equal(r.status, 201);
    const p = r.body;
    assert.equal(p.organization_id, 'org-9');
    assert.equal(p.profile_version, 'v3');
    assert.deepEqual(p.repository_refs, ['https://example.com/a.git']);
    assert.deepEqual(p.workspace_refs, ['ws-a']);
    assert.deepEqual(p.instruction_refs, ['in-a']);
    assert.equal(p.policy_version, 'pv-1');
    assert.equal(p.default_manager_id, 'mgr-1');
    assert.equal(p.workflow_version, 'wv-1');
    assert.deepEqual(p.environment_refs, ['env-a']);
    assert.equal(p.data_classification, 'internal');
    assert.equal(p.lifecycle_state, 'active');

    const got = await api(srv!.port, 'GET', `/api/projects/${p.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.project, p);
  });

  it('absent §6.1 fields stay null/[]; wrong shapes are 400', async () => {
    const r = await api(srv!.port, 'POST', '/api/projects', { name: 'bare-proj' });
    assert.equal(r.status, 201);
    for (const f of SECTION_FIELDS) {
      if (f.endsWith('_refs')) assert.deepEqual(r.body[f], [], f);
      else assert.equal(r.body[f], null, f);
    }
    const bad1 = await api(srv!.port, 'POST', '/api/projects', {
      name: 'bad1', policy_version: 42,
    });
    assert.equal(bad1.status, 400);
    const bad2 = await api(srv!.port, 'POST', '/api/projects', {
      name: 'bad2', repository_refs: 'not-an-array',
    });
    assert.equal(bad2.status, 400);
  });

  it('GET /api/projects/:id 404s on missing', async () => {
    const r = await api(srv!.port, 'GET', '/api/projects/no-such-id');
    assert.equal(r.status, 404);
  });

  it('clone: real git clone from a local fixture repo, recorded honestly', async () => {
    const src = makeSourceRepo();
    const target = join(dir, 'cloned-proj');
    const r = await api(srv!.port, 'POST', '/api/projects/clone', {
      url: src,
      name: 'cloned',
      dir: target,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    const p = r.body.project;
    assert.deepEqual(p.repository_refs, [src]);
    assert.equal(p.path, target);
    assert.equal(p.name, 'cloned');
    // The clone really happened on disk.
    assert.ok(readdirSync(target).includes('.git'));
    // Audit recorded the clone.
    const audit = await api(srv!.port, 'GET', '/api/audit');
    assert.ok(
      (audit.body.items ?? audit.body).some(
        (e: any) => e.action === 'PROJECT_CLONED' && e.entityId === p.id,
      ),
      'PROJECT_CLONED audit present',
    );
  });

  it('clone refuses a non-empty directory with 409', async () => {
    const src = makeSourceRepo();
    const target = join(dir, 'nonempty');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'existing.txt'), 'do not overwrite');
    const r = await api(srv!.port, 'POST', '/api/projects/clone', {
      url: src,
      name: 'refused',
      dir: target,
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PROJECT_DIR_NOT_EMPTY');
    // The existing content was not touched.
    assert.ok(readdirSync(target).includes('existing.txt'));
    assert.ok(!readdirSync(target).includes('.git'));
  });

  it('clone rejects invalid sources without attempting', async () => {
    const target = join(dir, 'never');
    for (const url of ['notaurl', '-evil', 'git@github.com:x/y.git', 'ftp://x/y']) {
      const r = await api(srv!.port, 'POST', '/api/projects/clone', { url, dir: target });
      assert.equal(r.status, 400, `expected 400 for ${url}, got ${r.status}`);
    }
  });

  it('clone failure → 502 and no project row', async () => {
    const before = (await api(srv!.port, 'GET', '/api/projects')).body;
    const r = await api(srv!.port, 'POST', '/api/projects/clone', {
      url: join(dir, 'does-not-exist-repo'),
      name: 'failed-clone',
      dir: join(dir, 'failed-target'),
    });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'CLONE_FAILED');
    const after = (await api(srv!.port, 'GET', '/api/projects')).body;
    assert.equal(after.length, before.length);
    assert.ok(!after.some((p: any) => p.name === 'failed-clone'));
  });

  it('§6.1 fields survive a true SIGKILL restart', async () => {
    const created = await api(srv!.port, 'POST', '/api/projects', {
      name: 'restart-proj',
      organization_id: 'org-restart',
      repository_refs: ['https://example.com/r.git'],
      lifecycle_state: 'active',
    });
    const id = created.body.id;
    srv!.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    srv = await bootServer(join(dir, 'factory.db'), join(dir, 'secrets'));
    const got = await api(srv.port, 'GET', `/api/projects/${id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.project.organization_id, 'org-restart');
    assert.deepEqual(got.body.project.repository_refs, ['https://example.com/r.git']);
    assert.equal(got.body.project.lifecycle_state, 'active');
  });
});
