/**
 * Shared types for @ai-factory/autonomy — spec §80 (Autonomous Mode),
 * §81 (human as exception handler), and the §41 production-policy checklist.
 */

/** §80 — the four autonomy tiers, project-level setting. */
export type AutonomyMode = 'assisted' | 'semi' | 'autonomous' | 'full';

export const ALL_AUTONOMY_MODES: readonly AutonomyMode[] = [
  'assisted',
  'semi',
  'autonomous',
  'full',
];

export const AUTONOMY_MODE_ZH: Record<AutonomyMode, string> = {
  assisted: '辅助模式',
  semi: '半自动模式',
  autonomous: '自动模式',
  full: '全自动模式',
};

/** §80 — project-level autonomy setting. */
export interface ProjectAutonomy {
  projectId: string;
  mode: AutonomyMode;
  updatedBy: string;
  /** ISO timestamp of the last change. */
  updatedAt: string;
}

/** Risk tier of an action (mirrors @ai-factory/approvals RiskLevel, lowercase). */
export type ActionRisk = 'low' | 'medium' | 'high' | 'critical';

export const ALL_ACTION_RISKS: readonly ActionRisk[] = [
  'low',
  'medium',
  'high',
  'critical',
];

/** An action awaiting an autonomy decision. */
export interface AutonomyAction {
  /** Machine-readable action kind, e.g. 'run-tests', 'deploy-prod'. */
  kind: string;
  /** Explicit risk override; when absent it is resolved from ACTION_RISKS. */
  risk?: ActionRisk;
  /** Short human-readable summary, e.g. 'Deploy v1.4.2 to production'. */
  summary?: string;
  /** Target environment or resource, e.g. 'production'. */
  target?: string;
}

export type ActionInput = string | AutonomyAction;

/** Normalize any action input to a full AutonomyAction object. */
export function normalizeAction(action: ActionInput): AutonomyAction {
  return typeof action === 'string' ? { kind: action } : { ...action };
}

/** True when the string is one of the four known modes. */
export function isAutonomyMode(value: unknown): value is AutonomyMode {
  return (
    typeof value === 'string' &&
    (ALL_AUTONOMY_MODES as readonly string[]).includes(value)
  );
}

/** True when the string is one of the four known risk tiers. */
export function isActionRisk(value: unknown): value is ActionRisk {
  return (
    typeof value === 'string' &&
    (ALL_ACTION_RISKS as readonly string[]).includes(value)
  );
}
