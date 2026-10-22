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
  {
    id: 'run-completed',
    eventTypes: ['RUN_COMPLETED'],
    build: (e) =>
      outcome(
        `Run completed: ${label(e)}`,
        `Run ${label(e)} finished with outcome ${detail(e, 'outcome') || 'unknown'}` +
          `${detail(e, 'steps') ? ` after ${detail(e, 'steps')} step(s)` : ''}.`,
        'INFO',
      )(e),
  },
  {
    id: 'quality-gate-failed',
    eventTypes: ['QUALITY_GATE_FAILED'],
    build: (e) =>
      outcome(
        `Quality gate failed: ${label(e)}`,
        `The ${detail(e, 'kind') || 'quality'} gate failed${detail(e, 'exitCode') ? ` (exit code ${detail(e, 'exitCode')})` : ''}${detail(e, 'timedOut') === 'true' ? ' — the command timed out' : ''}. Fix the issues and re-run the gate.`,
        'HIGH',
      )(e),
  },
  {
    id: 'security-scan-blocked',
    eventTypes: ['SECURITY_SCAN_BLOCKED'],
    build: (e) =>
      outcome(
        `Security scan blocked: ${label(e)}`,
        `Error-severity security findings: ${detail(e, 'secret') || '0'} secret(s), ${detail(e, 'sast') || '0'} pattern(s), ${detail(e, 'sca') || '0'} vulnerable dependenc(ies). Review the findings in the Security section and fix or exempt them.`,
        'HIGH',
      )(e),
  },
  {
    id: 'scope-violation-detected',
    eventTypes: ['SCOPE_VIOLATION_DETECTED'],
    build: (e) =>
      outcome(
        `Out-of-scope edits detected: ${label(e)}`,
        `Task scope lock: ${detail(e, 'count') || 'some'} file(s) were written outside the task's edit scope: ${detail(e, 'files') || ''}. ` +
          `The writes were NOT rolled back — review them and use the shadow-checkpoint undo if needed.`,
        'HIGH',
      )(e),
  },
  {
    id: 'egress-blocked',
    eventTypes: ['EGRESS_BLOCKED'],
    build: (e) =>
      outcome(
        `Egress blocked: ${label(e)}`,
        `An outbound request to host ${detail(e, 'host') || '(unknown)'} was refused by the egress firewall` +
          `${detail(e, 'reason') === 'deny-rule' && detail(e, 'matchedLayer') ? ` — denied by the ${detail(e, 'matchedLayer')} rule "${detail(e, 'matchedRule')}"` : detail(e, 'reason') === 'default-deny' ? ' — no allow rule matched under the default-deny policy' : ''}` +
          `. Source: ${detail(e, 'source') || 'tool'}. Review the rules in the Egress Firewall section if this call should be allowed.`,
        'HIGH',
      )(e),
  },
  {
    id: 'prompt-secret-blocked',
    eventTypes: ['PROMPT_SECRET_BLOCKED'],
    build: (e) =>
      outcome(
        `Prompt blocked: ${label(e)}`,
        `A prompt about to be sent to ${detail(e, 'adapter') || 'a model adapter'} was blocked because it contained a suspected raw secret (patterns: ${detail(e, 'patterns') || 'unknown'}). ` +
          `The secret never left the process. Remove the secret from the prompt, or switch the pre-send gate to redact mode if the value is intentional.`,
        'HIGH',
      )(e),
  },
  {
    id: 'needs-human-raised',
    eventTypes: ['NEEDS_HUMAN_RAISED'],
    build: (e) =>
      outcome(
        `Human attention needed: ${label(e)}`,
        `${detail(e, 'reason') || label(e)}` +
          `${detail(e, 'severity') ? ` (severity: ${detail(e, 'severity')})` : ''}. ` +
          `Open the Needs Human tab to review.`,
        'HIGH',
      )(e),
  },
  {
    // R3-T1: a new app version is available on the configured update feed.
    // MEDIUM (not HIGH): it never auto-installs; the human decides in the
    // Updates tab. Dedupe keeps one notification per version.
    id: 'update-available',
    eventTypes: ['UPDATE_AVAILABLE'],
    build: (e) =>
      outcome(
        `Update available: ${label(e)}`,
        `AI Factory ${detail(e, 'latest') || label(e)} is available` +
          `${detail(e, 'current') ? ` (you are on ${detail(e, 'current')})` : ''}. ` +
          `Open the Updates tab to review the changelog and install. Nothing is downloaded automatically.`,
        'MEDIUM',
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
