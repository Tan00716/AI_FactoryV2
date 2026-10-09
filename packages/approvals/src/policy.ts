/**
 * Tool approval policy — spec §45.
 *
 * Maps sensitive tool actions to the approval level they require.
 * Unknown actions default to AUTO (documented below): the policy is a
 * denylist-style map for *sensitive* actions, so ordinary tools keep working
 * without an approval flow. CRITICAL risk escalates any non-BLOCKED level to
 * HUMAN_APPROVAL — high blast radius always gets a human in the loop.
 */

import type { ApprovalLevel, RiskLevel } from './types';

/** Sensitive action → required approval level. */
export const TOOL_APPROVAL_LEVELS: Record<string, ApprovalLevel> = {
  // Irreversible / production-impacting: human signs off.
  'deploy.prod': 'HUMAN_APPROVAL',
  'secret.read': 'HUMAN_APPROVAL',
  // Never allowed by policy: not even a human can approve these here.
  'secret.write': 'BLOCKED',
  // Reversible but sensitive: AI review is enough.
  'deploy.uat': 'AI_REVIEW',
  'git.push': 'AI_REVIEW',
  'filesystem.delete': 'AI_REVIEW',
  'agent.create': 'AI_REVIEW',
  // Everyday actions: run without approval.
  'filesystem.write': 'AUTO',
  'git.commit': 'AUTO',
};

export interface ActionEvaluation {
  level: ApprovalLevel;
  requiresApproval: boolean;
  reason: string;
}

/**
 * Evaluate what approval an action needs.
 *
 * - Unknown actions default to AUTO (only mapped sensitive actions are gated).
 * - CRITICAL risk escalates any level except BLOCKED to HUMAN_APPROVAL.
 * - BLOCKED actions stay blocked regardless of risk: requiresApproval is true
 *   because a decision was attempted, but the outcome is always a refusal —
 *   the manager will never grant an approval for them.
 */
export function evaluateAction(
  action: string,
  riskLevel: RiskLevel = 'LOW',
): ActionEvaluation {
  const mapped = TOOL_APPROVAL_LEVELS[action];
  const known = mapped !== undefined;
  const base: ApprovalLevel = mapped ?? 'AUTO';

  if (base === 'BLOCKED') {
    return {
      level: 'BLOCKED',
      requiresApproval: true,
      reason: `Action '${action}' is BLOCKED by policy and cannot be approved`,
    };
  }

  let level = base;
  let reason = known
    ? `Policy maps '${action}' → ${base}`
    : `No policy entry for '${action}'; defaulting to AUTO (not a sensitive action)`;

  if (riskLevel === 'CRITICAL' && level !== 'HUMAN_APPROVAL') {
    level = 'HUMAN_APPROVAL';
    reason += `; CRITICAL risk escalates to HUMAN_APPROVAL`;
  }

  return {
    level,
    requiresApproval: level === 'AI_REVIEW' || level === 'HUMAN_APPROVAL',
    reason,
  };
}
