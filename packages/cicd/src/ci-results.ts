/**
 * External CI result verification — SPEC v2 §40.
 *
 * CI results from real platforms (GitHub/Azure/local adapters) arrive via
 * authenticated webhook or attested query. An unverified external claim of
 * PASS is REFUSED — it can never write a PASS into our gates.
 *
 * Also handled here: dedup of repeated triggers, rejection of stale jobs
 * and revision mismatches.
 */
import { createHash } from 'node:crypto';

export type CiResultVerdict = 'PASS' | 'FAIL';

/** What an external CI platform claims. */
export interface ExternalCiResult {
  platform: string;
  repository: string;
  ref: string;
  headSha: string;
  jobId: string;
  verdict: CiResultVerdict;
  /** Webhook signature / query attestation proving the platform sent this. */
  authProof: string;
  receivedAt: string;
}

/** Verifier injected by the server: checks authProof against the platform's secret. */
export type AuthProofVerifier = (result: ExternalCiResult) => boolean;

export class UnverifiedCiResultError extends Error {
  constructor(reason: string) {
    super(`Unverified external CI result refused: ${reason}. Unauthenticated PASS claims can never open a gate.`);
    this.name = 'UnverifiedCiResultError';
  }
}

export class StaleCiResultError extends Error {
  constructor(jobId: string) {
    super(`CI result for job ${jobId} is stale or a duplicate — refused`);
    this.name = 'StaleCiResultError';
  }
}

export class CiRevisionMismatchError extends Error {
  constructor(expected: string, got: string) {
    super(`CI result head SHA ${got} does not match current candidate ${expected} — refused`);
    this.name = 'CiRevisionMismatchError';
  }
}

function resultKey(r: ExternalCiResult): string {
  return createHash('sha256')
    .update(`${r.platform}|${r.repository}|${r.ref}|${r.headSha}|${r.jobId}`)
    .digest('hex');
}

/**
 * Verify and accept an external CI result.
 * Throws UnverifiedCiResultError / StaleCiResultError / CiRevisionMismatchError.
 * Returns the dedup key for the accepted result.
 */
export class ExternalCiResultVerifier {
  private readonly seen = new Set<string>();

  constructor(private readonly verifyAuth: AuthProofVerifier) {}

  accept(result: ExternalCiResult, currentCandidateSha: string): string {
    if (!result.authProof || !this.verifyAuth(result)) {
      throw new UnverifiedCiResultError(`auth proof invalid for job ${result.jobId}`);
    }
    if (result.headSha !== currentCandidateSha) {
      throw new CiRevisionMismatchError(currentCandidateSha, result.headSha);
    }
    const key = resultKey(result);
    if (this.seen.has(key)) {
      throw new StaleCiResultError(result.jobId);
    }
    this.seen.add(key);
    return key;
  }
}
