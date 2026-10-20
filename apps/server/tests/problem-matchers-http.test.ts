/**
 * Problem matchers — HTTP integration tests (task ③) — boots the real
 * server (dist) with an isolated DB + data dir:
 *   GET  /api/problem-matchers            → builtins + default enabled set
 *   POST /api/problem-matchers/test       → dry-run parse, nothing stored
 *   POST /api/problem-matchers/collect    → inline text parsed + stored
 *   GET  /api/problem-matchers/diagnostics → stored snapshot + stats
 *   PUT  /api/problem-matchers            → custom matcher, then used by /test
 *   PUT  invalid custom                   → 400 with reasons
 *   POST /api/quality/run (lint emits tsc errors) → gate output AUTO-parsed
 *        into diagnostics (source 'quality-gate') via the output sink
 *   POST /api/context-providers/resolve "@problems" → resolved context
 *        includes the matcher diagnostics (task ⑥ regression guard)
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/problem-matchers-http.test.ts
 * (requires `npm run build` first — the server boots from dist).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-pm-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_CODEINDEX_ROOTS: dir,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
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

async function api(s: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const TSC_SAMPLE = [
  "src/app.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  'src/lib/util.ts(3,15): warning TS6133: unused variable.',
  'npm notice nothing to see here',
].join('\n');

test('problem matchers HTTP lifecycle + quality-gate auto-parse + @problems feed', async () => {
  const s = await startServer();
  try {
    // Config: builtins listed, defaults enabled.
    const cfg = await api(s, 'GET', '/api/problem-matchers?projectId=pm-proj');
    assert.equal(cfg.status, 200);
    const names = (cfg.body.builtins as Array<{ name: string }>).map((b) => b.name);
    assert.deepEqual(names, ['$tsc', '$eslint', '$go', '$node-test', '$vitest', '$stacktrace']);
    assert.ok((cfg.body.enabled as string[]).includes('$tsc'));

    // Dry-run: parses, stores nothing.
    const dry = await api(s, 'POST', '/api/problem-matchers/test', {
      projectId: 'pm-proj',
      text: TSC_SAMPLE,
    });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.diagnostics.length, 2);
    assert.equal(dry.body.stats.matchedLines, 2);
    assert.equal(dry.body.stats.skippedLines, 1);
    const afterDry = await api(s, 'GET', '/api/problem-matchers/diagnostics?projectId=pm-proj');
    assert.equal(afterDry.body.diagnostics.length, 0);

    // Collect inline text → stored with source 'manual'.
    const col = await api(s, 'POST', '/api/problem-matchers/collect', {
      projectId: 'pm-proj',
      source: 'manual',
      text: TSC_SAMPLE,
    });
    assert.equal(col.status, 200);
    assert.equal(col.body.added, 2);
    const stored = await api(s, 'GET', '/api/problem-matchers/diagnostics?projectId=pm-proj');
    assert.equal(stored.body.diagnostics.length, 2);
    assert.equal(stored.body.diagnostics[0].source, 'manual');
    assert.ok(stored.body.lastStats.manual, 'parse stats recorded');

    // @problems sees the matcher diagnostics (task ⑥ feed).
    const resolved = await api(s, 'POST', '/api/context-providers/resolve', {
      text: 'please fix @problems',
      projectId: 'pm-proj',
    });
    assert.equal(resolved.status, 200);
    assert.ok(
      (resolved.body.text as string).includes('src/app.ts:12:7'),
      'resolved @problems text carries the file:line:col diagnostic',
    );

    // Invalid custom matcher → 400 with a reason (not silent).
    const bad = await api(s, 'PUT', '/api/problem-matchers', {
      projectId: 'pm-proj',
      enabled: ['broken'],
      customs: { broken: { patterns: [{ regexp: '(?<file', file: 'file', line: 1 }] } },
    });
    assert.equal(bad.status, 400);
    assert.ok(String(bad.body.error).includes('does not compile'));

    // Valid custom matcher → dry-run uses it.
    const put = await api(s, 'PUT', '/api/problem-matchers', {
      projectId: 'pm-proj',
      enabled: ['team-check'],
      customs: {
        'team-check': {
          description: 'team format',
          patterns: [
            { regexp: '^TEAM (?<file>\\S+):(?<line>\\d+) (?<message>.*)$', file: 'file', line: 'line', message: 'message' },
          ],
        },
      },
    });
    assert.equal(put.status, 200);
    const customDry = await api(s, 'POST', '/api/problem-matchers/test', {
      projectId: 'pm-proj',
      matcher: 'team-check',
      text: 'TEAM src/x.ts:42 something broke',
    });
    assert.equal(customDry.status, 200);
    assert.equal(customDry.body.diagnostics.length, 1);
    assert.equal(customDry.body.diagnostics[0].line, 42);

    // Quality gate: lintCmd emits tsc errors → auto-parsed on run.
    // (Separate project: pm-proj's config was replaced above with only
    // the team-check matcher, which correctly does NOT match tsc lines.)
    const qput = await api(s, 'PUT', '/api/quality', {
      projectId: 'pm-gate',
      lintCmd: "printf \"src/gate.ts(5,9): error TS2304: Cannot find name 'nope'.\\n\"; exit 1",
      testCmd: '',
      timeoutMs: 30000,
      runOnEdit: false,
      blockOnFailure: false,
    });
    assert.equal(qput.status, 200);
    const run = await api(s, 'POST', '/api/quality/run', { projectId: 'pm-gate', kind: 'lint' });
    assert.equal(run.status, 200);
    const gateDiags = await api(
      s,
      'GET',
      '/api/problem-matchers/diagnostics?projectId=pm-gate&source=quality-gate',
    );
    assert.equal(gateDiags.body.diagnostics.length, 1, JSON.stringify(gateDiags.body, null, 2));
    assert.ok(gateDiags.body.diagnostics[0].file.includes('src/gate.ts'));
    assert.equal(gateDiags.body.diagnostics[0].line, 5);

    // Clear works.
    const clr = await api(s, 'POST', '/api/problem-matchers/clear', { projectId: 'pm-proj' });
    assert.equal(clr.status, 200);
    const afterClear = await api(s, 'GET', '/api/problem-matchers/diagnostics?projectId=pm-proj');
    assert.equal(afterClear.body.diagnostics.length, 0);
  } finally {
    await stopServer(s);
  }
});
