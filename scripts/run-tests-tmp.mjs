#!/usr/bin/env node
/**
 * Test-runner wrapper: hermetic TMPDIR for `node --test` (Batch 73-2).
 *
 * Why this exists: ~149 test files call `mkdtempSync(join(tmpdir(), ...))`
 * for SQLite DBs and never clean up. On machines where /tmp is a small
 * tmpfs (this dev container: 512MB), the junk accumulates across runs until
 * /tmp hits 100% and SQLite starts failing with
 *   ERR_SQLITE_ERROR errcode 13 'database or disk is full'
 * which surfaces as RANDOM test failures (Batch 72-1 reproduced: run1
 * 436/54 fail, run2 0 fail, run3 273/214 fail, run4 490/490 after clearing
 * /tmp and re-running with TMPDIR=$HOME).
 *
 * Editing all 149 files is impractical and churn-heavy (one file,
 * build-orphan-reconcile.test.ts, already does track+afterEach cleanup).
 * Instead this wrapper redirects the whole test process tree at the env
 * level: it creates a fresh temp root under $HOME, points TMPDIR/TMP/TEMP
 * at it for the child `node --test` run, then deletes the root afterwards
 * — even when the run fails or is interrupted.
 *
 * Usage: node scripts/run-tests-tmp.mjs --test <globs...>
 * The args after this script are passed straight to a child
 * `node` invocation (stdio inherited, exit code propagated).
 *
 * If TMPDIR is already set (non-empty), it is respected as-is and nothing
 * is created or deleted — so an explicit `TMPDIR=$HOME npm test` still
 * works exactly as before.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/run-tests-tmp.mjs <node args...>');
  process.exit(2);
}

let tmpRoot = null;
if (!process.env.TMPDIR) {
  tmpRoot = mkdtempSync(join(homedir(), '.aif-test-tmp-'));
  process.env.TMPDIR = tmpRoot;
  process.env.TMP = tmpRoot;
  process.env.TEMP = tmpRoot;
}

function cleanup() {
  if (tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort: never fail the run on cleanup */
    }
    tmpRoot = null;
  }
}
// Sync cleanup handlers: rmSync works in 'exit', and the signal handlers
// below kill the whole child process group first, wait for it to die, then
// clean the temp root and re-raise the signal so the wrapper itself dies
// with the signal's default action. (Without the group kill, an orphaned
// `node --test` child would keep running and its later mkdtemp calls would
// fail with ENOENT once the root is gone — reproduced 2026-10-15.)
process.on('exit', cleanup);

let shuttingDown = false;
async function shutdownOnSignal(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const alive = child.exitCode === null && child.signalCode === null;
    if (alive) {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGTERM'); // whole process group
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        /* already gone */
      }
      await new Promise((r) => {
        child.on('exit', r);
        setTimeout(r, 8000);
      });
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          /* already gone */
        }
      }
    }
  } finally {
    cleanup();
    // `once` already removed this listener, so re-raising hits the
    // default disposition and the wrapper dies with the signal.
    process.kill(process.pid, sig);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    void shutdownOnSignal(sig);
  });
}

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  // Own process group so an interrupt can take down the whole test tree.
  detached: process.platform !== 'win32',
});
child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
child.on('error', (err) => {
  console.error(`[run-tests-tmp] failed to spawn node: ${err.message}`);
  cleanup();
  process.exit(1);
});
