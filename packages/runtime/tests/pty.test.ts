/**
 * Real-PTY shell execution — spec §33 (Shell tool), §50.1/§64 (controlled
 * terminal), audit gap G-11 ("终端无真实 PTY").
 * Run: node --test dist/tests/pty.test.js   (after tsc -p tsconfig.json)
 *
 * The PTY tests pin OBSERVABLE differences between a real terminal and
 * pipes — isatty, the ioctl'd window size, terminal-driven color
 * output, merged streams — against the pipe mode of the same module,
 * on the same machine, in the same run. PTY cases skip (loudly, via
 * the test runner's skip reason) only when the python3 backend is
 * genuinely unavailable; on the factory's Linux dev machines it is
 * present and every case runs for real.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Harness,
  PtyUnavailableError,
  createShellTool,
  ptyBackendAvailable,
  runCommandPipe,
  runCommandPty,
  runShellCommand,
  type ShellRunResult,
} from '../src/index';

const PTY_OK = ptyBackendAvailable();
const ptySkip = PTY_OK ? false : 'python3 PTY backend unavailable on this machine';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('pipe mode (the pre-existing shape)', () => {
  it('captures stdout and stderr separately and passes the exit code through', async () => {
    const r = await runShellCommand('echo to-out; echo to-err >&2; exit 5', { mode: 'pipe' });
    assert.equal(r.mode, 'pipe');
    assert.equal(r.merged, false);
    assert.equal(r.exitCode, 5);
    assert.equal(r.signal, null);
    assert.equal(r.timedOut, false);
    assert.ok(r.stdout.includes('to-out'), `stdout: ${r.stdout}`);
    assert.ok(!r.stdout.includes('to-err'), 'stderr must not leak into stdout in pipe mode');
    assert.ok(r.stderr.includes('to-err'), `stderr: ${r.stderr}`);
  });

  it('is NOT a terminal: test -t 1 fails inside the command', async () => {
    const r = await runShellCommand('test -t 1 && echo IS-TTY || echo NOT-TTY', { mode: 'pipe' });
    assert.ok(r.stdout.includes('NOT-TTY'), `stdout: ${r.stdout}`);
    assert.ok(!r.stdout.includes('IS-TTY'));
  });

  it('feeds stdin and the command sees a real EOF', async () => {
    const r = await runCommandPipe(['cat'], { stdin: 'piped-in' });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'piped-in');
  });

  it('times out and reports it instead of hanging', async () => {
    const r = await runShellCommand('sleep 10', { mode: 'pipe', timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 5_000, `took ${r.durationMs}ms`);
  });
});

describe('PTY mode (real pseudo-terminal, §50.1)', () => {
  it('stdout AND stderr are terminals, and the streams arrive merged', { skip: ptySkip }, async () => {
    const r = await runShellCommand(
      'test -t 1 && test -t 2 && echo BOTH-TTY || echo NOT-TTY; echo to-out; echo to-err >&2',
      { mode: 'pty' },
    );
    assert.equal(r.mode, 'pty');
    assert.equal(r.merged, true);
    assert.equal(r.stderr, '', 'PTY mode has no separate stderr stream');
    assert.ok(r.stdout.includes('BOTH-TTY'), `stdout: ${JSON.stringify(r.stdout)}`);
    assert.ok(r.stdout.includes('to-out'));
    assert.ok(r.stdout.includes('to-err'), 'stderr lands in the same terminal stream');
    assert.equal(r.exitCode, 0);
  });

  it('applies the requested window size before exec (stty size reads it back)', { skip: ptySkip }, async () => {
    const r = await runShellCommand('stty size', { mode: 'pty', rows: 33, cols: 121 });
    assert.ok(r.stdout.includes('33 121'), `stdout: ${JSON.stringify(r.stdout)}`);
  });

  it('passes exit codes through, including signal deaths as 128+signal', { skip: ptySkip }, async () => {
    const seven = await runShellCommand('exit 7', { mode: 'pty' });
    assert.equal(seven.exitCode, 7);
    // SIGSEGV = 11 → 139, the shell convention the helper implements.
    const segv = await runShellCommand('kill -SEGV $$', { mode: 'pty' });
    assert.equal(segv.exitCode, 139, `got ${segv.exitCode} / signal ${segv.signal}`);
  });

  it('terminal-driven programs emit color on the PTY and not on pipes', { skip: ptySkip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-color-'));
    try {
      mkdirSync(join(dir, 'subdir'));
      const env = { TERM: 'xterm-256color' };
      const onPty = await runCommandPty(['ls', '--color=auto', dir], { env });
      const onPipe = await runCommandPipe(['ls', '--color=auto', dir], { env });
      assert.ok(onPty.stdout.includes('\u001b['), `pty ls output: ${JSON.stringify(onPty.stdout)}`);
      assert.ok(!onPipe.stdout.includes('\u001b['), `pipe ls output: ${JSON.stringify(onPipe.stdout)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forwards stdin to the terminal (input is echoed, the read still lands)', { skip: ptySkip }, async () => {
    const r = await runShellCommand('read line; echo "got:$line"', {
      mode: 'pty',
      stdin: 'hello-pty\n',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('got:hello-pty'), `stdout: ${JSON.stringify(r.stdout)}`);
  });

  it('timeout kills the whole process tree, not just the shell', { skip: ptySkip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-tree-'));
    const marker = join(dir, 'marker.txt');
    try {
      const started = Date.now();
      const r = await runShellCommand(`sleep 2; touch ${marker}`, { mode: 'pty', timeoutMs: 300 });
      assert.equal(r.timedOut, true);
      assert.ok(r.durationMs < 1_900, `supervisor must not wait out the sleep (${r.durationMs}ms)`);
      // If the kill had only reached the supervisor's direct child or
      // missed the process group, `sleep 2` would still complete and a
      // surviving shell would run `touch` at t=2s. Wait past that
      // point and look.
      const remaining = 2_300 - (Date.now() - started);
      if (remaining > 0) await delay(remaining);
      assert.ok(!existsSync(marker), 'the command tree survived the timeout kill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps captured output but keeps draining (no blocked child, no hang)', { skip: ptySkip }, async () => {
    const r = await runShellCommand('printf "x%.0s" $(seq 1 100000)', {
      mode: 'pty',
      maxOutputBytes: 4096,
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.length <= 4096, `captured ${r.stdout.length} chars`);
  });

  it('a missing binary is exit 127 with the reason in backendDiagnostics, not in the stream', { skip: ptySkip }, async () => {
    const r = await runCommandPty(['definitely-not-a-binary-xyz'], {});
    assert.equal(r.exitCode, 127);
    assert.ok(r.backendDiagnostics?.includes('pty-helper'), `diagnostics: ${r.backendDiagnostics}`);
    assert.ok(!r.stdout.includes('pty-helper'), 'supervisor diagnostics must not pollute the terminal stream');
  });
});

describe('backend availability (fail-closed, never a fake terminal)', () => {
  it('reports this machine honestly', () => {
    assert.equal(typeof ptyBackendAvailable(), 'boolean');
    assert.equal(ptyBackendAvailable('/nonexistent/python3-xyz'), false);
  });

  it('runCommandPty rejects with PtyUnavailableError when the interpreter does not exist', async () => {
    await assert.rejects(
      runCommandPty(['echo', 'hi'], { pythonPath: '/nonexistent/python3-xyz' }),
      (err: unknown) => err instanceof PtyUnavailableError && (err as PtyUnavailableError).code === 'PTY_UNAVAILABLE',
    );
  });
});

describe('createShellTool — the Harness ToolImpl (§26/§33)', () => {
  it('plugs into Harness.runTool; the pty arg selects the backend per call', { skip: ptySkip }, async () => {
    const harness = new Harness({
      allowedRoots: ['/tmp'],
      stepTimeoutMs: 15_000,
      permissions: ['shell.execute'],
      evidence: { collect: () => {} },
    });
    const tool = createShellTool();
    const viaPipe = (await harness.runTool(
      'shell',
      { command: 'test -t 1 && echo IS-TTY || echo NOT-TTY' },
      tool,
    )) as ShellRunResult;
    assert.ok(viaPipe.stdout.includes('NOT-TTY'), `pipe: ${viaPipe.stdout}`);
    const viaPty = (await harness.runTool(
      'shell',
      { command: 'test -t 1 && echo IS-TTY || echo NOT-TTY', pty: true },
      tool,
    )) as ShellRunResult;
    assert.equal(viaPty.mode, 'pty');
    assert.ok(viaPty.stdout.includes('IS-TTY'), `pty: ${viaPty.stdout}`);
  });

  it('returns the exit-code record, never a bare success string (§33)', async () => {
    const tool = createShellTool();
    const r = (await tool({ command: 'exit 4' })) as ShellRunResult;
    assert.equal(r.exitCode, 4);
    assert.equal(r.mode, 'pipe');
  });

  it('rejects calls with neither command nor argv', async () => {
    const tool = createShellTool();
    await assert.rejects(async () => {
      await tool({});
    }, /requires args\.command/);
  });
});
