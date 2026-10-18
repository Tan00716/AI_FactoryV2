/**
 * Tier policy evaluation + operator-editable defaults (W-C).
 */
import {
  type PermissionTier,
  type TierEvaluation,
  type TierPolicy,
  type TierVerdict,
} from './types.js';

/**
 * Default policies. Deny-lists are explicit; every tier ends with a
 * '*' catch-all so unknown actions fail towards the human (read and
 * write) or towards ask (exec/admin — operators run novel actions).
 */
export const DEFAULT_TIER_POLICIES: Record<PermissionTier, TierPolicy> = {
  read: {
    tier: 'read',
    auto: [
      '*.read',
      'filesystem.list',
      'git.status',
      'git.log',
      'knowledge.*',
      'memory.read',
    ],
    // Everything else asks: the human stays in control, the agent
    // never acts alone outside its read scope.
    ask: ['*'],
    deny: [],
  },
  write: {
    tier: 'write',
    auto: [
      '*.read',
      'filesystem.list',
      'filesystem.write',
      'git.status',
      'git.log',
      'git.commit',
      'knowledge.*',
      'memory.read',
      'memory.write',
      'task.*',
    ],
    ask: ['filesystem.delete', 'git.push', '*'],
    deny: ['secret.*', 'deploy.prod'],
  },
  exec: {
    tier: 'exec',
    auto: [
      '*.read',
      'filesystem.list',
      'filesystem.write',
      'git.status',
      'git.log',
      'git.commit',
      'knowledge.*',
      'memory.read',
      'memory.write',
      'task.*',
      'exec.run',
      'terminal.*',
      'build.*',
    ],
    ask: ['filesystem.delete', 'git.push', 'deploy.uat', '*'],
    deny: ['secret.*', 'deploy.prod', 'admin.*'],
  },
  admin: {
    tier: 'admin',
    auto: ['*'],
    ask: [],
    // Note: approvals-BLOCKED actions (e.g. 'secret.write') stay
    // blocked via strictest-wins composition in the server layer —
    // the tier alone never grants them.
    deny: [],
  },
};

export function defaultTierPolicy(tier: PermissionTier): TierPolicy {
  const p = DEFAULT_TIER_POLICIES[tier];
  return { tier: p.tier, auto: [...p.auto], ask: [...p.ask], deny: [...p.deny] };
}

/**
 * Pattern match over dot-namespaced actions. Each dot-separated
 * segment matches exactly, or '*' matches any single segment;
 * pattern '*' matches everything. A trailing '.*' additionally
 * matches the bare prefix ('filesystem.*' ~ 'filesystem').
 */
export function matchesPattern(pattern: string, action: string): boolean {
  if (pattern === '*') return true;
  const pp = pattern.split('.');
  const ap = action.split('.');
  if (pp.length === 2 && pp[1] === '*' && ap.length === 1 && ap[0] === pp[0]) return true;
  if (pp.length !== ap.length) return false;
  return pp.every((seg, i) => seg === '*' || seg === ap[i]);
}

/**
 * Evaluate one action against one tier policy.
 *
 * Firewall semantics: among ALL matching patterns across the three
 * lists, the MOST SPECIFIC pattern wins (most non-wildcard
 * characters); ties break deny > ask > auto. No match at all →
 * 'ask' (fail-closed towards the human). This lets a tier say
 * `ask: ['*']` (default-ask) while `auto: ['knowledge.*']` still
 * auto-allows — the specific rule beats the catch-all.
 */
export function evaluateTierPolicy(policy: TierPolicy, action: string): TierEvaluation {
  const specificity = (pattern: string): number => pattern.replace(/\*/g, '').length;
  const rank: Record<TierVerdict, number> = { deny: 3, ask: 2, auto: 1 };
  let best: { verdict: TierVerdict; pattern: string; score: number } | undefined;
  const consider = (verdict: TierVerdict, pattern: string): void => {
    if (!matchesPattern(pattern, action)) return;
    const score = specificity(pattern);
    if (
      best === undefined ||
      score > best.score ||
      (score === best.score && rank[verdict] > rank[best.verdict])
    ) {
      best = { verdict, pattern, score };
    }
  };
  for (const p of policy.deny) consider('deny', p);
  for (const p of policy.ask) consider('ask', p);
  for (const p of policy.auto) consider('auto', p);
  if (best === undefined) {
    return {
      tier: policy.tier,
      action,
      verdict: 'ask',
      reasons: [`tier '${policy.tier}' has no rule for '${action}' — default ask`],
    };
  }
  const v = best.verdict;
  const what = v === 'auto' ? 'auto-allows' : v === 'ask' ? 'requires approval for' : 'denies';
  return {
    tier: policy.tier,
    action,
    verdict: v,
    reasons: [`tier '${policy.tier}' ${what} '${action}' (pattern '${best.pattern}')`],
  };
}

/** Validate an operator-supplied policy (route layer uses this). */
export function validateTierPolicy(input: unknown): { ok: true; policy: Omit<TierPolicy, 'tier'> } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'policy must be an object {auto[], ask[], deny[]}' };
  }
  const out: Record<'auto' | 'ask' | 'deny', string[]> = { auto: [], ask: [], deny: [] };
  for (const k of ['auto', 'ask', 'deny'] as const) {
    const v = (input as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((e) => typeof e === 'string' && e.length > 0)) {
      return { ok: false, error: `'${k}' must be an array of non-empty pattern strings` };
    }
    out[k] = [...(v as string[])];
  }
  return { ok: true, policy: out };
}
