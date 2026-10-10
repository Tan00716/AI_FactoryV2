/**
 * System Event Bus — core event types, spec §91.
 *
 * NOTE on count: the §91 block in AI_factory.txt enumerates 29 names
 * (verified by script); the module mirrors them verbatim. The bus accepts
 * only non-empty-string types at runtime (loose validation), so new types
 * can be added here without changing bus semantics.
 */
export const EVENT_TYPES = [
  'PROJECT_CREATED',
  'TASK_CREATED',
  'TASK_STARTED',
  'TASK_ASSIGNED',
  'AGENT_CREATED',
  'AGENT_UPDATED',
  'AGENT_ARCHIVED',
  'RUN_STARTED',
  'RUN_STEP',
  'TOOL_CALLED',
  'ARTIFACT_CREATED',
  'PR_CREATED',
  'REVIEW_COMPLETED',
  'CI_COMPLETED',
  'QA_COMPLETED',
  'DEPLOYMENT_STARTED',
  'DEPLOYMENT_COMPLETED',
  'GATE_PASSED',
  'GATE_FAILED',
  'WORKFLOW_TRANSITIONED',
  'ERROR',
  'BLOCKED',
  'ESCALATED',
  'ROLLBACK_STARTED',
  'ROLLBACK_COMPLETED',
  'TASK_COMPLETED',
  'KNOWLEDGE_UPDATED',
  'SKILL_UPDATED',
  'MCP_UPDATED',
] as const;

/** The §91 system event types. */
export type FactoryEventType = (typeof EVENT_TYPES)[number];

/** Type guard for the §91 vocabulary. */
export function isEventType(v: unknown): v is FactoryEventType {
  return (
    typeof v === 'string' &&
    (EVENT_TYPES as readonly string[]).includes(v)
  );
}
