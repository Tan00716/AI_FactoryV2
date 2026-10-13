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
 *
 * SECURITY BOUNDARY (stated plainly): the build command is operator
 * configuration, but it EXECUTES REPO-CONTROLLED CODE (e.g. `npm run
 * build` runs the merged package.json scripts). Enable this only for
 * repos whose merged code is trusted — same posture as any CI runner.
 * The build runs with the server's OS privileges inside a worktree dir;
 * it is NOT a sandbox. This is documented, not hidden.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { runCommandPipe } from '@ai-factory/runtime';
import type { FactoryDatabase } from '@ai-factory/db';
import { checkCommandPolicy, commandHitsControlDir } from './routes/exec';

export const BUILD_COMMAND_ENV = 'FACTORY_BUILD_COMMAND';
export const BUILD_TIMEOUT_ENV = 'FACTORY_BUILD_TIMEOUT_MS';
export const BUILD_TOOLCHAIN_ENV = 'FACTORY_BUILD_TOOLCHAIN';
export const BUILD_CONFIG_FILES_ENV = 'FACTORY_BUILD_CONFIG_FILES';
export const BUILD_WORK_ROOT_ENV = 'FACTORY_BUILD_WORK_ROOT';
export const BUILD_SBOM_DIR_ENV = 'FACTORY_SBOM_DIR';

export const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

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
    sbomDir: (env[BUILD_SBOM_DIR_ENV] ?? '').trim() || join(process.cwd(), 'data', 'sboms'),
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

  /** For tests: wait until the queue is drained. */
  async drain(): Promise<void> {
    while (this.pumping || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
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

      const result = await runCommandPipe(tokens, {
        cwd: workDir,
        timeoutMs: this.config.timeoutMs,
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
