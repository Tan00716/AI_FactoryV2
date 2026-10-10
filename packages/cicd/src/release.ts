/**
 * Environment Manager + Release Manager — spec §40 (ENVIRONMENT MANAGEMENT),
 * §41 (PRODUCTION POLICY), §77 (SNAPSHOT / RECOVERY).
 *
 * This module is the release-oriented complement to the pipeline-oriented
 * flow in deploy.ts:
 *
 *  - ManagedEnvironment: the full §40 environment model — secretRefs holds
 *    ONLY reference names (never values; agents must never receive raw
 *    production secrets), approvalPolicy is 'none'|'ai'|'human', and the
 *    health check is a structured {type, target} spec.
 *  - Release: a versioned bundle of artifacts with an auto-generated
 *    changelog draft, a target environment, approval evidence, and a
 *    release lifecycle (draft → … → deployed | failed | rolled_back).
 *  - ReleaseManager: creates releases, records approvals, and deploys with
 *    the full pre-deploy gate sequence: environment exists → approval policy
 *    satisfied → §77 snapshot → deploy → health check → auto-rollback on
 *    health failure. Every mutation goes through the audit hook.
 *
 * Approval decisions reuse @ai-factory/approvals: the default
 * isApprovalGranted checks the release's own approval refs, but callers can
 * inject a live lookup against ApprovalManager / the approvals store (the
 * server route does this) — the判定 logic is never reimplemented here.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { nowIso } from '@ai-factory/core';
import { SnapshotStore, rollback } from './deploy';
import type { AuditFn } from './pipeline';
import type { Snapshot } from './types';

/** §40 — release-oriented environment model. */
export interface ManagedEnvironment {
  /** Stable id, e.g. 'env-prod'. */
  id: string;
  name: 'LOCAL' | 'DEV' | 'UAT' | 'PROD';
  runtime: string;
  variables: Record<string, string>;
  /**
   * Secret store reference NAMES only — never values. The deploy runtime
   * resolves these at deploy time; agents must never see raw secrets
   * (spec §40).
   */
  secretRefs: string[];
  url?: string;
  deployMethod: string;
  permissions: string[];
  healthCheck: { type: 'http' | 'script'; target: string };
  rollbackMethod: string;
  /**
   * 'none' — deploy immediately.
   * 'ai'   — needs a granted approval (AI review is enough).
   * 'human'— needs a granted HUMAN approval (PROD, spec §41 Mode A).
   */
  approvalPolicy: 'none' | 'ai' | 'human';
}

/** §40 — the four default environment presets. PROD requires human approval. */
export const DEFAULT_ENVIRONMENTS: ManagedEnvironment[] = [
  {
    id: 'env-local',
    name: 'LOCAL',
    runtime: 'node:22 local process',
    variables: { NODE_ENV: 'development', PORT: '3000' },
    secretRefs: [],
    url: 'http://localhost:3000',
    deployMethod: 'none — runs in place',
    permissions: ['developer'],
    healthCheck: { type: 'script', target: 'process exit code 0' },
    rollbackMethod: 'restart local process / git restore',
    approvalPolicy: 'none',
  },
  {
    id: 'env-dev',
    name: 'DEV',
    runtime: 'node:22 docker compose',
    variables: { NODE_ENV: 'development', PORT: '8080' },
    secretRefs: ['dev-secrets'],
    url: 'http://localhost:8080',
    deployMethod: 'docker compose up --build',
    permissions: ['developer'],
    healthCheck: { type: 'http', target: '/healthz → 200' },
    rollbackMethod: 'docker compose up with previous image tag',
    approvalPolicy: 'none',
  },
  {
    id: 'env-uat',
    name: 'UAT',
    runtime: 'k8s staging cluster',
    variables: { NODE_ENV: 'staging', PORT: '8080' },
    secretRefs: ['uat-secrets'],
    url: 'https://uat.example.internal',
    deployMethod: 'helm upgrade',
    permissions: ['developer', 'qa-lead'],
    healthCheck: { type: 'http', target: '/healthz → 200, then smoke tests' },
    rollbackMethod: 'helm rollback',
    approvalPolicy: 'ai',
  },
  {
    id: 'env-prod',
    name: 'PROD',
    runtime: 'k8s production cluster',
    variables: { NODE_ENV: 'production', PORT: '8080' },
    // Spec §40: vault reference name only — never raw production secrets.
    secretRefs: ['prod-secrets'],
    url: 'https://app.example.com',
    deployMethod: 'helm upgrade --atomic',
    permissions: ['release-manager'],
    healthCheck: {
      type: 'http',
      target: '/healthz → 200, then smoke tests + canary check',
    },
    rollbackMethod: 'helm rollback',
    // Spec §41 Mode A: production deploys require a human approval.
    approvalPolicy: 'human',
  },
];

/** Release lifecycle. */
export type ReleaseStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'deploying'
  | 'deployed'
  | 'failed'
  | 'rolled_back';

/** One approval decision attached to a release (id reference only). */
export interface ApprovalRef {
  /** Id of the approval ticket (from @ai-factory/approvals). */
  approvalId: string;
  approver: string;
  decision: 'APPROVED' | 'REJECTED' | 'PENDING';
  decidedAt: string | null;
  /**
   * Who granted it. A 'human' environment policy only accepts level 'human';
   * an 'ai' policy accepts either. Unspecified levels are treated as 'ai'
   * (fail closed on the human gate — set this explicitly for PROD).
   */
  level?: 'ai' | 'human';
}

/** §40/§41 — a versioned release bundle. */
export interface Release {
  id: string;
  /** Semver, validated on creation. */
  version: string;
  artifacts: string[];
  /** Auto-generated draft: from git commit messages or a provided list. */
  changelog: string[];
  /** Target environment id (defaults to 'env-dev'). */
  environmentId: string;
  approvals: ApprovalRef[];
  status: ReleaseStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** §77 pre-deploy snapshot id; restored if the deploy fails. */
  snapshotId: string | null;
  /** Set when status is 'failed' or 'rolled_back'. */
  error?: string;
}

/** Result of a deployRelease() call. */
export interface ReleaseDeployResult {
  release: Release;
  /** Snapshot taken before the deploy (spec §77). */
  snapshot: Snapshot;
  /** True when the health check failed and the snapshot was restored. */
  rolledBack: boolean;
}

/* ------------------------------------------------------------------ */
/* semver helpers                                                      */
/* ------------------------------------------------------------------ */

/** Strict semver: MAJOR.MINOR.PATCH with optional -prerelease / +build. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export class InvalidSemverError extends Error {
  constructor(version: string) {
    super(`Invalid semver version: '${version}' (expected MAJOR.MINOR.PATCH)`);
    this.name = 'InvalidSemverError';
  }
}

export type BumpPart = 'major' | 'minor' | 'patch';

/**
 * Increment a semver version. Pre-release/build metadata is dropped on bump
 * (the bumped version is a fresh release line).
 */
export function bumpVersion(version: string, part: BumpPart): string {
  const m = SEMVER_RE.exec(version);
  if (!m) throw new InvalidSemverError(version);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (part === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (part === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/* ------------------------------------------------------------------ */
/* changelog draft                                                     */
/* ------------------------------------------------------------------ */

/** Turn a list of commit messages (or raw git log lines) into a changelog draft. */
export function draftChangelog(commits: string[]): string[] {
  const lines = commits.map((c) => c.trim()).filter((c) => c.length > 0);
  if (lines.length === 0) {
    return ['(no commits found — write the changelog manually)'];
  }
  return lines.map((c) => `- ${c}`);
}

/** Best-effort `git log` of the current repo; null when git is unavailable. */
function readGitCommits(cwd: string, limit = 20): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['log', `--max-count=${limit}`, '--pretty=format:%s'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const lines = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

export class ReleaseNotFoundError extends Error {
  constructor(id: string) {
    super(`Release ${id} not found`);
    this.name = 'ReleaseNotFoundError';
  }
}

export class EnvironmentNotFoundError extends Error {
  constructor(idOrName: string) {
    super(`Environment '${idOrName}' not found`);
    this.name = 'EnvironmentNotFoundError';
  }
}

/** Thrown when the deploy gate blocks on a missing approval (spec §41). */
export class ApprovalRequiredError extends Error {
  readonly releaseId: string;
  readonly environmentId: string;
  readonly approvalPolicy: ManagedEnvironment['approvalPolicy'];

  constructor(
    releaseId: string,
    environmentId: string,
    approvalPolicy: ManagedEnvironment['approvalPolicy'],
  ) {
    super(
      `Deploy of release ${releaseId} to ${environmentId} refused: ` +
        `approval policy is '${approvalPolicy}' and no granted approval is attached`,
    );
    this.name = 'ApprovalRequiredError';
    this.releaseId = releaseId;
    this.environmentId = environmentId;
    this.approvalPolicy = approvalPolicy;
  }
}

export class ReleaseNotDeployableError extends Error {
  constructor(id: string, status: ReleaseStatus) {
    super(
      `Release ${id} is '${status}': only draft / pending_approval / approved / failed / deployed (promotion) releases can be deployed`,
    );
    this.name = 'ReleaseNotDeployableError';
  }
}

function noop(): void {
  // intentional
}

/* ------------------------------------------------------------------ */
/* ReleaseManager                                                      */
/* ------------------------------------------------------------------ */

export interface CreateReleaseInput {
  version: string;
  artifacts?: string[];
  /**
   * Commit messages to build the changelog draft from. When omitted, the
   * manager tries `git log` of the current repo and falls back to a
   * placeholder line.
   */
  commits?: string[];
  /** Explicit changelog overrides the generated draft. */
  changelog?: string[];
  /** Target environment id (or name); defaults to 'env-dev'. */
  environmentId?: string;
  createdBy?: string;
}

export interface DeployReleaseOptions {
  /** Runs the actual deployment; defaults to a simulated success. */
  deployFn?: (
    env: ManagedEnvironment,
    release: Release,
    snapshot: Snapshot,
  ) => Promise<{ logs: string[] }>;
  /**
   * Post-deploy health check against env.healthCheck; defaults to a
   * simulated healthy result. Inject a failing fake in tests to exercise
   * the §77 auto-rollback path.
   */
  healthCheckFn?: (env: ManagedEnvironment, release: Release) => Promise<boolean>;
}

export interface ReleaseManagerOptions {
  /** Backing store for releases; a fresh Map is created when omitted. */
  releases?: Map<string, Release>;
  /** Environment registry; defaults to the four §40 presets. */
  environments?: ManagedEnvironment[];
  snapshotStore?: SnapshotStore;
  audit?: AuditFn;
  /**
   * Decides whether an approval id counts as granted. The default checks the
   * release's own approval refs (decision === 'APPROVED'); inject a live
   * lookup against @ai-factory/approvals to consult the real store. The
   * policy判定 itself stays in the approvals package.
   */
  isApprovalGranted?: (approvalId: string, release: Release) => boolean;
  /**
   * Default deploy/health-check implementations for this manager; per-call
   * options on deployRelease() override these.
   */
  deployFn?: DeployReleaseOptions['deployFn'];
  healthCheckFn?: DeployReleaseOptions['healthCheckFn'];
  now?: () => string;
}

function defaultIsApprovalGranted(approvalId: string, release: Release): boolean {
  return release.approvals.some(
    (a) => a.approvalId === approvalId && a.decision === 'APPROVED',
  );
}

export class ReleaseManager {
  private readonly releases: Map<string, Release>;
  private readonly environments: Map<string, ManagedEnvironment>;
  private readonly snapshotStore: SnapshotStore;
  private readonly audit: AuditFn;
  private readonly isApprovalGranted: (
    approvalId: string,
    release: Release,
  ) => boolean;
  private readonly defaultDeployFn: DeployReleaseOptions['deployFn'];
  private readonly defaultHealthCheckFn: DeployReleaseOptions['healthCheckFn'];
  private readonly now: () => string;

  constructor(opts: ReleaseManagerOptions = {}) {
    this.releases = opts.releases ?? new Map<string, Release>();
    this.environments = new Map<string, ManagedEnvironment>();
    for (const env of opts.environments ?? DEFAULT_ENVIRONMENTS) {
      this.environments.set(env.id, env);
      this.environments.set(env.name, env);
    }
    this.snapshotStore = opts.snapshotStore ?? new SnapshotStore();
    this.audit = opts.audit ?? noop;
    this.isApprovalGranted = opts.isApprovalGranted ?? defaultIsApprovalGranted;
    this.defaultDeployFn = opts.deployFn;
    this.defaultHealthCheckFn = opts.healthCheckFn;
    this.now = opts.now ?? nowIso;
  }

  private emit(
    action: string,
    release: Release,
    detail: Record<string, unknown> = {},
  ): void {
    this.audit(action, {
      releaseId: release.id,
      version: release.version,
      status: release.status,
      environmentId: release.environmentId,
      ...detail,
    });
  }

  private touch(release: Release): void {
    release.updatedAt = this.now();
  }

  /* ---------------- environments (§40) ---------------- */

  listEnvironments(): ManagedEnvironment[] {
    const seen = new Set<string>();
    const out: ManagedEnvironment[] = [];
    for (const env of this.environments.values()) {
      if (!seen.has(env.id)) {
        seen.add(env.id);
        out.push({ ...env });
      }
    }
    return out;
  }

  /** Resolve an environment by id or by name (LOCAL|DEV|UAT|PROD). */
  getEnvironment(idOrName: string): ManagedEnvironment {
    const env = this.environments.get(idOrName);
    if (!env) throw new EnvironmentNotFoundError(idOrName);
    return { ...env };
  }

  registerEnvironment(env: ManagedEnvironment): void {
    if (!env.id || !env.name) throw new Error('Environment needs an id and a name');
    if (env.secretRefs.some((r) => r.includes('=') || r.includes(':'))) {
      throw new Error(
        'secretRefs must hold reference names only — never key=value pairs',
      );
    }
    this.environments.set(env.id, env);
    this.environments.set(env.name, env);
  }

  /* ---------------- releases ---------------- */

  /** Create a release; the changelog draft is generated automatically. */
  createRelease(input: CreateReleaseInput): Release {
    if (!isValidSemver(input.version)) {
      throw new InvalidSemverError(input.version);
    }
    const environmentId = input.environmentId ?? 'env-dev';
    // Validate the target environment up front so bad releases fail fast.
    this.getEnvironment(environmentId);

    const commits =
      input.commits ?? readGitCommits(process.cwd()) ?? [];
    const release: Release = {
      id: randomUUID(),
      version: input.version,
      artifacts: [...(input.artifacts ?? [])],
      changelog: input.changelog ? [...input.changelog] : draftChangelog(commits),
      environmentId,
      approvals: [],
      status: 'draft',
      createdBy: input.createdBy ?? 'unknown',
      createdAt: this.now(),
      updatedAt: this.now(),
      snapshotId: null,
    };
    this.releases.set(release.id, release);
    this.emit('RELEASE_CREATED', release, {
      changelogLines: release.changelog.length,
    });
    return this.getRelease(release.id);
  }

  getRelease(id: string): Release {
    const r = this.releases.get(id);
    if (!r) throw new ReleaseNotFoundError(id);
    return structuredClone(r);
  }

  listReleases(): Release[] {
    return [...this.releases.values()].map((r) => structuredClone(r));
  }

  /**
   * Attach an approval decision to a release. When the release is parked at
   * pending_approval and the environment's policy is now satisfied, it
   * advances to 'approved'. Audited (spec §70).
   */
  addApproval(releaseId: string, ref: ApprovalRef): Release {
    const release = this.mustGet(releaseId);
    release.approvals.push({ ...ref });
    this.touch(release);
    this.emit('RELEASE_APPROVAL_ADDED', release, {
      approvalId: ref.approvalId,
      decision: ref.decision,
    });
    if (
      release.status === 'pending_approval' &&
      this.policySatisfied(release, this.mustResolveEnv(release.environmentId))
    ) {
      release.status = 'approved';
      this.touch(release);
      this.emit('RELEASE_APPROVED', release, {
        approvalId: ref.approvalId,
      });
    }
    return structuredClone(release);
  }

  /* ---------------- deploy gates (§41 + §77) ---------------- */

  /**
   * True when the environment's approval policy is satisfied by the release.
   * 'none' → always; 'ai' → any granted approval; 'human' (PROD, §41 Mode A)
   * → a granted approval whose level is 'human'. Unspecified levels count as
   * 'ai' so the human gate fails closed.
   */
  policySatisfied(release: Release, env: ManagedEnvironment): boolean {
    if (env.approvalPolicy === 'none') return true;
    const granted = release.approvals.filter((a) =>
      this.isApprovalGranted(a.approvalId, release),
    );
    if (granted.length === 0) return false;
    if (env.approvalPolicy === 'human') {
      return granted.some((a) => (a.level ?? 'ai') === 'human');
    }
    return true;
  }

  /**
   * Deploy a release with the full pre-deploy gate sequence:
   *   1. release + environment exist
   *   2. approval policy satisfied — a 'human' policy needs a granted
   *      human-level approval (an 'ai' policy accepts any granted approval);
   *      otherwise the release parks at pending_approval and
   *      ApprovalRequiredError is thrown
   *   3. §77 snapshot before the deploy (the snapshot id is recorded)
   *   4. deploy
   *   5. health check — on failure the snapshot is restored automatically
   *      and the release becomes 'rolled_back'
   */
  async deployRelease(
    releaseId: string,
    environmentId?: string,
    opts: DeployReleaseOptions = {},
  ): Promise<ReleaseDeployResult> {
    const release = this.mustGet(releaseId);
    const env = this.mustResolveEnv(environmentId ?? release.environmentId);
    if (
      release.status !== 'draft' &&
      release.status !== 'pending_approval' &&
      release.status !== 'approved' &&
      release.status !== 'failed' &&
      release.status !== 'deployed'
    ) {
      throw new ReleaseNotDeployableError(releaseId, release.status);
    }
    // Promotion: an already-deployed release may move to another environment,
    // but redeploying to the same environment it is already on is a no-op.
    if (release.status === 'deployed' && release.environmentId === env.id) {
      throw new ReleaseNotDeployableError(releaseId, release.status);
    }

    // Gate 2 — approval policy (spec §41).
    if (!this.policySatisfied(release, env)) {
      release.status = 'pending_approval';
      this.touch(release);
      this.emit('RELEASE_APPROVAL_REQUIRED', release, {
        approvalPolicy: env.approvalPolicy,
      });
      throw new ApprovalRequiredError(
        release.id,
        env.id,
        env.approvalPolicy,
      );
    }
    if (env.approvalPolicy !== 'none' && release.status !== 'approved') {
      release.status = 'approved';
      this.touch(release);
      this.emit('RELEASE_APPROVED', release, {});
    }

    // Gate 3 — §77: snapshot before the operation.
    const snapshot = this.snapshotStore.take(
      `pre-deploy release ${release.version} → ${env.name}`,
      { releaseId: release.id, version: release.version, environment: env.name },
      env.name,
    );
    release.snapshotId = snapshot.id;
    release.status = 'deploying';
    this.touch(release);
    this.emit('RELEASE_DEPLOY_STARTED', release, { snapshotId: snapshot.id });

    const deployFn =
      opts.deployFn ??
      this.defaultDeployFn ??
      (async () => ({ logs: [`[${env.name}] simulated deploy OK`] }));
    const healthCheckFn =
      opts.healthCheckFn ?? this.defaultHealthCheckFn ?? (async () => true);

    const finish = (status: ReleaseStatus, error?: string): void => {
      release.status = status;
      if (error !== undefined) release.error = error;
      else delete release.error;
      this.touch(release);
    };

    try {
      const result = await deployFn(env, structuredClone(release), snapshot);
      this.audit('RELEASE_DEPLOY_STEP_OK', {
        releaseId: release.id,
        phase: 'deploy',
        logs: result.logs,
      });

      const healthy = await healthCheckFn(env, structuredClone(release));
      if (!healthy) {
        // Spec §77: health failure → restore the pre-deploy snapshot.
        const { snapshot: restored } = rollback(this.snapshotStore, snapshot.id);
        finish(
          'rolled_back',
          `health check failed (${env.healthCheck.type} ${env.healthCheck.target})`,
        );
        this.emit('RELEASE_ROLLED_BACK', release, {
          snapshotId: restored.id,
          reason: release.error,
        });
        return { release: structuredClone(release), snapshot, rolledBack: true };
      }

      finish('deployed');
      release.environmentId = env.id;
      this.touch(release);
      this.emit('RELEASE_DEPLOYED', release, { snapshotId: snapshot.id });
      return { release: structuredClone(release), snapshot, rolledBack: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Deploy itself blew up: still restore the snapshot (§77), and mark
      // the release 'failed' so it can be fixed and redeployed.
      rollback(this.snapshotStore, snapshot.id);
      finish('failed', message);
      this.emit('RELEASE_DEPLOY_FAILED', release, {
        message,
        snapshotId: snapshot.id,
      });
      return { release: structuredClone(release), snapshot, rolledBack: true };
    }
  }

  /**
   * Manually roll a release back to its last §77 pre-deploy snapshot
   * (audited). Throws when no snapshot exists.
   */
  rollbackRelease(releaseId: string): Release {
    const release = this.mustGet(releaseId);
    if (!release.snapshotId) {
      throw new Error(`Release ${releaseId} has no snapshot to roll back to`);
    }
    const { snapshot } = rollback(this.snapshotStore, release.snapshotId);
    release.status = 'rolled_back';
    release.error = 'manual rollback';
    this.touch(release);
    this.emit('RELEASE_ROLLED_BACK', release, {
      snapshotId: snapshot.id,
      manual: true,
    });
    return structuredClone(release);
  }

  /* ---------------- internals ---------------- */

  private mustGet(id: string): Release {
    const r = this.releases.get(id);
    if (!r) throw new ReleaseNotFoundError(id);
    return r;
  }

  private mustResolveEnv(idOrName: string): ManagedEnvironment {
    const env = this.environments.get(idOrName);
    if (!env) throw new EnvironmentNotFoundError(idOrName);
    return env;
  }
}
