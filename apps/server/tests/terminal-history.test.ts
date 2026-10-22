/**
 * Terminal command history (R4-A8) — server e2e.
 *
 * Boots the real server binary (dist/index.js) over a temp dir with
 * AI_FACTORY_DATA_DIR pointed at the temp dir, then:
 *   - creates a bash session (shell integration wraps it);
 *   - runs commands through POST /input;
 *   - asserts GET /sessions/:id/commands reports them with REAL exit
 *     codes (0 and 1);
 *   - asserts GET /terminal/history fuzzy-searches across sessions and
 *     that history.jsonl really landed in the data dir (not the repo);
 *   - asserts a /bin/sh session reports integrated:false (honest: no
 *     markers for sh);
 *   - RBAC: viewer may read history, anonymous gets 401.
 *
 * NOTE: boots with FACTORY_EXEC_SANDBOX=0 (like terminal-sessions.test.ts)
 * so session creation does not depend on bwrap; the integration wrapper
 * materializes its rcfile to /tmp, which works sandboxed or not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = 'viewer-termhist-aaa';
const OPERATOR = 'operator-termhist-bbb';

const serverMain = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const serverCwd = fileURLToPath(new URL('..', import.meta.url));

interface Booted {
  child: ChildProcess;
  port: number;
  dir: string;
}

async function bootRealServer(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-termhist-e2e-'));
  const secretsDir = join(dir, 'secrets');
  const port = 27_000 + Math.floor(Math.random() * 15_000);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: join(dir, 'data'),
    FACTORY_SECRETS_DIR: secretsDir,
    FACTORY_API_TOKENS: `viewer:${VIEWER},operator:${OPERATOR}`,
    FACTORY_EXEC_SANDBOX: '0',
  };
  delete env['FACTORY_API_TOKEN'];
  const child = spawn(process.execPath, [serverMain], { cwd: serverCwd, env, stdio: 'ignore' });
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { child, port, dir };
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not come up in time');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

function headers(token?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function createSession(port: number, body: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions`, {
    method: 'POST',
    headers: headers(OPERATOR),
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    assert.fail(`session create: HTTP ${res.status}: ${await res.text()}`);
  }
  const j = (await res.json()) as { id: string };
  return j.id;
}

async function sendInput(port: number, id: string, data: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${id}/input`, {
    method: 'POST',
    headers: headers(OPERATOR),
    body: JSON.stringify({ data }),
  });
  assert.equal(res.status, 200, `input: ${await res.text()}`);
}

interface CmdRecord {
  command: string;
  exitCode: number;
  at: number;
}

async function waitCommands(port: number, id: string, count: number, timeoutMs = 25_000): Promise<CmdRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${id}/commands`, {
      headers: headers(OPERATOR),
    });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { integrated: boolean; commands: CmdRecord[] };
    assert.equal(j.integrated, true, 'bash session must be integrated');
    if (j.commands.length >= count) return j.commands;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} commands; got ${JSON.stringify(j.commands)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe('terminal command history (R4-A8)', () => {
  it('records commands with real exit codes; history persists + searches', async () => {
    const { child, port, dir } = await bootRealServer();
    try {
      const id = await createSession(port, { principal: 'human', cols: 80, rows: 24 });
      await sendInput(port, id, 'echo hello-history-test\n');
      await sendInput(port, id, 'false\n');
      await sendInput(port, id, 'echo multi-cmd-check\n');

      const cmds = await waitCommands(port, id, 3);
      // newest first
      assert.equal(cmds[0].command, 'echo multi-cmd-check');
      assert.equal(cmds[0].exitCode, 0);
      assert.equal(cmds[1].command, 'false');
      assert.equal(cmds[1].exitCode, 1);
      assert.equal(cmds[2].command, 'echo hello-history-test');
      assert.equal(cmds[2].exitCode, 0);
      for (const c of cmds) assert.ok(c.at > 0, 'at timestamp present');

      // cross-session history search (fuzzy)
      {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/terminal/history?q=hello-history&limit=10`,
          { headers: headers(OPERATOR) },
        );
        assert.equal(res.status, 200);
        const j = (await res.json()) as { entries: CmdRecord[]; total: number };
        assert.ok(j.total >= 3, `total=${j.total}`);
        assert.ok(
          j.entries.some((e) => e.command === 'echo hello-history-test' && e.exitCode === 0),
          JSON.stringify(j.entries.map((e) => e.command)),
        );
      }
      // empty query = recent
      {
        const res = await fetch(`http://127.0.0.1:${port}/api/terminal/history?limit=50`, {
          headers: headers(VIEWER),
        });
        assert.equal(res.status, 200);
        const j = (await res.json()) as { entries: CmdRecord[] };
        assert.ok(j.entries.length >= 3);
      }
      // anonymous → 401
      {
        const res = await fetch(`http://127.0.0.1:${port}/api/terminal/history`);
        assert.equal(res.status, 401);
      }

      // the history file really landed in the DATA dir (not the repo)
      const histFile = join(dir, 'data', 'terminal-history', 'history.jsonl');
      assert.ok(existsSync(histFile), `history file exists: ${histFile}`);
      const content = readFileSync(histFile, 'utf8');
      assert.match(content, /hello-history-test/);
      assert.match(content, /"exitCode":1/);

      // close the session; history must survive (file-backed)
      {
        const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${id}`, {
          method: 'DELETE',
          headers: headers(OPERATOR),
        });
        assert.equal(res.status, 200);
      }
      {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/terminal/history?q=multi-cmd-check&limit=5`,
          { headers: headers(OPERATOR) },
        );
        const j = (await res.json()) as { entries: CmdRecord[] };
        assert.ok(j.entries.some((e) => e.command === 'echo multi-cmd-check'));
      }
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sh sessions report integrated:false (no markers, honest)', async () => {
    const { child, port, dir } = await bootRealServer();
    try {
      const id = await createSession(port, { principal: 'human', shell: ['/bin/sh', '-i'] });
      await sendInput(port, id, 'echo sh-probe\n');
      await new Promise((r) => setTimeout(r, 3000)); // let it run
      const res = await fetch(`http://127.0.0.1:${port}/api/terminal/sessions/${id}/commands`, {
        headers: headers(OPERATOR),
      });
      assert.equal(res.status, 200);
      const j = (await res.json()) as { integrated: boolean; commands: CmdRecord[] };
      assert.equal(j.integrated, false);
      assert.deepEqual(j.commands, []);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
