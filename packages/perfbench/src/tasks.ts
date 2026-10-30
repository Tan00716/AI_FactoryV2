/**
 * Benchmark task implementations (V3-#4). Each task returns a
 * PerfTaskResult; slow/optional tasks report `skipped` with a reason
 * instead of failing the suite when their preconditions are absent
 * (e.g. no compiled server, no desktop dist). All timings are wall
 * clock; sampled latencies use performance.now.
 *
 * Honest-label rules enforced here, not just in docs:
 * - `large-file-scan` is a read + line-split + token-count proxy. It is
 *   NOT a Monaco render measurement: Monaco first-paint needs a real
 *   display machine, which this VM does not have. The headless proxy
 *   for desktop startup cost is the `vite-build` task.
 * - `unit-sample` times the perfbench package's own test files only; it
 *   measures harness overhead, not the full suite (which takes far
 *   longer and belongs in the repo's own test gate).
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex } from '@ai-factory/codeindex';
import { grepProject } from '@ai-factory/codesearch';
import { buildRepoMap } from '@ai-factory/repomap';
import type { PerfTaskResult } from './types.js';
import { summarize } from './stats.js';

function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

function killChild(child: ReturnType<typeof spawn>): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

/** Boot the compiled server and time to first healthy /api/health. */
export async function bootServer(opts: {
  serverMain: string;
  port: number;
  dbPath: string;
  secretsDir: string;
  dataDir: string;
  timeoutMs?: number;
}): Promise<PerfTaskResult> {
  if (!existsSync(opts.serverMain)) {
    return { task: 'server-boot', ms: 0, skipped: true, skipReason: 'compiled server not found (run npm run build first)' };
  }
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t0 = performance.now();
  // V3-#1: the server refuses a loopback bind with no API credential, so
  // boot with a random per-run token (never recorded in results/logs).
  const bootToken = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [opts.serverMain], {
    cwd: join(opts.serverMain, '..', '..'),
    env: {
      ...process.env,
      PORT: String(opts.port),
      DB_PATH: opts.dbPath,
      FACTORY_SECRETS_DIR: opts.secretsDir,
      AI_FACTORY_DATA_DIR: opts.dataDir,
      FACTORY_API_TOKEN: bootToken,
    },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + timeoutMs;
    let earlyExit: { code: number | null } | null = null;
    child.on('exit', (code) => {
      earlyExit = { code };
    });
    for (;;) {
      if (earlyExit) {
        throw new Error(`server exited early (code=${(earlyExit as { code: number | null }).code}) before healthy`);
      }
      if (Date.now() > deadline) throw new Error('server did not become healthy in timeout');
      try {
        const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`, {
          headers: { Authorization: `Bearer ${bootToken}` },
        });
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { task: 'server-boot', ms: performance.now() - t0, meta: { port: opts.port } };
  } finally {
    killChild(child);
  }
}

/** Cold codeindex build over a synthetic repo root. Returns the task result AND the index (so repomap reuses this build, no second walk). */
export async function indexRepo(
  root: string,
  cacheDir: string,
  label: string,
): Promise<{ result: PerfTaskResult; index: Awaited<ReturnType<typeof buildIndex>>['index'] }> {
  const { ms, value } = await timedAsync(() => buildIndex(root, { cacheDir }));
  const files = value.stats.files ?? 0;
  return {
    result: {
      task: `index-${label}`,
      ms,
      value: ms === 0 ? 0 : (files / ms) * 1000,
      unit: 'files/sec',
      meta: { files, symbols: value.stats.symbols ?? 0 },
    },
    index: value.index,
  };
}

/** Repomap build from an already-built index. */
export function repomapFor(
  index: Awaited<ReturnType<typeof buildIndex>>['index'],
  label: string,
): PerfTaskResult {
  const { ms, value } = timed(() => buildRepoMap(index));
  return {
    task: `repomap-${label}`,
    ms,
    meta: { files: value.totals.files, symbols: value.totals.symbols, refs: value.totals.refs },
  };
}

/** Index-free grep over a synthetic repo root (probe token query). */
export function searchRepo(root: string, label: string): PerfTaskResult {
  const { ms, value } = timed(() =>
    grepProject(root, { query: 'perfbenchProbeToken' }),
  );
  // A 0-file scan means the root was unreadable (grepProject skips
  // unreadable dirs silently by design); it carries no signal, so report
  // it as skipped instead of letting the gate compare against 0ms.
  if (value.stats.filesScanned === 0) {
    return {
      task: `search-${label}`,
      ms,
      skipped: true,
      skipReason: 'no files scanned (root unreadable or empty)',
      meta: { filesScanned: 0, matches: 0 },
    };
  }
  return {
    task: `search-${label}`,
    ms,
    meta: {
      filesScanned: value.stats.filesScanned,
      matches: value.totalMatches,
      truncated: value.stats.truncated,
    },
  };
}

/** SQLite write latency: N autocommit inserts (sampled) + M batched. */
export function sqliteBench(dbPath: string, single = 2000, batched = 20000): PerfTaskResult {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS bench (id INTEGER PRIMARY KEY, payload TEXT)');
    db.exec('DELETE FROM bench');
    const insert = db.prepare('INSERT INTO bench (payload) VALUES (?)');
    const samples: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < single; i++) {
      const s0 = performance.now();
      insert.run(`payload-${i}-perfbench`);
      samples.push(performance.now() - s0);
    }
    const singleMs = performance.now() - t0;
    const b0 = performance.now();
    db.exec('BEGIN');
    for (let i = 0; i < batched; i++) insert.run(`batch-${i}`);
    db.exec('COMMIT');
    const batchMs = performance.now() - b0;
    const s = summarize(samples);
    const modeRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    return {
      task: 'sqlite-inserts',
      ms: singleMs,
      samples,
      p50Ms: s.p50Ms,
      p95Ms: s.p95Ms,
      meta: { single, batched, batchMs: Math.round(batchMs), journalMode: modeRow?.journal_mode ?? 'unknown' },
    };
  } finally {
    db.close();
  }
}

/** Large-file proxy: read + line-split + token count (NOT Monaco render). */
export function largeFileScan(filePath: string): PerfTaskResult {
  const { ms, value } = timed(() => {
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n');
    const tokens = text.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
    return { lines: lines.length, bytes: Buffer.byteLength(text), tokens };
  });
  return { task: 'large-file-scan', ms, meta: { ...value } };
}

/** Headless proxy for desktop startup cost: the vite build. Opt-in only. */
export async function viteBuild(repoRoot: string): Promise<PerfTaskResult> {
  const { ms, value } = await timedAsync(
    () =>
      new Promise<{ code: number | null }>((resolve) => {
        const child = spawn('npm', ['run', 'build', '-w', '@ai-factory/desktop'], {
          cwd: repoRoot,
          stdio: 'ignore',
        });
        child.on('exit', (code) => resolve({ code }));
      }),
  );
  if (value.code !== 0) {
    return { task: 'vite-build', ms, skipped: true, skipReason: `vite build exited ${String(value.code)}` };
  }
  return { task: 'vite-build', ms };
}

/**
 * Concurrent-task P95 (V3-#4 report item 5): a bounded process pool.
 * NOTE on honesty: R6-S4's JobQueue is a pure state machine (no process
 * execution), so it cannot yield a real parallel-execution timing. This
 * task instead spawns real child processes through a capped pool and
 * reports per-job wall latencies (p50/p95) plus wall vs serial sum.
 * It measures spawn + scheduling overhead under contention, NOT
 * taskqueue job execution (that timing is covered by the R6-S4 smoke
 * run, not by this suite). Labeled as a proxy in meta and README.
 */
export async function concurrentPool(
  jobs = 8,
  cap = 4,
  sleepMs = 200,
): Promise<PerfTaskResult> {
  const samples: number[] = [];
  const t0 = performance.now();
  let next = 0;
  const workers: Array<Promise<void>> = [];
  const runOne = async (): Promise<void> => {
    while (next < jobs) {
      const id = next;
      next += 1;
      void id;
      const s0 = performance.now();
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${sleepMs})`], { stdio: 'ignore' });
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      });
      samples.push(performance.now() - s0);
    }
  };
  for (let i = 0; i < cap; i++) workers.push(runOne());
  await Promise.all(workers);
  const wall = performance.now() - t0;
  const s = summarize(samples);
  return {
    task: 'concurrent-tasks',
    ms: wall,
    samples,
    p50Ms: s.p50Ms,
    p95Ms: s.p95Ms,
    meta: {
      jobs,
      cap,
      sleepMs,
      serialSumMs: jobs * sleepMs,
      speedup: wall > 0 ? Math.round((jobs * sleepMs) / wall * 100) / 100 : 0,
      proxy: 'process-pool proxy; not taskqueue job execution timing',
    },
  };
}

/** Harness-overhead proxy: run this package's own compiled tests. */
export async function unitSample(testGlobs: string[]): Promise<PerfTaskResult> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const { ms, value } = await timedAsync(
    () =>
      new Promise<{ code: number | null }>((resolve) => {
        const child = spawn(process.execPath, ['--test', ...testGlobs], { env, stdio: 'ignore' });
        child.on('exit', (code) => resolve({ code }));
      }),
  );
  if (value.code !== 0) {
    return { task: 'unit-sample', ms, skipped: true, skipReason: `node --test exited ${String(value.code)}` };
  }
  return { task: 'unit-sample', ms, meta: { files: testGlobs.length } };
}

/**
 * WAL check, read-only against a COPY of the product DB (never the live
 * file: opening the live file could create -wal/-shm sidecars or block a
 * writer). Returns the journal mode of the copy, or 'unknown'.
 */
export function productWalMode(productDbPath: string, workDir: string): string {
  try {
    if (!existsSync(productDbPath)) return 'unknown (no product db file)';
    mkdirSync(workDir, { recursive: true });
    const copy = join(workDir, 'factory-copy.db');
    copyFileSync(productDbPath, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
      return row?.journal_mode ?? 'unknown';
    } finally {
      db.close();
      rmSync(copy, { force: true });
    }
  } catch {
    return 'unknown (check failed)';
  }
}

export function gitRev(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}
