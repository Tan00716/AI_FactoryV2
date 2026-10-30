/**
 * Suite orchestration (V3-#4).
 *
 * Default run (what the evidence scripts execute): small (1k files) +
 * medium (10k files) synthetic repos, one cold index + repomap + search
 * per scale, plus server boot, SQLite writes, large-file scan, and the
 * unit-sample harness probe. The large (100k) scale and the vite-build
 * task are opt-in: they take minutes and are for dedicated runs, not
 * for every gate check.
 *
 * The workdir lives under $HOME (PERFBENCH_WORKDIR override) — never
 * /tmp (512MB tmpfs) and never inside the repo under test — and is
 * removed at the end of a successful run unless keepWorkdir is set.
 */
import { cpus, totalmem } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PerfResult, PerfTaskResult } from './types.js';
import { generateLargeFile, generateRepo } from './seed.js';
import {
  bootServer,
  concurrentPool,
  gitRev,
  indexRepo,
  largeFileScan,
  productWalMode,
  repomapFor,
  searchRepo,
  sqliteBench,
  unitSample,
  viteBuild,
} from './tasks.js';

export const PERFBENCH_VERSION = '0.1.0';

export interface SuiteOptions {
  repoRoot: string;
  workDir: string;
  seed?: number;
  scales?: Array<'small' | 'medium' | 'large'>;
  withVite?: boolean;
  serverMain?: string;
  productDbPath?: string;
  keepWorkdir?: boolean;
  port?: number;
}

const SCALE_FILES: Record<string, number> = { small: 1000, medium: 10000, large: 100000 };

export async function runSuite(opts: SuiteOptions): Promise<PerfResult> {
  const seed = opts.seed ?? 42;
  const scales = opts.scales ?? ['small', 'medium'];
  const tasks: PerfTaskResult[] = [];
  const notes: string[] = [
    'Synthetic repos (fixed seed): results measure the heuristic indexer/search on generated TS, not a real codebase.',
    'large-file-scan is a read + line-split + token-count proxy, NOT a Monaco render measurement.',
    'Win/mac runs are placeholders in this landing: the suite is plain node and can run there, but Electron first-paint and signed-packaging checks need real Win/mac machines and are not covered here.',
  ];
  mkdirSync(opts.workDir, { recursive: true });
  try {
    // Server boot (once, isolated DB/secrets/data dirs).
    const port = opts.port ?? 31_000 + Math.floor(Math.random() * 20_000);
    const bootDir = join(opts.workDir, 'boot');
    mkdirSync(bootDir, { recursive: true });
    if (opts.serverMain) {
      tasks.push(
        await bootServer({
          serverMain: opts.serverMain,
          port,
          dbPath: join(bootDir, 'factory.db'),
          secretsDir: join(bootDir, 'secrets'),
          dataDir: join(bootDir, 'data'),
        }),
      );
    } else {
      tasks.push({ task: 'server-boot', ms: 0, skipped: true, skipReason: 'no serverMain given' });
    }

    // Per-scale index / repomap / search (one cold index build per scale).
    for (const scale of scales) {
      const fileCount = SCALE_FILES[scale] as number;
      const root = join(opts.workDir, `repo-${scale}`);
      const gen = generateRepo(root, fileCount, seed);
      const cacheDir = join(opts.workDir, `cache-${scale}`);
      const { result: indexTask, index } = await indexRepo(root, cacheDir, scale);
      tasks.push({ ...indexTask, meta: { ...(indexTask.meta ?? {}), generatedFiles: gen.files, generatedBytes: gen.bytes } });
      tasks.push(repomapFor(index, scale));
      tasks.push(searchRepo(root, scale));
    }

    // SQLite writes + product WAL finding (copy, read-only).
    const sqliteTask = sqliteBench(join(opts.workDir, 'bench.db'));
    tasks.push(sqliteTask);
    if (opts.productDbPath) {
      const mode = productWalMode(opts.productDbPath, join(opts.workDir, 'walcheck'));
      notes.push(`Product DB journal_mode (via copy, read-only): ${mode}. WAL is NOT enabled by this suite; enabling it is a separate decision (see README).`);
    }

    // Large-file scan (10MB synthetic file).
    const largePath = join(opts.workDir, 'large.ts');
    const largeBytes = generateLargeFile(largePath, 10 * 1024 * 1024);
    const largeTask = largeFileScan(largePath);
    tasks.push({ ...largeTask, meta: { ...(largeTask.meta ?? {}), targetBytes: 10 * 1024 * 1024, actualBytes: largeBytes } });

    // Concurrent-task P95: bounded process pool (proxy, see tasks.ts).
    tasks.push(await concurrentPool());

    // Harness-overhead probe (this package's own compiled tests).
    const distTests = join(opts.repoRoot, 'packages', 'perfbench', 'dist', 'tests');
    tasks.push(await unitSample([join(distTests, 'seed.test.js'), join(distTests, 'stats.test.js'), join(distTests, 'gate.test.js')]));

    // Opt-in vite build proxy.
    if (opts.withVite) tasks.push(await viteBuild(opts.repoRoot));
    else tasks.push({ task: 'vite-build', ms: 0, skipped: true, skipReason: 'opt-in only (pass withVite)' });

    return {
      tool: '@ai-factory/perfbench',
      version: PERFBENCH_VERSION,
      generatedAt: new Date().toISOString(),
      seed,
      synthetic: true,
      scale: scales.join('+'),
      env: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: cpus().length,
        totalMemMb: Math.round(totalmem() / 1024 / 1024),
        gitRev: gitRev(opts.repoRoot),
      },
      tasks,
      notes,
    };
  } finally {
    if (!opts.keepWorkdir) {
      try {
        rmSync(opts.workDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
