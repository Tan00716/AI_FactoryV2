/**
 * Post-merge build execution — SPEC v2 §40 (Batch 24).
 *
 * What "a real build" means here, honestly:
 *
 *  1. COMMAND SOURCE. The factory cannot know how to build an arbitrary
 *     merged repo. The ONLY accepted source is explicit operator
 *     configuration: FACTORY_BUILD_COMMAND. Unset → the feature is OFF
 *     and build records stay NOT_EXECUTED (the Batch 23 honest state).
 *     Commands are never taken from repo content or HTTP input.
 *  2. WHERE. A clean `git worktree add --detach` of the merged revision
 *     under FACTORY_BUILD_WORK_ROOT (default: os.tmpdir()/factory-builds).
 *     Never the live repo working tree, never a moving branch tip.
 *  3. POLICY. The command goes through the SAME execution policy as
 *     /api/exec (deny patterns + binary whitelist + control-plane dir
 *     guard — checkCommandPolicy / commandHitsControlDir). A refused
 *     command is a FAILED build, not a silent skip.
 *  4. TIMEOUT. FACTORY_BUILD_TIMEOUT_MS (default 10 min); the whole
 *     process TREE is killed on timeout (runCommandPipe semantics).
 *  5. DIGEST. The §40 digest = lockBuild(definition) over REAL inputs:
 *     revision (the merged candidate SHA), lockfileHash (sha256 of an
 *     auto-detected lockfile, or missing), toolchain (explicit config
 *     or the real execution environment — never repo heuristics),
 *     buildDefinitionHash (sha256 of the command), configHash (sha256
 *     of configured config files, or missing), dependencySources
 *     (detected lockfile paths). When any required input is missing
 *     the digest stays NULL with the missing names recorded — calling
 *     lockBuild with invented inputs would fabricate a digest, and the
 *     build still records SUCCEEDED (the execution really happened).
 *  6. ASYNC. Merge HTTP handlers never block on a build. One in-process
 *     FIFO runner, sequential. A record left NOT_EXECUTED across a
 *     restart stays NOT_EXECUTED — no surprise re-runs.
 *  7. EVIDENCE BINDING. When a build SUCCEEDs with a real digest, the
 *     merge evidence record for the same PR gets artifactDigest filled
 *     (replacing the honest 'no artifact' note). Best-effort: a sealed
 *     or missing evidence record is audited, never fatal.
 *  8. SBOM. On a SUCCEEDED build, before the worktree is deleted, an
 *     SBOM is derived from the worktree's lockfile(s) (CycloneDX-lite,
 *     see @ai-factory/cicd sbom.ts) and written to FACTORY_SBOM_DIR
 *     (default <cwd>/data/sboms) as sbom-<buildId>.json; the record's
 *     sbomRef points at the file. It is an inventory of declared/
 *     resolved dependencies, NOT a scan of installed files. No
 *     parsable lockfile → sbomRef null + named reason. SBOM generation
 *     failing never flips a SUCCEEDED build — it is audited and the
 *     record keeps sbomRef null with the failure named.
 *  9. ORPHAN RECONCILE (Batch 27). A SIGKILL between `git worktree add`
 *     and the finally-block cleanup leaves a detached worktree on disk,
 *     still registered in the source repo. Each workspace gets a
 *     `.factory-build-runner.json` ownership marker (buildId, repo,
 *     owner PID + PID start time). At startup index.ts calls
 *     startReconcile() and pump() awaits the reconcile promise before
 *     the first build: dead-PID orphans (marker, or name-pattern +
 *     build record for the pre-marker window) are unregistered from git
 *     and deleted — audited BUILD_ORPHAN_CLEANED, never replayed;
 *     live-PID workspaces and unattributable directories are left
 *     alone. The reconcile never touches directories that don't match
 *     `build-<uuid>`, never creates the work root, and never throws.
 *
 * SECURITY BOUNDARY (stated plainly): the build command is operator
 * configuration, but it EXECUTES REPO-CONTROLLED CODE (e.g. `npm run
 * build` runs the merged package.json scripts). Enable this only for
 * repos whose merged code is trusted — same posture as any CI runner.
 * Since Batch 37 the command additionally runs inside a bubblewrap
 * sandbox when one is available (read-only toolchain roots, one
 * writable bind at /work, fresh pid/ipc/uts namespaces, network
 * isolated by default — see build-sandbox.ts); when bwrap is missing
 * or unusable the runner falls back to the old unsandboxed execution
 * and audits SANDBOX_UNAVAILABLE. The sandbox is a best-effort
 * confinement layer, not a proof against a hostile kernel-level
 * adversary — the "trusted repos only" posture still stands.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { GitRepo } from '@ai-factory/git';
import {
  assembleBuildDefinition,
  generateSbom,
  lockBuild,
  type BuildDefinition,
} from '@ai-factory/cicd';
import {
  SBOM_NO_LOCKFILE_NOTE,
  sbomGenerationFailedNote,
} from '@ai-factory/db';
import type { FactoryDatabase } from '@ai-factory/db';
import { checkCommandPolicy, commandHitsControlDir } from './routes/exec';
import {
  runBuildCommand,
  sandboxConfigFromEnv,
  type SandboxConfig,
} from './build-sandbox';

export const BUILD_COMMAND_ENV = 'FACTORY_BUILD_COMMAND';
export const BUILD_TIMEOUT_ENV = 'FACTORY_BUILD_TIMEOUT_MS';
export const BUILD_TOOLCHAIN_ENV = 'FACTORY_BUILD_TOOLCHAIN';
export const BUILD_CONFIG_FILES_ENV = 'FACTORY_BUILD_CONFIG_FILES';
export const BUILD_WORK_ROOT_ENV = 'FACTORY_BUILD_WORK_ROOT';
export const BUILD_SBOM_DIR_ENV = 'FACTORY_SBOM_DIR';

export const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

/**
 * Batch 26 — the SBOM directory, shared between the build runner
 * (which writes sbom-<buildId>.json files there) and the retention
 * routes (which sweep them). Same default in both places so a
 * server that never configures FACTORY_BUILD_COMMAND still
 * evaluates the directory the runner would use.
 */
export function sbomDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env[BUILD_SBOM_DIR_ENV] ?? '').trim() || join(process.cwd(), 'data', 'sboms');
}

export interface BuildRunnerConfig {
  /** The exact command to run. Unset (empty) = feature off. */
  command: string;
  timeoutMs: number;
  toolchain?: string;
  /** Repo-relative config files feeding configHash. */
  configFiles: string[];
  workRoot: string;
  /** Where SBOM JSON files land (sbom-<buildId>.json). */
  sbomDir: string;
  /**
   * Bubblewrap sandbox for the build command (Batch 37). Optional —
   * defaults to sandboxConfigFromEnv() so existing literal configs
   * keep working. `enabled: false` restores the pre-Batch-37
   * unsandboxed behavior explicitly.
   */
  sandbox?: SandboxConfig;
}

/**
 * Read the runner config from the environment. Returns null when
 * FACTORY_BUILD_COMMAND is unset/empty — the feature is OFF and merge
 * build records honestly stay NOT_EXECUTED.
 */
export function buildRunnerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BuildRunnerConfig | null {
  const command = (env[BUILD_COMMAND_ENV] ?? '').trim();
  if (!command) return null;
  const rawTimeout = Number(env[BUILD_TIMEOUT_ENV]);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.floor(rawTimeout)
      : DEFAULT_BUILD_TIMEOUT_MS;
  const configFiles = (env[BUILD_CONFIG_FILES_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    command,
    timeoutMs,
    toolchain: (env[BUILD_TOOLCHAIN_ENV] ?? '').trim() || undefined,
    configFiles,
    workRoot: (env[BUILD_WORK_ROOT_ENV] ?? '').trim() || join(tmpdir(), 'factory-builds'),
    sbomDir: (env[BUILD_SBOM_DIR_ENV] ?? '').trim() || sbomDirFromEnv(env),
    sandbox: sandboxConfigFromEnv(env),
  };
}

export interface BuildRunnerDeps {
  fdb: FactoryDatabase;
  audit: {
    record(
      actor: string,
      action: string,
      kind: string,
      name: string,
      details?: Record<string, unknown>,
    ): void;
  };
  evidence: {
    listByTask(taskId: string): Array<{
      id: string;
      type: string;
      payload: Record<string, unknown>;
    }>;
    update(
      id: string,
      patch: { payload?: Record<string, unknown> },
    ): unknown;
  };
}

const OUTPUT_EXCERPT_CHARS = 2000;

/**
 * Batch 27 — orphaned build workspace reconcile.
 *
 * The runner deletes every worktree in a finally block (success or
 * failure), but a SIGKILL between `git worktree add --detach` and that
 * cleanup leaves a detached worktree on disk — still registered in the
 * source repo's worktree list, pinning the revision, occupying disk
 * forever. On the next boot the reconcile below reaps them.
 *
 * Rules, in order, for each directory directly under workRoot:
 *
 *  1. The name must match `build-<uuid>` (the exact shape runOne uses).
 *     Anything else is never touched — not our directory, not our call.
 *  2. A missing workRoot is a no-op (never created by the reconcile).
 *  3. `.factory-build-runner.json` marker, when present and valid, is
 *     the authority: it carries the buildId, source repo, and the PID
 *     that owned the build.
 *     - PID still alive (see isPidAlive) → SKIP, audited
 *       BUILD_ORPHAN_SKIPPED. A build whose process survived the server
 *       (its parent died, it didn't) must never be deleted from under it.
 *     - PID dead → orphan: remove the git worktree registration first
 *       (`git worktree remove --force`, then prune), then rmSync the
 *       directory. Audited BUILD_ORPHAN_CLEANED with an explicit note
 *       that this is cleanup, not a build replay.
 *  4. No marker (the pre-marker window: worktree added, marker not yet
 *     written): the builds record is the fallback authority. A record
 *     with this id exists → it is ours, clean it. No marker AND no
 *     record → SKIP, audited BUILD_ORPHAN_SKIPPED ('not ours') — we
 *     never delete a directory we cannot attribute.
 *  5. Non-directory entries and unreadable markers are skipped, never
 *     guessed.
 *
 * PID reuse is handled by recording the owner's process start time
 * (Linux /proc; null elsewhere) in the marker and comparing it at
 * reconcile time — a recycled PID with a different start time is
 * treated as dead.
 */
export const BUILD_WORKSPACE_MARKER = '.factory-build-runner.json';
const WORKSPACE_DIR_RE =
  /^build-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BuildWorkspaceMarker {
  marker: 'ai-factory-build-workspace';
  buildId: string;
  repo: string;
  revision: string;
  pid: number;
  /** Linux process start time (epoch ms); null when unavailable. */
  pidStartMs: number | null;
  createdAt: string;
}

/** Process start time in epoch ms via /proc (Linux only, null otherwise). */
export function procStartMs(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const startTicks = Number(afterComm[19]); // field 22 (starttime)
    if (!Number.isFinite(startTicks)) return null;
    const btimeLine = readFileSync('/proc/stat', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('btime '));
    const btime = Number(btimeLine?.split(/\s+/)[1]);
    if (!Number.isFinite(btime)) return null;
    let clkTck = 100;
    try {
      const out = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim();
      const n = Number(out);
      if (Number.isFinite(n) && n > 0) clkTck = n;
    } catch {
      /* default 100 */
    }
    return Math.floor(btime * 1000 + (startTicks * 1000) / clkTck);
  } catch {
    return null;
  }
}

/**
 * True when the pid refers to a live process. EPERM (exists, not
 * signalable) counts as alive — conservative. When an expected start
 * time is available it must match, otherwise a recycled PID would
 * look alive.
 */
export function isPidAlive(pid: number, expectedStartMs: number | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    return true; // EPERM or anything else: process exists — don't touch
  }
  if (expectedStartMs == null) return true;
  const actual = procStartMs(pid);
  if (actual == null) return true; // cannot verify identity — conservative
  return actual === expectedStartMs;
}

/**
 * Write the ownership marker into a fresh build workspace. Never
 * throws — on failure it audits BUILD_MARKER_WRITE_FAILED and the
 * reconcile falls back to name-pattern + build-record attribution.
 */
export function writeWorkspaceMarker(
  workDir: string,
  buildId: string,
  repo: string,
  revision: string,
  hooks: { audit: (action: string, details: Record<string, unknown>) => void },
): void {
  try {
    const marker: BuildWorkspaceMarker = {
      marker: 'ai-factory-build-workspace',
      buildId,
      repo,
      revision,
      pid: process.pid,
      pidStartMs: procStartMs(process.pid),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(workDir, BUILD_WORKSPACE_MARKER), JSON.stringify(marker) + '\n', 'utf8');
  } catch (err) {
    hooks.audit('BUILD_MARKER_WRITE_FAILED', {
      workDir,
      error: (err as Error).message,
    });
  }
}

function readWorkspaceMarker(workDir: string): BuildWorkspaceMarker | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(workDir, BUILD_WORKSPACE_MARKER), 'utf8'),
    ) as Partial<BuildWorkspaceMarker>;
    if (
      parsed?.marker === 'ai-factory-build-workspace' &&
      typeof parsed.buildId === 'string' &&
      typeof parsed.pid === 'number'
    ) {
      return parsed as BuildWorkspaceMarker;
    }
    return null;
  } catch {
    return null;
  }
}

export interface OrphanReconcileResult {
  scanned: number;
  cleaned: string[];
  skippedAlive: string[];
  skippedUnknown: string[];
  errors: Array<{ workDir: string; error: string }>;
}

function emptyReconcileResult(): OrphanReconcileResult {
  return { scanned: 0, cleaned: [], skippedAlive: [], skippedUnknown: [], errors: [] };
}

export async function reconcileBuildWorkspaces(
  workRoot: string,
  opts: {
    fdb: FactoryDatabase;
    audit: BuildRunnerDeps['audit'];
  },
): Promise<OrphanReconcileResult> {
  const result = emptyReconcileResult();
  let entries: string[];
  try {
    entries = readdirSync(workRoot);
  } catch {
    return result; // missing root: nothing to do, never created here
  }
  for (const name of entries) {
    if (!WORKSPACE_DIR_RE.test(name)) continue;
    const workDir = join(workRoot, name);
    let isDir = false;
    try {
      isDir = statSync(workDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    result.scanned++;
    const buildId = name.slice('build-'.length);
    const marker = readWorkspaceMarker(workDir);
    if (marker && isPidAlive(marker.pid, marker.pidStartMs)) {
      result.skippedAlive.push(workDir);
      opts.audit.record('system', 'BUILD_ORPHAN_SKIPPED', 'build', buildId, {
        workDir,
        reason: 'build process still alive — not touching a live workspace',
        pid: marker.pid,
      });
      continue;
    }
    let rec: { repo: string } | undefined;
    try {
      rec = opts.fdb.builds.get(buildId) ?? undefined;
    } catch {
      rec = undefined;
    }
    if (!marker && !rec) {
      result.skippedUnknown.push(workDir);
      opts.audit.record('system', 'BUILD_ORPHAN_SKIPPED', 'build', buildId, {
        workDir,
        reason: 'no marker and no build record — unattributable, leaving alone',
      });
      continue;
    }
    const repo = marker?.repo ?? rec?.repo;
    // Remove the git worktree registration FIRST (the repo still lists
    // this path as a detached worktree), then the directory itself.
    try {
      if (repo) {
        const g = new GitRepo(repo);
        await g.worktreeRemove(workDir, { force: true }).catch(() => undefined);
        await g.worktreePrune().catch(() => undefined);
      }
    } catch {
      /* best effort — fall through to rmSync */
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
      result.cleaned.push(workDir);
      opts.audit.record('system', 'BUILD_ORPHAN_CLEANED', 'build', buildId, {
        workDir,
        repo: repo ?? null,
        hadMarker: marker !== null,
        note: 'orphan workspace from a previous boot (server died mid-build) — cleaned, never replayed',
      });
    } catch (err) {
      result.errors.push({ workDir, error: (err as Error).message });
      opts.audit.record('system', 'BUILD_ORPHAN_CLEANUP_FAILED', 'build', buildId, {
        workDir,
        error: (err as Error).message,
      });
    }
  }
  return result;
}

function excerpt(s: string): string {
  return s.length > OUTPUT_EXCERPT_CHARS
    ? s.slice(0, OUTPUT_EXCERPT_CHARS) + `…[truncated ${s.length - OUTPUT_EXCERPT_CHARS} chars]`
    : s;
}

/**
 * In-process, sequential post-merge build runner. Constructed once at
 * server startup (index.ts); merge routes enqueue landed build records.
 */
export class BuildRunner {
  private readonly queue: string[] = [];
  private pumping = false;
  private closed = false;
  private reconcilePromise: Promise<OrphanReconcileResult> | null = null;

  constructor(
    private readonly deps: BuildRunnerDeps,
    private readonly config: BuildRunnerConfig,
  ) {}

  /** Queue a landed build record for background execution. Fire-and-forget. */
  enqueue(buildId: string): void {
    if (this.closed) return;
    this.queue.push(buildId);
    void this.pump();
  }

  /** Stop accepting work (tests / shutdown). In-flight build runs to completion. */
  close(): void {
    this.closed = true;
  }

  /**
   * Kick off the startup orphan reconcile (called once from index.ts).
   * Fire-and-forget by design: pump() awaits the reconcile promise
   * before running any build, so no build can start before the orphan
   * scan finished — without needing top-level await in index.ts.
   */
  startReconcile(): void {
    if (!this.reconcilePromise) {
      this.reconcilePromise = this.reconcileOrphans();
    }
  }

  /** For tests: wait until the queue is drained. */
  async drain(): Promise<void> {
    while (this.pumping || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Startup reconcile (Batch 27): clean orphaned build workspaces left
   * behind by a previous boot that died mid-build (SIGKILL between
   * `git worktree add` and the finally-block cleanup). Never throws —
   * a reconcile failure is audited, never fatal to startup. See
   * reconcileBuildWorkspaces for the exact rules.
   */
  async reconcileOrphans(): Promise<OrphanReconcileResult> {
    try {
      const r = await reconcileBuildWorkspaces(this.config.workRoot, {
        fdb: this.deps.fdb,
        audit: this.deps.audit,
      });
      if (r.cleaned.length > 0 || r.errors.length > 0 || r.skippedAlive.length > 0) {
        console.log(
          `[ai-factory] build workspace reconcile: ${r.cleaned.length} orphan(s) cleaned, ` +
            `${r.skippedAlive.length} skipped (build still alive), ${r.errors.length} error(s)`,
        );
      }
      return r;
    } catch (err) {
      this.deps.audit.record('system', 'BUILD_ORPHAN_RECONCILE_FAILED', 'build', 'startup', {
        workRoot: this.config.workRoot,
        error: (err as Error).message,
      });
      return { scanned: 0, cleaned: [], skippedAlive: [], skippedUnknown: [], errors: [] };
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // The startup orphan reconcile (if started) completes before any
      // build runs — a live workspace is never cleaned from under a
      // build this boot is about to start.
      if (this.reconcilePromise) await this.reconcilePromise;
      while (this.queue.length > 0) {
        const id = this.queue.shift() as string;
        try {
          await this.runOne(id);
        } catch (err) {
          // runOne is total — this is the last-resort net so one bad
          // record can never wedge the queue or crash the server.
          this.deps.audit.record('system', 'BUILD_RUNNER_ERROR', 'build', id, {
            error: (err as Error).message,
          });
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runOne(buildId: string): Promise<void> {
    const { fdb, audit, evidence } = this.deps;
    const rec = fdb.builds.get(buildId);
    if (!rec) {
      audit.record('system', 'BUILD_SKIPPED', 'build', buildId, {
        reason: 'record not found',
      });
      return;
    }
    if (rec.status !== 'NOT_EXECUTED') {
      audit.record('system', 'BUILD_SKIPPED', 'build', buildId, {
        reason: `record already ${rec.status} — one-way transition, not re-running`,
      });
      return;
    }

    audit.record('system', 'BUILD_STARTED', 'build', buildId, {
      revision: rec.revision,
      command: this.config.command.slice(0, 120),
    });

    const workDir = join(this.config.workRoot, `build-${rec.id}`);
    let worktreeAdded = false;
    const fail = (reason: string, exitCode?: number | null) => {
      fdb.builds.markFailed(buildId, { reason, exitCode: exitCode ?? null });
      audit.record('system', 'BUILD_FAILED', 'build', buildId, {
        revision: rec.revision,
        reason,
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    };

    try {
      mkdirSync(workDir, { recursive: true });
      // Pin the EXACT merged revision — never a moving branch tip.
      const repo = new GitRepo(rec.repo);
      try {
        await repo.worktreeAddDetached(workDir, rec.revision, {
          audit: (action, details) =>
            audit.record('system', action, 'git', rec.repo, details),
        });
        worktreeAdded = true;
        // Marker BEFORE any build work: if the server dies from here on
        // (SIGKILL mid-build), the startup reconcile can identify this
        // directory as ours and clean it — never silently orphaned. The
        // write never throws: a missing marker only degrades cleanup to
        // the name-pattern + build-record fallback.
        writeWorkspaceMarker(workDir, buildId, rec.repo, rec.revision, {
          audit: (action, details) =>
            audit.record('system', action, 'build', buildId, details),
        });
      } catch (err) {
        fail(`worktree setup failed: ${(err as Error).message}`);
        return;
      }

      // Assemble the §40 definition from the REAL worktree state.
      const assembled = await assembleBuildDefinition({
        revision: rec.revision,
        workDir,
        buildCommand: this.config.command,
        toolchain: this.config.toolchain,
        configFiles: this.config.configFiles,
      });

      // Same execution policy as /api/exec — a refused command is a
      // FAILED build, recorded and audited, never a silent skip.
      let tokens: string[];
      try {
        tokens = checkCommandPolicy(this.config.command);
        if (commandHitsControlDir(workDir, tokens)) {
          throw new Error(
            'build command touches the control-plane data directory',
          );
        }
      } catch (err) {
        fail(`build command refused by execution policy: ${(err as Error).message}`);
        return;
      }

      // Batch 37 — the build command runs inside a bubblewrap sandbox
      // when one is available (filesystem + pid/ipc/uts isolated,
      // network isolated by default). When bwrap is missing or the
      // probe fails, this falls back to the previous unsandboxed
      // execution and audits SANDBOX_UNAVAILABLE — honest fallback,
      // never a silent downgrade. See build-sandbox.ts.
      const result = await runBuildCommand(tokens, {
        workDir,
        timeoutMs: this.config.timeoutMs,
        buildId,
        sandbox: this.config.sandbox ?? sandboxConfigFromEnv(),
        audit: {
          record: (action, details) =>
            audit.record('system', action, 'build', buildId, details),
        },
      });

      if (result.timedOut) {
        fail(
          `build timed out after ${this.config.timeoutMs}ms (process tree killed)`,
          result.exitCode,
        );
        return;
      }
      if (result.exitCode !== 0) {
        fail(
          `build exited with code ${result.exitCode}` +
            (result.signal ? ` (signal ${result.signal})` : '') +
            ` — output: ${excerpt(result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''))}`,
          result.exitCode,
        );
        return;
      }

      // The build really ran. Lock the §40 digest over real inputs —
      // or record exactly which inputs were missing, never inventing.
      let digest: string | null = null;
      let digestNote: string;
      let definitionJson: string | null = null;
      let definitionNote: string;
      if (assembled.definition) {
        const locked = lockBuild(
          assembled.definition as BuildDefinition,
          `build-runner`,
        );
        digest = locked.digest;
        digestNote = '';
        definitionJson = JSON.stringify(assembled.definition);
        definitionNote = '';
      } else {
        const missing = assembled.missing.join(', ');
        digestNote =
          `no digest locked — required §40 inputs missing: ${missing}; ` +
          `calling lockBuild here would fabricate a digest`;
        definitionNote =
          `definition incomplete — missing: ${missing}` +
          (assembled.skippedConfigFiles.length > 0
            ? `; skipped absent config files: ${assembled.skippedConfigFiles.join(', ')}`
            : '');
      }
      // SBOM from the worktree's lockfile(s), BEFORE the worktree is
      // deleted below. A generation/write failure is audited and the
      // record keeps sbomRef null with the reason named — it never
      // flips a build that really succeeded.
      let sbomRef: string | null = null;
      let sbomNote: string = SBOM_NO_LOCKFILE_NOTE;
      try {
        const sbom = generateSbom(workDir, rec.revision);
        if (sbom.document) {
          mkdirSync(this.config.sbomDir, { recursive: true });
          const sbomPath = join(this.config.sbomDir, `sbom-${buildId}.json`);
          writeFileSync(sbomPath, JSON.stringify(sbom.document, null, 2) + '\n', 'utf8');
          sbomRef = sbomPath;
          sbomNote = sbom.note; // '' on clean success, truncation named otherwise
        } else {
          sbomNote = sbom.note || SBOM_NO_LOCKFILE_NOTE;
        }
      } catch (err) {
        sbomNote = sbomGenerationFailedNote((err as Error).message);
        audit.record('system', 'BUILD_SBOM_FAILED', 'build', buildId, {
          revision: rec.revision,
          reason: (err as Error).message,
        });
      }
      fdb.builds.markSucceeded(buildId, {
        digest,
        digestNote,
        definition: definitionJson,
        definitionNote,
        sbomRef,
        sbomNote,
        exitCode: result.exitCode ?? 0,
      });
      audit.record('system', 'BUILD_SUCCEEDED', 'build', buildId, {
        revision: rec.revision,
        exitCode: result.exitCode,
        digest: digest ? digest.slice(0, 16) + '…' : null,
        digestLocked: digest !== null,
        ...(assembled.missing.length > 0 ? { missingInputs: assembled.missing } : {}),
      });

      // Bind the real digest to the merge evidence (replaces the
      // honest 'no artifact' note). Best-effort: sealed/missing
      // evidence is audited, never fatal to the build result.
      if (digest && rec.taskId) {        try {
          const candidates = evidence
            .listByTask(rec.taskId)
            .filter(
              (e) =>
                e.type === 'merge' &&
                (e.payload['prId'] as string | undefined) === rec.prId,
            );
          if (candidates.length === 0) {
            audit.record('system', 'BUILD_EVIDENCE_BIND_SKIPPED', 'build', buildId, {
              reason: 'no merge evidence found for this PR',
            });
          } else {
            const target = candidates[candidates.length - 1];
            const nextPayload: Record<string, unknown> = {
              ...target.payload,
              artifactDigest: digest,
            };
            delete nextPayload['artifactNote'];
            evidence.update(target.id, { payload: nextPayload });
            audit.record('system', 'BUILD_EVIDENCE_BOUND', 'build', buildId, {
              evidenceId: target.id,
              digest: digest.slice(0, 16) + '…',
            });
          }
        } catch (err) {
          audit.record('system', 'BUILD_EVIDENCE_BIND_SKIPPED', 'build', buildId, {
            reason: (err as Error).message,
          });
        }
      } else if (digest && !rec.taskId) {
        audit.record('system', 'BUILD_EVIDENCE_BIND_SKIPPED', 'build', buildId, {
          reason: 'build record has no taskId — cannot locate merge evidence to bind',
        });
      }
    } finally {
      // Never leave build worktrees behind (success or failure).
      try {
        if (worktreeAdded) {
          const repo = new GitRepo(rec.repo);
          await repo.worktreeRemove(workDir, { force: true }).catch(() => undefined);
        }
      } catch {
        /* fall through to rmSync */
      }
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch (err) {
        audit.record('system', 'BUILD_CLEANUP_FAILED', 'build', buildId, {
          workDir,
          error: (err as Error).message,
        });
      }
    }
  }
}
