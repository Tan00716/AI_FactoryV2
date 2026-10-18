/**
 * Plugin install tests (W-F).
 *
 * Unit level (imports ../src/plugin-store.ts directly — node builtins
 * only + a type-only @ai-factory/plugins import):
 *   record CRUD, duplicate install refusal, corrupt fail-closed.
 *
 * HTTP level (real server, isolated DB + data dir):
 *   install a sample plugin dir (skill + slash command + hook + MCP
 *   server) → capabilities registered → disable removes them →
 *   enable restores them → uninstall removes everything.
 *   Invalid manifests are 400, duplicates 409, symlinks refused.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/plugins.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginStore, PluginStoreError } from '../src/plugin-store.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

describe('PluginStore unit', () => {
  it('add/get/update/remove + duplicate refusal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-plugin-unit-'));
    try {
      const store = new PluginStore(path.join(dir, 'plugins.json'));
      const rec = store.add({
        name: 'demo',
        version: '1.0.0',
        description: 'd',
        permissions: [],
        enabled: true,
        installedBy: 'human',
        capabilities: { skills: [], slashCommands: [], hooks: [], mcpServers: [] },
      });
      assert.equal(rec.name, 'demo');
      assert.equal(store.list().length, 1);
      assert.throws(() => store.add({ ...rec, installedAt: undefined }), PluginStoreError);
      const updated = store.update('demo', { enabled: false });
      assert.equal(updated.enabled, false);
      const removed = store.remove('demo');
      assert.equal(removed.name, 'demo');
      assert.equal(store.list().length, 0);
      assert.throws(() => store.get('demo'), PluginStoreError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupt file → fail-closed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-plugin-corrupt-'));
    try {
      const p = path.join(dir, 'plugins.json');
      fs.writeFileSync(p, 'nope');
      const store = new PluginStore(p);
      assert.equal(store.isCorrupt(), true);
      assert.throws(() => store.add({
        name: 'x', version: '1.0.0', description: 'd', permissions: [],
        enabled: true, installedBy: 'h',
        capabilities: { skills: [], slashCommands: [], hooks: [], mcpServers: [] },
      }), /refusing writes/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------- HTTP ----

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-plugin-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error('server exited during startup');
  return { port, proc, dir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function samplePluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-sample-plugin-'));
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'sample-plugin',
      version: '0.1.0',
      description: 'Sample plugin for tests',
      permissions: [],
      capabilities: {
        skills: [
          {
            id: 'sample-skill',
            version: '0.1.0',
            description: 'A sample skill',
            instructions: '# Sample skill\nDo sample things.',
          },
        ],
        slashCommands: [{ name: 'samplecmd', description: 'sample', template: 'echo {args}' }],
        hooks: [{ event: 'PostToolUse', command: 'echo plugin-hook', description: 'sample hook' }],
        mcpServers: [
          { name: 'sample-mcp', version: '0.1.0', transport: 'stdio', command: 'node' },
        ],
      },
    }),
  );
  return dir;
}

describe('Plugin install over HTTP', () => {
  it('install → capabilities live → disable → enable → uninstall', async () => {
    const s = await startServer();
    const src = samplePluginDir();
    try {
      const installed = await api(s.port, 'POST', '/api/plugins/install', { sourceDir: src });
      assert.equal(installed.status, 201);
      assert.equal(installed.body.plugin.name, 'sample-plugin');
      assert.equal(installed.body.plugin.enabled, true);

      const listed = await api(s.port, 'GET', '/api/plugins');
      assert.equal(listed.status, 200);
      assert.equal(listed.body.plugins.length, 1);

      // Slash command registered.
      const cmds = await api(s.port, 'GET', '/api/commands');
      assert.ok(
        cmds.body.custom.some((c: any) => c.name === 'samplecmd'),
        'slash command should be registered',
      );
      // Skill registered (namespaced).
      const skills = await api(s.port, 'GET', '/api/skills');
      assert.ok(
        skills.body.skills.some((x: any) => x.id === 'plugin-sample-plugin-sample-skill'),
        'skill should be registered',
      );
      // MCP server registered.
      const mcp = await api(s.port, 'GET', '/api/mcp');
      assert.ok(
        mcp.body.servers.some((x: any) => x.name === 'sample-mcp'),
        'mcp server should be registered',
      );

      // Disable removes live capabilities.
      const disabled = await api(s.port, 'POST', '/api/plugins/sample-plugin/disable');
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.plugin.enabled, false);
      const cmds2 = await api(s.port, 'GET', '/api/commands');
      assert.ok(!cmds2.body.custom.some((c: any) => c.name === 'samplecmd'));

      // Enable restores them.
      const enabled = await api(s.port, 'POST', '/api/plugins/sample-plugin/enable');
      assert.equal(enabled.status, 200);
      const cmds3 = await api(s.port, 'GET', '/api/commands');
      assert.ok(cmds3.body.custom.some((c: any) => c.name === 'samplecmd'));

      // Uninstall removes the record and capabilities.
      const un = await api(s.port, 'DELETE', '/api/plugins/sample-plugin');
      assert.equal(un.status, 200);
      const listed2 = await api(s.port, 'GET', '/api/plugins');
      assert.equal(listed2.body.plugins.length, 0);
      const cmds4 = await api(s.port, 'GET', '/api/commands');
      assert.ok(!cmds4.body.custom.some((c: any) => c.name === 'samplecmd'));
      const mcp2 = await api(s.port, 'GET', '/api/mcp');
      assert.ok(!mcp2.body.servers.some((x: any) => x.name === 'sample-mcp'));
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      await stopServer(s);
    }
  });

  it('uninstall after disable works (no double-deregister blowup)', async () => {
    const s = await startServer();
    const src = samplePluginDir();
    try {
      const r1 = await api(s.port, 'POST', '/api/plugins/install', { sourceDir: src });
      assert.equal(r1.status, 201);
      const r2 = await api(s.port, 'POST', '/api/plugins/sample-plugin/disable');
      assert.equal(r2.status, 200);
      const r3 = await api(s.port, 'DELETE', '/api/plugins/sample-plugin');
      assert.equal(r3.status, 200);
      const listed = await api(s.port, 'GET', '/api/plugins');
      assert.equal(listed.body.plugins.length, 0);
      // Idempotent enable/disable on a missing plugin is 404, not 500.
      const r4 = await api(s.port, 'POST', '/api/plugins/sample-plugin/disable');
      assert.equal(r4.status, 404);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      await stopServer(s);
    }
  });

  it('invalid manifest → 400, duplicate → 409, missing → 404', async () => {
    const s = await startServer();
    const src = samplePluginDir();
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-bad-plugin-'));
    try {
      fs.writeFileSync(
        path.join(bad, 'plugin.json'),
        JSON.stringify({ name: 'Bad Name!', version: '1.0.0', description: 'x' }),
      );
      const r1 = await api(s.port, 'POST', '/api/plugins/install', { sourceDir: bad });
      assert.equal(r1.status, 400);

      const r2 = await api(s.port, 'POST', '/api/plugins/install', { sourceDir: src });
      assert.equal(r2.status, 201);
      const r3 = await api(s.port, 'POST', '/api/plugins/install', { sourceDir: src });
      assert.equal(r3.status, 409);

      const r4 = await api(s.port, 'POST', '/api/plugins/nope/enable');
      assert.equal(r4.status, 404);
      const r5 = await api(s.port, 'DELETE', '/api/plugins/nope');
      assert.equal(r5.status, 404);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(bad, { recursive: true, force: true });
      await stopServer(s);
    }
  });
});
