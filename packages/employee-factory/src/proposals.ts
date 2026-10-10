/**
 * AI organization self-modification proposals — spec §59.
 *
 * AI may propose: Create Agent, Modify Agent, Retire Agent (plus skill /
 * department changes in the full spec; this prototype covers agent
 * lifecycle proposals). Governance determines whether the change is
 * immediately applied:
 *
 *   Tech Lead: Create PostgreSQL Specialist → Policy: Auto-approved → CREATE
 *   Agent:      Create Production Administrator → Policy: BLOCK → DENIED
 */

import { randomUUID } from 'crypto';
import type { Permission } from '@ai-factory/core';
import type { Clock } from './factory';
import type { FactoryPolicy } from './governance';

export type ProposalKind = 'create' | 'modify' | 'retire';
export type ProposalStatus = 'auto-approved' | 'denied' | 'needs-review';

export interface ChangeProposal {
  kind: ProposalKind;
  /** What the proposal targets: a role name for create, an agent id for modify/retire. */
  target: string;
  rationale: string;
  requestedBy: string;
  /** Permissions the proposal would grant (used for privileged-permission checks). */
  permissions?: Permission[];
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  target: string;
  rationale: string;
  requestedBy: string;
  status: ProposalStatus;
  decidedBy: 'policy';
  reason: string;
  decidedAt: string;
}

/** Role-name fragments that mark a proposal as privileged (always blocked). */
const PRIVILEGED_ROLE_FRAGMENTS = ['production', 'admin', 'root', 'superuser', 'owner'];

/** Permissions that mark a proposal as privileged (always blocked). */
const PRIVILEGED_PERMISSIONS: Permission[] = [
  'deploy.prod',
  'secret.read',
  'agent.delete',
];

/** Core roles whose retirement must go to a human for review. */
const CORE_ROLE_FRAGMENTS = ['pm', 'product manager', 'tech lead'];

/**
 * Decide a self-modification proposal against the factory policy.
 * Deterministic: same inputs → same decision. Pure function (no I/O).
 */
export function proposeChange(
  policy: FactoryPolicy,
  proposal: ChangeProposal,
  ctx?: { clock?: Clock },
): Proposal {
  const target = proposal.target.toLowerCase();
  const stamp = (status: ProposalStatus, reason: string): Proposal => ({
    id: randomUUID(),
    kind: proposal.kind,
    target: proposal.target,
    rationale: proposal.rationale,
    requestedBy: proposal.requestedBy,
    status,
    decidedBy: 'policy',
    reason,
    decidedAt: new Date((ctx?.clock ?? { now: () => Date.now() }).now()).toISOString(),
  });

  // Rule 1 — privileged creation is blocked, whatever the policy allow-lists say.
  if (proposal.kind === 'create') {
    const privilegedRole = PRIVILEGED_ROLE_FRAGMENTS.some((f) => target.includes(f));
    const privilegedPerm = (proposal.permissions ?? []).some(
      (p) =>
        PRIVILEGED_PERMISSIONS.includes(p) ||
        p.startsWith('secret.') ||
        p.startsWith('deploy.prod'),
    );
    if (privilegedRole || privilegedPerm) {
      return stamp(
        'denied',
        privilegedRole
          ? `target "${proposal.target}" is a privileged role — creation blocked (§59)`
          : `requested permissions include privileged capabilities — creation blocked (§59)`,
      );
    }
    // Rule 2 — ordinary specialist create within policy is auto-approved.
    const roleAllowed = policy.allowedRoles.some((r) => target.includes(r.toLowerCase()));
    if (!roleAllowed) {
      return stamp(
        'denied',
        `role "${proposal.target}" is not in the policy's allowed roles`,
      );
    }
    return stamp(
      'auto-approved',
      `ordinary role creation within policy — auto-approved (§59)`,
    );
  }

  // Rule 3 — retiring a core role needs human review.
  if (proposal.kind === 'retire') {
    const core = CORE_ROLE_FRAGMENTS.some((f) => target.includes(f));
    if (core) {
      return stamp(
        'needs-review',
        `retiring core role "${proposal.target}" requires human review (§59)`,
      );
    }
    return stamp('auto-approved', `non-core retirement within policy — auto-approved`);
  }

  // Rule 4 — modify: auto-approve when the target role is policy-allowed.
  const roleAllowed = policy.allowedRoles.some((r) => target.includes(r.toLowerCase()));
  if (!roleAllowed) {
    return stamp(
      'denied',
      `role "${proposal.target}" is not in the policy's allowed roles`,
    );
  }
  return stamp('auto-approved', `ordinary modification within policy — auto-approved`);
}
