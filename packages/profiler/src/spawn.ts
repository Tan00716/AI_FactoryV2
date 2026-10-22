/**
 * Child-process runner shared by the CPU and heap capture paths.
 * Returns the wall-clock duration and whether the child was killed by
 * the timeout. Never throws for a non-zero exit — the caller decides
 * whether the expected artifact (profile / snapshot) was produced.
 *
 * On timeout the child first gets SIGTERM (so `--cpu-prof` can flush the
 * profile and the heap exit-hook can write the snapshot); SIGKILL follows
 * after a grace period only if the child ignores SIGTERM.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { ProfilerError } from './types';

export interface RunResult {
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
}

const TERM_GRACE_MS = 8000;

export function runChild(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { cwd, stdio: 'ignore' });
    } catch (e) {
      reject(new ProfilerError(`failed to spawn profiler child: ${(e as Error).message}`, 'spawn'));
      return;
    }
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const clearAll = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate only if the child ignores SIGTERM.
      killTimer = setTimeout(() => child.kill('SIGKILL'), TERM_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    // Unref so a wedged child can never hang the test runner forever.
    timer.unref();
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearAll();
      reject(new ProfilerError(`profiler child error: ${e.message}`, 'spawn'));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearAll();
      resolve({ durationMs: Date.now() - started, timedOut, exitCode: code, signal });
    });
  });
}
