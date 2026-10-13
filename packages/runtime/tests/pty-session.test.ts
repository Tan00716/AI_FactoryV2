/**
 * Interactive PTY session tests (Batch 19, §50.1).
 *
 * Pinned behaviors:
 *   - session lifecycle: create → write → read echoed output → close;
 *   - live resize over the control pipe is REAL: `stty size` inside
 *     the session reads the new dimensions back (Batch 18's missing
 *     SIGWINCH channel, now delivered);
 *   - close() kills the whole tree: the supervisor pid is gone and no
 *     child survives;
 *   - principal isolation: 'ai' sessions line-gate every input line
 *     through the injected policy; denied lines never reach the pty
 *     and are reported via onDenied;
 *   - concurrent sessions never cross streams.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PtySession,
  PtySessionManager,
  PtySessionUnavailableError,
} from '../src/pty-session';

const SHELL = ['/bin/sh'];

function backendOk(): boolean {
  if (process.platform === 'win32') return false;
  try {
    const p = spawnSync('python3', ['-c', 'import pty, termios, fcntl'], { timeout: 5_000 });
    return p.status === 0;
  } catch {
    return false;
  }
}

/** Collect output until `needle` appears or the timeout fires. */
async function waitFor(
  session: PtySession,
  needle: string,
  timeoutMs = 8_000,
): Promise<string> {
  let buf = session.transcriptText();
  if (buf.includes(needle)) return buf;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got: ${JSON.stringify(buf.slice(-300))}`));
    }, timeoutMs);
    const unsub = session.onOutput((chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes(needle)) {
        clearTimeout(timer);
        unsub();
        resolve(buf);
      }
    });
  });
}

async function waitExitIdle(session: PtySession, ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  assert.equal(session.alive, true, 'session should still be alive');
}

describe('pty-session (interactive PTY sessions)', { skip: !backendOk() }, () => {

  it('fails closed when the backend cannot run', () => {
    assert.throws(
      () => PtySession.create({ principal: 'human', shell: SHELL, pythonPath: '/nonexistent-python-xyz' }),
      (e: unknown) => e instanceof PtySessionUnavailableError,
    );
  });

  it('lifecycle: create → write → read → close', async () => {
    const s = PtySession.create({ principal: 'human', shell: SHELL, rows: 24, cols: 80 });
    assert.equal(s.principal, 'human');
    assert.equal(s.rows, 24);
    assert.equal(s.cols, 80);
    assert.equal(s.alive, true);

    s.write('echo hello-session\n');
    const out = await waitFor(s, 'hello-session');
    assert.match(out, /hello-session/);

    const exit = await s.close();
    assert.equal(s.alive, false);
    assert.ok(exit.exitCode !== null || exit.signal !== null);
  });

  it('resize is real: stty size reads the new dimensions back', async () => {
    const s = PtySession.create({ principal: 'human', shell: SHELL, rows: 24, cols: 80 });
    try {
      s.write('stty size\n');
      await waitFor(s, '24 80');
      s.resize(40, 120);
      assert.equal(s.rows, 40);
      assert.equal(s.cols, 120);
      s.write('stty size\n');
      const out = await waitFor(s, '40 120');
      assert.match(out, /40 120/);
    } finally {
      await s.close();
    }
  });

  it('close kills the whole tree (supervisor pid gone, no survivors)', async () => {
    const s = PtySession.create({ principal: 'human', shell: SHELL });
    const pid = s.pid;
    assert.ok(pid && pid > 0);
    // Start a grandchild that would outlive the shell if the tree kill failed.
    s.write('sleep 300 &\n');
    await waitExitIdle(s);
    await s.close();
    assert.equal(s.alive, false);
    // The supervisor (and with it the process group) must be gone.
    await new Promise((r) => setTimeout(r, 800));
    let alive = true;
    try {
      process.kill(pid as number, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      else throw e;
    }
    assert.equal(alive, false, 'supervisor process must be gone after close()');
    const ps = spawnSync('sh', ['-c', 'ps -eo pid,args | grep "[s]leep 300" || true'], { encoding: 'utf8' });
    assert.equal(ps.stdout.trim(), '', 'no sleep 300 survivor may remain');
  });

  it('ai sessions line-gate input: denied lines never reach the pty', async () => {
    const denied: Array<{ line: string; reason: string }> = [];
    const s = PtySession.create({
      principal: 'ai',
      shell: SHELL,
      aiLinePolicy: (line) => {
        if (/\brm\b/.test(line)) throw new Error('no rm for AI sessions');
      },
    });
    const unsub = s.onDenied((info) => denied.push(info));
    try {
      s.write('echo allowed-line\n');
      await waitFor(s, 'allowed-line');
      s.write('rm -rf /tmp/whatever\n');
      // Give the session a beat: the denied line must NOT appear.
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(denied.length, 1);
      assert.equal(denied[0]?.line, 'rm -rf /tmp/whatever');
      assert.match(denied[0]?.reason ?? '', /no rm for AI sessions/);
      const transcript = s.transcriptText();
      assert.ok(!transcript.includes('rm -rf /tmp/whatever'), 'denied line must never reach the terminal');
      // The session is still usable afterwards.
      s.write('echo still-alive\n');
      await waitFor(s, 'still-alive');
    } finally {
      unsub();
      await s.close();
    }
  });

  it('ai sessions buffer partial lines until the newline (nothing half-gated)', async () => {
    const seen: string[] = [];
    const s = PtySession.create({
      principal: 'ai',
      shell: SHELL,
      aiLinePolicy: (line) => {
        seen.push(line);
      },
    });
    try {
      s.write('echo par');
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(seen, [], 'partial line must not be gated yet');
      assert.ok(!s.transcriptText().includes('par'), 'partial line must not reach the pty');
      s.write('tial-done\n');
      await waitFor(s, 'tial-done');
      assert.deepEqual(seen, ['echo partial-done']);
    } finally {
      await s.close();
    }
  });

  it('human sessions pass bytes through raw (no gating)', async () => {
    const s = PtySession.create({ principal: 'human', shell: SHELL });
    try {
      s.write('echo raw-passthrough-check\n');
      await waitFor(s, 'raw-passthrough-check');
    } finally {
      await s.close();
    }
  });

  it('concurrent sessions never cross streams', async () => {
    const a = PtySession.create({ principal: 'human', shell: SHELL });
    const b = PtySession.create({ principal: 'ai', shell: SHELL, aiLinePolicy: () => {} });
    try {
      a.write('echo MARKER-ALPHA\n');
      b.write('echo MARKER-BETA\n');
      await waitFor(a, 'MARKER-ALPHA');
      await waitFor(b, 'MARKER-BETA');
      assert.ok(!a.transcriptText().includes('MARKER-BETA'), 'session A must not see B output');
      assert.ok(!b.transcriptText().includes('MARKER-ALPHA'), 'session B must not see A output');
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('manager: registry, archive, idle sweep, session cap', async () => {
    const mgr = new PtySessionManager({ maxSessions: 2, archiveDepth: 5 });
    const s1 = mgr.create({ principal: 'human', shell: SHELL });
    const s2 = mgr.create({ principal: 'ai', shell: SHELL, aiLinePolicy: () => {} });
    assert.equal(mgr.liveCount, 2);
    assert.throws(() => mgr.create({ principal: 'human', shell: SHELL }), /session limit reached/);
    assert.equal(mgr.list().length, 2);
    assert.throws(() => mgr.get('nope'), /unknown session/);

    await mgr.close(s1.id);
    assert.equal(mgr.liveCount, 1);
    const closed = mgr.closedSessions();
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.id, s1.id);
    assert.ok(typeof closed[0]?.endedAt === 'number');

    // Idle sweep: force staleness and reap.
    s2.lastActivityAt = Date.now() - 10_000;
    const reaped = await mgr.sweepIdle(1_000);
    assert.deepEqual(reaped, [s2.id]);
    assert.equal(mgr.liveCount, 0);
    assert.equal(mgr.closedSessions().length, 2);
  });

  it('a dead controller leaves no orphans: stdin EOF kills the whole tree', async () => {
    // A child node process creates a session, starts a grandchild,
    // then exits WITHOUT close() — simulating a SIGKILLed server.
    // The supervisor must notice the dead stdin pipe, SIGKILL the
    // process group, and exit itself.
    const script = `
const { PtySession } = require(${JSON.stringify(join(__dirname, '..', 'dist', 'pty-session.js'))});
(async () => {
  const s = PtySession.create({ principal: 'human', shell: ['/bin/sh'] });
  s.write('sleep 300 &\n');
  await new Promise((r) => setTimeout(r, 800));
  process.exit(0); // no close(): controller death
})();
`;
    spawnSync(process.execPath, ['-e', script], { timeout: 15_000 });
    // Give the supervisor a beat to observe the EOF and kill the tree.
    await new Promise((r) => setTimeout(r, 2500));
    const sup = spawnSync('sh', ['-c', 'pgrep -f "pty-sessio[n]: cannot start" || true'], {
      encoding: 'utf8',
    });
    assert.equal(
      sup.stdout.trim(),
      '',
      `orphaned session supervisors must not survive controller death (pids: ${sup.stdout.trim()})`,
    );
    const sleeper = spawnSync('sh', ['-c', 'ps -eo args | grep "[s]leep 300" || true'], {
      encoding: 'utf8',
    });
    assert.equal(sleeper.stdout.trim(), '', 'no sleep 300 survivor may remain');
  });

  it('write after close throws', async () => {
    const s = PtySession.create({ principal: 'human', shell: SHELL });
    await s.close();
    assert.throws(() => s.write('echo x\n'), /is closed/);
    assert.throws(() => s.resize(10, 10), /is closed/);
  });
});
