/**
 * @ai-factory/incidents — incident management (SPEC v2 §42).
 *
 * Modules:
 *  - types    lifecycle, severity, runbook, incident shapes   [§42]
 *  - manager  IncidentManager: detection→triage→…→postmortem→closed,
 *             pre-authorized auto-mitigation, threshold-gaming ban [§42]
 */
export * from './types';
export * from './manager';
