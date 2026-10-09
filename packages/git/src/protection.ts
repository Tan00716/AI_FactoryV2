/**
 * Branch protection — spec §34 ("Production branch protection shall be
 * configurable").
 *
 * Pushes to protected branches (e.g. `main`) are rejected so that changes
 * must flow through task branches → commits → PR → merge.
 */

export interface BranchProtection {
  /** Branch names direct pushes are rejected for. Default: main, master. */
  protectedBranches: string[];
  /** Whether merges into protected branches require a PR record. */
  requirePr: boolean;
}

export function defaultBranchProtection(): BranchProtection {
  return { protectedBranches: ['main', 'master'], requirePr: true };
}

export function isProtected(branch: string, protection: BranchProtection): boolean {
  return protection.protectedBranches.includes(branch);
}

/** Error thrown when a push to a protected branch is attempted. */
export class ProtectedBranchError extends Error {
  readonly branch: string;
  constructor(branch: string) {
    super(`push to protected branch "${branch}" is not allowed; merge via PR instead`);
    this.name = 'ProtectedBranchError';
    this.branch = branch;
  }
}

/** Throws ProtectedBranchError when `branch` is protected. */
export function assertPushAllowed(branch: string, protection: BranchProtection): void {
  if (isProtected(branch, protection)) {
    throw new ProtectedBranchError(branch);
  }
}
