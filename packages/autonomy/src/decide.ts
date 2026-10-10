/**
 * Action grading — decide(action, mode): spec §80.
 *
 *   assisted    low → auto; medium+ → human confirms/approves
 *   semi        AI handles routine engineering (low/medium → auto);
 *               high+ (deployments) → human approval
 *   autonomous  everything the policy allows → auto
 *               (critical → human unless a policy explicitly allows it;
 *               high → AI review)
 *   full        everything → auto, including production deploys;
 *               prod deploys are still gated by verifyProdReadiness (§41)
 *
 * This module never blocks on policy data it doesn't have: callers may pass
 * a policy hook via DecideOptions; the default policy is conservative.
 */
import {
  ActionInput,
  ActionRisk,
  AutonomyAction,
  AutonomyMode,
  isActionRisk,
  normalizeAction,
} from './types';

/**
 * Known action kinds and their risk tiers. Examples from the task:
 * run-tests = low, deploy-prod = critical.
 */
export const ACTION_RISKS: Record<string, ActionRisk> = {
  // low — routine, reversible engineering work
  'run-tests': 'low',
  lint: 'low',
  format: 'low',
  build: 'low',
  'code-review': 'low',
  'write-code': 'low',
  refactor: 'low',
  'read-file': 'low',
  'generate-docs': 'low',
  // medium — touches shared/dev environments
  'deploy-staging': 'medium',
  'run-migrations-dev': 'medium',
  'restart-service': 'medium',
  'scale-service': 'medium',
  'merge-pr': 'medium',
  // high — production-adjacent, hard to undo quietly
  'run-migrations-prod': 'high',
  'env-change-prod': 'high',
  'rollback-prod': 'high',
  'secret-read': 'high',
  'secret-rotate': 'high',
  'delete-branch': 'high',
  // critical — production deploys and destructive actions
  'deploy-prod': 'critical',
  'delete-data': 'critical',
  'drop-database': 'critical',
  'disable-monitoring': 'critical',
};

/** Resolve the risk tier of an action; unknown kinds default to medium. */
export function resolveRisk(action: ActionInput): ActionRisk {
  const a = normalizeAction(action);
  if (a.risk !== undefined && isActionRisk(a.risk)) return a.risk;
  return ACTION_RISKS[a.kind] ?? 'medium';
}

/** True when the action is a production deployment. */
export function isProdDeploy(action: ActionInput): boolean {
  const kind = normalizeAction(action).kind;
  return kind === 'deploy-prod' || (kind.includes('prod') && kind.includes('deploy'));
}

/**
 * Optional policy hook. Return true when the action is allowed to proceed
 * automatically in the given mode, false when policy blocks it, or
 * 'ai-review' when policy wants an AI reviewer to look first.
 *
 * The default policy: critical actions are not auto-approved in
 * 'autonomous' mode (§80 reserves unattended prod work for 'full');
 * everything else is allowed.
 */
export type PolicyHook = (action: AutonomyAction, mode: AutonomyMode) => boolean | 'ai-review';

export function defaultPolicy(action: AutonomyAction, mode: AutonomyMode): boolean | 'ai-review' {
  if (mode === 'autonomous' && resolveRisk(action) === 'critical') return false;
  return true;
}

export interface DecideOptions {
  policy?: PolicyHook;
  now?: () => number;
}

/** Decision outcome for one action under one mode. */
export interface AutonomyDecision {
  action: string;
  risk: ActionRisk;
  mode: AutonomyMode;
  /** auto: run now · ai-review: an AI reviewer checks first · human: wait for a human · denied: policy blocks */
  outcome: 'auto' | 'ai-review' | 'human' | 'denied';
  /** finer-grained next step */
  step: 'proceed' | 'review' | 'confirm' | 'approve' | 'blocked';
  reason: string;
  /** Prod deploys must additionally pass verifyProdReadiness (§41), even in full mode. */
  requiresProdVerification: boolean;
  decidedAt: number;
}

function decision(
  action: AutonomyAction,
  risk: ActionRisk,
  mode: AutonomyMode,
  outcome: AutonomyDecision['outcome'],
  step: AutonomyDecision['step'],
  reason: string,
  now: () => number,
): AutonomyDecision {
  return {
    action: action.kind,
    risk,
    mode,
    outcome,
    step,
    reason,
    requiresProdVerification: isProdDeploy(action),
    decidedAt: now(),
  };
}

/**
 * Grade one action under the project's autonomy mode (spec §80).
 * Never throws on unknown actions — they resolve to medium risk.
 */
export function decide(action: ActionInput, mode: AutonomyMode, opts: DecideOptions = {}): AutonomyDecision {
  const a = normalizeAction(action);
  const risk = resolveRisk(a);
  const now = opts.now ?? Date.now;
  const policy = opts.policy ?? defaultPolicy;

  switch (mode) {
    case 'assisted':
      // Human confirms major actions (§80: "Human confirms major actions").
      if (risk === 'low') {
        return decision(a, risk, mode, 'auto', 'proceed', 'assisted: low-risk action, no confirmation needed / 低风险动作，无需确认', now);
      }
      if (risk === 'medium') {
        return decision(a, risk, mode, 'human', 'confirm', 'assisted: medium+ action needs human confirmation / 中风险及以上动作需要人类确认', now);
      }
      return decision(a, risk, mode, 'human', 'approve', `assisted: ${risk}-risk action needs human approval / 高风险动作需要人类审批`, now);

    case 'semi':
      // AI handles routine engineering; human approves deployments (§80).
      if (risk === 'low' || risk === 'medium') {
        return decision(a, risk, mode, 'auto', 'proceed', `semi: routine engineering (${risk}) handled by AI / 常规工程动作由 AI 自动处理`, now);
      }
      return decision(a, risk, mode, 'human', 'approve', `semi: ${risk}-risk deployment-class action needs human approval / 高风险（部署类）动作需要人类审批`, now);

    case 'autonomous': {
      // All workflow actions allowed by policies (§80); critical is
      // policy-gated by default, high gets an AI review.
      if (risk === 'critical') {
        const verdict = policy(a, mode);
        if (verdict === true) {
          return decision(a, risk, mode, 'auto', 'proceed', 'autonomous: policy allows this critical action / 策略允许该关键动作自动执行', now);
        }
        if (verdict === 'ai-review') {
          return decision(a, risk, mode, 'ai-review', 'review', 'autonomous: policy routes critical action to AI review / 策略要求该关键动作先经 AI 复核', now);
        }
        return decision(a, risk, mode, 'denied', 'blocked', 'autonomous: policy blocks this critical action; human may override / 策略阻止该关键动作，需人类介入', now);
      }
      if (risk === 'high') {
        return decision(a, risk, mode, 'ai-review', 'review', 'autonomous: high-risk action proceeds after AI review / 高风险动作经 AI 复核后执行', now);
      }
      return decision(a, risk, mode, 'auto', 'proceed', `autonomous: ${risk}-risk action within policy / 策略允许范围内自动执行`, now);
    }

    case 'full':
      // AI can deploy production when all gates pass (§80 + §41):
      // the deploy action itself is auto, but verifyProdReadiness is mandatory.
      {
        const verdict = policy(a, mode);
        if (verdict === false) {
          return decision(a, risk, mode, 'denied', 'blocked', 'full: policy explicitly blocks this action / 策略明确阻止该动作', now);
        }
        return decision(
          a,
          risk,
          mode,
          'auto',
          'proceed',
          isProdDeploy(a)
            ? 'full: production deploy auto-approved; independent prod-readiness verification still required / 全自动：生产部署自动通过，但仍须独立校验生产就绪清单'
            : 'full: auto / 全自动模式下自动执行',
          now,
        );
      }

    default:
      // Unknown mode: fail closed — demand a human.
      return decision(a, risk, mode as AutonomyMode, 'human', 'approve', `unknown mode '${mode}': fail closed, needs human approval / 未知模式，保守起见需要人类审批`, now);
  }
}
