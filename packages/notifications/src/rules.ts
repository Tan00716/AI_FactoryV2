/**
 * @ai-factory/notifications — default rule set (spec module 30).
 *
 * Rule engine semantics: every rule whose `eventTypes` include the incoming
 * event type (and whose optional `when` guard passes) fires, each producing
 * one Notification. Rules are evaluated in registration order.
 *
 * Default policy:
 *   GATE_FAILED        → HIGH
 *   TASK_BLOCKED       → HIGH
 *   DEPLOYMENT_FAILED  → HIGH
 *   BUILD_FAILED       → HIGH
 *   APPROVAL_PENDING   → MEDIUM
 *   DEPLOYMENT_COMPLETED → INFO
 *   TASK_COMPLETED     → INFO
 *   anything else      → INFO (fallback)
 */
import type {
  NotificationEvent,
  NotificationPriority,
  NotificationRule,
  RuleOutcome,
} from './types';

function label(event: NotificationEvent): string {
  return event.entity?.label ?? event.entity?.id ?? 'n/a';
}

function detail(event: NotificationEvent, key: string): string {
  const v = event.detail?.[key];
  return v === undefined || v === null ? '' : String(v);
}

function outcome(
  title: string,
  body: string,
  priority: NotificationPriority,
): (event: NotificationEvent) => RuleOutcome {
  return () => ({ title, body, priority });
}

export const DEFAULT_RULES: NotificationRule[] = [
  {
    id: 'gate-failed',
    eventTypes: ['GATE_FAILED'],
    build: (e) =>
      outcome(
        `Gate failed: ${label(e)}`,
        `A quality gate rejected ${label(e)}${detail(e, 'reason') ? ` — ${detail(e, 'reason')}` : ''}. Fix the blocking findings and re-run before proceeding.`,
        'HIGH',
      )(e),
  },
  {
    id: 'task-blocked',
    eventTypes: ['TASK_BLOCKED'],
    build: (e) =>
      outcome(
        `Task blocked: ${label(e)}`,
        `Task "${label(e)}" is now BLOCKED${detail(e, 'reason') ? ` — ${detail(e, 'reason')}` : ''}. Human attention is required to unblock it.`,
        'HIGH',
      )(e),
  },
  {
    id: 'deployment-failed',
    eventTypes: ['DEPLOYMENT_FAILED'],
    build: (e) =>
      outcome(
        `Deployment failed: ${label(e)}`,
        `Deployment ${label(e)} to ${detail(e, 'environment') || 'target environment'} failed${detail(e, 'reason') ? ` — ${detail(e, 'reason')}` : ''}.`,
        'HIGH',
      )(e),
  },
  {
    id: 'build-failed',
    eventTypes: ['BUILD_FAILED'],
    build: (e) =>
      outcome(
        `Build failed: ${label(e)}`,
        `Build ${label(e)} failed${detail(e, 'reason') ? ` — ${detail(e, 'reason')}` : ''}.`,
        'HIGH',
      )(e),
  },
  {
    id: 'approval-pending',
    eventTypes: ['APPROVAL_PENDING'],
    build: (e) =>
      outcome(
        `Approval requested: ${label(e)}`,
        `Action "${label(e)}" needs a decision${detail(e, 'riskLevel') ? ` (risk: ${detail(e, 'riskLevel')})` : ''}. Open the Approvals tab to approve or reject.`,
        'MEDIUM',
      )(e),
  },
  {
    id: 'approval-decided',
    eventTypes: ['APPROVAL_DECIDED'],
    build: (e) =>
      outcome(
        `Approval ${detail(e, 'decision') || 'decided'}: ${label(e)}`,
        `The approval for "${label(e)}" was ${detail(e, 'decision') || 'decided'}.`,
        'INFO',
      )(e),
  },
  {
    id: 'deployment-completed',
    eventTypes: ['DEPLOYMENT_COMPLETED'],
    build: (e) =>
      outcome(
        `Deployment completed: ${label(e)}`,
        `Deployment ${label(e)} to ${detail(e, 'environment') || 'target environment'} completed successfully.`,
        'INFO',
      )(e),
  },
  {
    id: 'task-completed',
    eventTypes: ['TASK_COMPLETED'],
    build: (e) =>
      outcome(
        `Task completed: ${label(e)}`,
        `Task "${label(e)}" reached DONE.`,
        'INFO',
      )(e),
  },
  // Fallback: any unmatched event still produces an INFO notification so
  // nothing is silently dropped.
  {
    id: 'fallback',
    eventTypes: [
      'TASK_BLOCKED', 'GATE_FAILED', 'DEPLOYMENT_COMPLETED', 'DEPLOYMENT_FAILED',
      'APPROVAL_PENDING', 'APPROVAL_DECIDED', 'BUILD_FAILED', 'TASK_COMPLETED', 'GENERIC',
    ],
    when: (e) => !DEFAULT_RULES.some((r) => r.id !== 'fallback' && r.eventTypes.includes(e.type)),
    build: (e) =>
      outcome(`Event: ${e.type}`, `Received event of type ${e.type}.`, 'INFO')(e),
  },
];

/** Match the rules that apply to an event, in registration order. */
export function matchRules(
  event: NotificationEvent,
  rules: readonly NotificationRule[] = DEFAULT_RULES,
): NotificationRule[] {
  return rules.filter(
    (r) => r.eventTypes.includes(event.type) && (!r.when || r.when(event)),
  );
}
