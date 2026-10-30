/**
 * Language-service HTTP tests — boots the real server (dist) with an
 * isolated DB and exercises the whole feature end to end:
 *
 *   GET  /api/langsrv/status          semantic tier state
 *   POST /api/langsrv/definition      cross-file import → declaration (semantic)
 *   POST /api/langsrv/references      definition + import + call site
 *   POST /api/langsrv/hover           signature text
 *   POST /api/langsrv/outline         function + variable symbols
 *   POST /api/langsrv/rename-preview  edits computed, files untouched
 *   errors: out-of-range 400, outside-root 403, outside-allowlist 403
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/langsrv-routes.test.ts
 * (requires a server build first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  codeDir: string;
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
      const port = (addr as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-langsrv-http-'));
  const codeDir = path.join(dir, 'code');
  fs.mkdirSync(codeDir, { recursive: true });
  fs.writeFileSync(path.join(codeDir, 'a.ts'), [
    "export function greet(name: string): string {",
    "  return `hi ${name}`;",
    "}",
    "export const VERSION = '1.0.0';",
    "",
  ].join('\n'));
  fs.writeFileSync(path.join(codeDir, 'b.ts'), [
    "import { greet, VERSION } from './a';",
    "export function run(): string {",
    "  return greet(VERSION);",
    "}",
    "",
  ].join('\n'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_CODEINDEX_ROOTS: codeDir,
    FACTORY_ALLOW_OPEN_LOCAL: '1',
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('server did not start in 30s');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => {
          s.end();
          resolve();
        });
        s.once('error', reject);
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { port, proc, dir, codeDir };
}

async function stopServer(r: Running): Promise<void> {
  r.proc.kill('SIGKILL');
  await new Promise((resolve) => r.proc.once('exit', resolve));
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('langsrv end to end over HTTP', async () => {
  const srv = await startServer();
  try {
    let r = await api(srv.port, 'GET', '/api/langsrv/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.status.lspConfigured, false);

    r = await api(srv.port, 'POST', '/api/langsrv/definition', {
      root: srv.codeDir, file: 'b.ts', line: 2, character: 10,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'semantic');
    assert.equal(r.body.locations.length, 1);
    assert.equal(r.body.locations[0].file, 'a.ts');
    assert.equal(r.body.locations[0].line, 0);

    r = await api(srv.port, 'POST', '/api/langsrv/references', {
      root: srv.codeDir, file: 'a.ts', line: 0, character: 17,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'semantic');
    assert.ok(r.body.references.length >= 3);
    assert.ok(r.body.references.some((x: any) => x.isDefinition));

    r = await api(srv.port, 'POST', '/api/langsrv/hover', {
      root: srv.codeDir, file: 'b.ts', line: 2, character: 10,
    });
    assert.equal(r.status, 200);
    assert.match(r.body.hover.display, /greet/);

    r = await api(srv.port, 'POST', '/api/langsrv/outline', {
      root: srv.codeDir, file: 'a.ts',
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.symbols.some((s: any) => s.name === 'greet' && s.kind === 'function'));
    assert.ok(r.body.symbols.some((s: any) => s.name === 'VERSION' && s.kind === 'variable'));

    const before = fs.readFileSync(path.join(srv.codeDir, 'a.ts'), 'utf8');
    r = await api(srv.port, 'POST', '/api/langsrv/rename-preview', {
      root: srv.codeDir, file: 'a.ts', line: 0, character: 17, newName: 'greet2',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.oldName, 'greet');
    assert.ok(r.body.edits.length >= 3);
    assert.equal(fs.readFileSync(path.join(srv.codeDir, 'a.ts'), 'utf8'), before);

    r = await api(srv.port, 'POST', '/api/langsrv/definition', {
      root: srv.codeDir, file: 'a.ts', line: 99, character: 0,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'POSITION_OUT_OF_RANGE');

    r = await api(srv.port, 'POST', '/api/langsrv/definition', {
      root: srv.codeDir, file: '../escape.ts', line: 0, character: 0,
    });
    assert.equal(r.status, 403);

    r = await api(srv.port, 'POST', '/api/langsrv/definition', {
      root: '/tmp', file: 'x.ts', line: 0, character: 0,
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'ROOT_DENIED');
  } finally {
    await stopServer(srv);
  }
});
