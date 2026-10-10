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
