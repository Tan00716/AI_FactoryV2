/**
 * Human exception handler — spec §81.
 *
 * "Human intervention should mainly occur when: Requirement ambiguity,
 * Policy violation, Repeated failure, Budget exceeded, High-risk deployment,
 * Security issue, Irrecoverable environment error, AI disagreement."
 *
 * The system should NOT ask "Should I run the tests?" every five minutes —
 * it should ask only when policy or uncertainty requires it. needsHuman()
 * returns an escalation record for exactly the eight §81 triggers and
 * nothing else.
 */
import { randomUUID } from 'crypto';

/** The eight §81 triggers that route to a human. */
export const HUMAN_NEED_REASONS = [
  'requirement-ambiguity',
  'policy-violation',
  'repeated-failure',
  'budget-exceeded',
  'high-risk-deployment',
  'security-issue',
  'irrecoverable-env-error',
  'ai-disagreement',
] as const;

export type HumanNeedReason = (typeof HUMAN_NEED_REASONS)[number];

export const HUMAN_NEED_REASON_ZH: Record<HumanNeedReason, string> = {
  'requirement-ambiguity': '需求歧义',
  'policy-violation': '策略违规',
  'repeated-failure': '重复失败',
  'budget-exceeded': '预算超限',
  'high-risk-deployment': '高风险部署',
  'security-issue': '安全问题',
  'irrecoverable-env-error': '不可恢复环境错误',
  'ai-disagreement': 'AI 分歧',
};

export type EscalationSeverity = 'medium' | 'high' | 'critical';

const REASON_SEVERITY: Record<HumanNeedReason, EscalationSeverity> = {
  'requirement-ambiguity': 'medium',
  'policy-violation': 'critical',
  'repeated-failure': 'medium',
  'budget-exceeded': 'high',
  'high-risk-deployment': 'high',
  'security-issue': 'critical',
  'irrecoverable-env-error': 'critical',
  'ai-disagreement': 'medium',
};

/** Upgrade/escalation record generated when a human is needed. */
export interface EscalationRecord {
  id: string;
  reason: HumanNeedReason;
  reasonZh: string;
  severity: EscalationSeverity;
  /** Free-form context, e.g. what was ambiguous or which policy was violated. */
  detail?: string;
  /** Related task/agent/deploy ids for traceability. */
  context?: Record<string, string>;
  detectedAt: string;
  // --- SPEC §15 escalation contract (all optional, additive) ---
  /** 原命令：the command/request that triggered the escalation. */
  originalCommand?: string;
  /** 授权/政策版本：authorization/policy version in force at escalation. */
  authPolicyVersion?: string;
  /** Evidence 引用：evidence record ids supporting the escalation. */
  evidenceRefs?: string[];
  /** 影响范围：blast radius / scope affected. */
  impactScope?: string;
  /** 已停止动作：actions already halted pending the escalation outcome. */
  stoppedActions?: string[];
  /** 建议：recommended next step for the recipient. */
  suggestion?: string;
  /** 期限：ISO timestamp by which the escalation needs a decision. */
  deadline?: string;
  /** 接收方：who should handle it, e.g. 'human:alice', 'security-authority'. */
  recipient?: string;
}

export function isHumanNeedReason(value: unknown): value is HumanNeedReason {
  return (
    typeof value === 'string' &&
    (HUMAN_NEED_REASONS as readonly string[]).includes(value)
  );
}

export interface NeedsHumanOptions {
  now?: () => number;
  detail?: string;
  context?: Record<string, string>;
  originalCommand?: string;
  authPolicyVersion?: string;
  evidenceRefs?: string[];
  impactScope?: string;
  stoppedActions?: string[];
  suggestion?: string;
  deadline?: string;
  recipient?: string;
}

/**
 * §81 trigger → escalation record. Always returns a record for one of the
 * eight known triggers (the type system enforces the input is one of them).
 */
export function needsHuman(
  reason: HumanNeedReason,
  opts: NeedsHumanOptions = {},
): EscalationRecord {
  const now = opts.now ?? Date.now;
  return {
    id: randomUUID(),
    reason,
    reasonZh: HUMAN_NEED_REASON_ZH[reason],
    severity: REASON_SEVERITY[reason],
    detail: opts.detail,
    context: opts.context,
    detectedAt: new Date(now()).toISOString(),
    originalCommand: opts.originalCommand,
    authPolicyVersion: opts.authPolicyVersion,
    evidenceRefs: opts.evidenceRefs,
    impactScope: opts.impactScope,
    stoppedActions: opts.stoppedActions,
    suggestion: opts.suggestion,
    deadline: opts.deadline,
    recipient: opts.recipient,
  };
}

/**
 * Evaluate an arbitrary reason string: returns an escalation record when it
 * is one of the eight §81 triggers, null otherwise. Routine work (e.g.
 * "should I run the tests?") never escalates.
 */
export function evaluateEscalation(
  reason: string,
  opts: NeedsHumanOptions = {},
): EscalationRecord | null {
  if (!isHumanNeedReason(reason)) return null;
  return needsHuman(reason, opts);
}
