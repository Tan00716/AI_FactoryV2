/**
 * Reproducible builds — SPEC v2 §40.
 *
 * A build locks: Revision, Lockfile, Toolchain, Build Definition, Config and
 * dependency sources. The resulting digest is stored (with SBOM/attestation
 * when policy requires). A UAT-verified artifact promotes straight to
 * production; if the artifact was rebuilt for the new environment (new
 * digest), the applicable verification must run again — a new digest is a
 * new artifact.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Well-known lockfile names, checked in order. The first hit wins for
 * lockfileHash; every hit is recorded in dependencySources.
 */
export const LOCKFILE_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
] as const;

/** sha256 hex of a UTF-8 string. */
export function sha256String(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** sha256 hex of a file's bytes (streamed, not slurped). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Lockfiles present directly under `dir` (repo root of a worktree).
 * Returns absolute paths. Never throws on a missing/unreadable dir —
 * an absent lockfile is a real "no lockfile" answer, not an error.
 */
export function detectLockfiles(dir: string): string[] {
  let names: Set<string>;
  try {
    names = new Set(readdirSync(dir));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const n of LOCKFILE_NAMES) {
    if (names.has(n)) {
      const p = join(dir, n);
      try {
        if (statSync(p).isFile()) found.push(p);
      } catch {
        /* raced away — treat as absent */
      }
    }
  }
  return found;
}

export interface AssembleBuildDefinitionInput {
  /** The merged candidate SHA — the revision being built. */
  revision: string;
  /** Absolute path of the clean worktree checked out at revision. */
  workDir: string;
  /** The exact build command that will run (or ran). */
  buildCommand: string;
  /** Toolchain identifier, e.g. "node 22.1.0". Operator-configured via
   *  FACTORY_BUILD_TOOLCHAIN; when unset it defaults to the real
   *  execution environment (the node that actually ran the build) —
   *  documented, not detected from repo heuristics. */
  toolchain?: string;
  /**
   * Repo-relative config files whose bytes feed configHash
   * (e.g. ["tsconfig.json"]). Missing files are skipped loudly in
   * `skipped` — never silently treated as empty.
   */
  configFiles?: string[];
}

export interface AssembledBuildDefinition {
  /** The BuildDefinition when every required input was assemblable. */
  definition: BuildDefinition | null;
  /**
   * Required inputs that could not be honestly established. When
   * non-empty the caller must NOT call lockBuild — the digest stays
   * null with these named.
   */
  missing: string[];
  /** Repo-relative lockfile paths found (feeds dependencySources). */
  lockfilePaths: string[];
  /** Config files that were listed but absent in the worktree. */
  skippedConfigFiles: string[];
}

/**
 * Assemble a BuildDefinition from the real state of a worktree.
 * Pure honest accounting: every field is either computed from real
 * bytes or reported missing. Returns definition=null with the missing
 * names when lockBuild's required inputs cannot be established —
 * calling lockBuild with invented inputs would fabricate a digest.
 */
export async function assembleBuildDefinition(
  input: AssembleBuildDefinitionInput,
): Promise<AssembledBuildDefinition> {
  const missing: string[] = [];
  const skippedConfigFiles: string[] = [];
  if (!input.revision) missing.push('revision');

  const lockfiles = detectLockfiles(input.workDir);
  const lockfilePaths = lockfiles.map((p) =>
    p.startsWith(input.workDir + '/') ? p.slice(input.workDir.length + 1) : p,
  );
  let lockfileHash: string | null = null;
  if (lockfiles.length > 0) {
    lockfileHash = await sha256File(lockfiles[0]);
  } else {
    missing.push('lockfileHash');
  }

  const toolchain =
    input.toolchain && input.toolchain.length > 0
      ? input.toolchain
      : // Honest default: the runtime that actually executes the build.
        // An operator building with a different toolchain (cargo, go)
        // MUST set FACTORY_BUILD_TOOLCHAIN explicitly — this default
        // describes the execution environment, not the repo's wishes.
        `node ${process.version} ${process.platform}-${process.arch}`;

  const buildDefinitionHash = sha256String(input.buildCommand);

  let configHash: string | null = null;
  const configFiles = input.configFiles ?? [];
  if (configFiles.length > 0) {
    const parts: string[] = [];
    for (const rel of configFiles) {
      const p = join(input.workDir, rel);
      try {
        parts.push(`${rel}:${await sha256File(p)}`);
      } catch {
        skippedConfigFiles.push(rel);
      }
    }
    if (parts.length > 0) {
      configHash = sha256String(parts.sort().join('\n'));
    } else {
      missing.push('configHash');
    }
  } else {
    missing.push('configHash');
  }

  if (missing.length > 0) {
    return { definition: null, missing, lockfilePaths, skippedConfigFiles };
  }
  return {
    definition: {
      revision: input.revision,
      lockfileHash: lockfileHash as string,
      toolchain: toolchain as string,
      buildDefinitionHash,
      configHash: configHash as string,
      dependencySources: lockfilePaths,
    },
    missing,
    lockfilePaths,
    skippedConfigFiles,
  };
}

export interface BuildDefinition {
  revision: string;
  lockfileHash: string;
  toolchain: string;
  buildDefinitionHash: string;
  configHash: string;
  dependencySources: string[];
}

export interface BuildRecord {
  digest: string;
  definition: BuildDefinition;
  sbomRef?: string;
  attestationRef?: string;
  builtAt: string;
  builtBy: string;
}

/** Lock a build: hash every locked input into a stable digest. */
export function lockBuild(def: BuildDefinition, builtBy: string, now: () => number = Date.now): BuildRecord {
  for (const [k, v] of Object.entries(def)) {
    if (k !== 'dependencySources' && (v === undefined || v === '')) {
      throw new Error(`BuildDefinition.${k} is required to lock a build`);
    }
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        revision: def.revision,
        lockfileHash: def.lockfileHash,
        toolchain: def.toolchain,
        buildDefinitionHash: def.buildDefinitionHash,
        configHash: def.configHash,
        dependencySources: [...def.dependencySources].sort(),
      }),
    )
    .digest('hex');
  return { digest, definition: def, builtAt: new Date(now()).toISOString(), builtBy };
}

export class ReverificationRequiredError extends Error {
  constructor(oldDigest: string, newDigest: string) {
    super(
      `Artifact was rebuilt (digest ${oldDigest.slice(0, 12)} → ${newDigest.slice(0, 12)}): ` +
        'a new digest is a new artifact — applicable verification must run again before promotion',
    );
    this.name = 'ReverificationRequiredError';
  }
}

export interface PromotionInput {
  /** Digest of the UAT-verified artifact. */
  uatVerifiedDigest: string;
  /** Digest of the artifact proposed for production. */
  candidateDigest: string;
  targetEnv: 'PROD' | string;
}

/**
 * Promote a UAT-verified artifact toward production.
 * Same digest → direct promotion. New digest → ReverificationRequiredError.
 */
export function promoteArtifact(input: PromotionInput): { promoted: true; digest: string } {
  if (input.candidateDigest !== input.uatVerifiedDigest) {
    throw new ReverificationRequiredError(input.uatVerifiedDigest, input.candidateDigest);
  }
  return { promoted: true, digest: input.candidateDigest };
}
