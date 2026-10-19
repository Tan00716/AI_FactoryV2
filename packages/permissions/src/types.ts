/**
 * Permission tiers — W-C unified permission model.
 *
 * Four tiers, least → most privilege:
 *   read   — observe only: reads, status, logs.
 *   write  — read + reversible writes: files, commits, memory, tasks.
 *   exec   — write + execution: shell commands, builds, terminals.
 *   admin  — everything except policy-BLOCKED actions.
 *
 * Each tier carries an auto/ask/deny policy over dot-namespaced
 * action names (the same namespace the approvals engine uses, e.g.
 * 'filesystem.write', 'git.push', 'deploy.prod'):
 *   auto — the action proceeds without asking;
 *   ask  — the action must go through the approval gate;
 *   deny — the action is refused outright (tier-level).
 *
 * Patterns are exact names ('git.push'), segment wildcards
 * ('filesystem.*', '*.read') or the global wildcard ('*').
 * Firewall semantics: the most specific matching pattern wins
 * (ties break deny > ask > auto). Unknown actions (no pattern
 * matches) are 'ask' — fail-closed towards the human.
 *
 * Integration contract (does NOT overturn existing gates):
 * the tier verdict composes with the approvals engine
 * (evaluateAction) by strictest-wins: a tier can only make an
 * action MORE restrictive, never less. An approvals-BLOCKED action
 * (e.g. 'secret.write') stays blocked for every tier including admin.
 */
export type PermissionTier = 'read' | 'write' | 'exec' | 'admin';

export const PERMISSION_TIERS: readonly PermissionTier[] = ['read', 'write', 'exec', 'admin'];

/** Tier-local verdict before composition with the approvals engine. */
export type TierVerdict = 'auto' | 'ask' | 'deny';

export interface TierPolicy {
  tier: PermissionTier;
  /** Exact action names or prefix patterns ('filesystem.*') / '*'. */
  auto: string[];
  ask: string[];
  deny: string[];
}

export interface TierEvaluation {
  tier: PermissionTier;
  action: string;
  verdict: TierVerdict;
  /** Human-readable reasons, most significant first. */
  reasons: string[];
}

export function isPermissionTier(v: unknown): v is PermissionTier {
  return (PERMISSION_TIERS as readonly unknown[]).includes(v);
}

/**
 * Declarative allow/ask/deny tool rule (Claude Code-style).
 *
 * A rule names a tool (exact name or glob: 'Bash', 'shell.execute',
 * 'mcp__*') and a glob pattern over that tool's target string (the
 * command line for shell tools, the path for file tools), with an
 * effect. See rules.ts for evaluation order (deny > ask > allow) and
 * glob semantics.
 */
export type RuleEffect = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  tool: string;
  pattern: string;
  effect: RuleEffect;
}
