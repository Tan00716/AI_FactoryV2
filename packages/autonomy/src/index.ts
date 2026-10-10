/**
 * @ai-factory/autonomy — Autonomy Mode (spec §80) with the §41 production
 * policy checklist and §81 human exception handling.
 *
 * Modules:
 *  - types            AutonomyMode, ProjectAutonomy, ActionRisk, AutonomyAction  [§80]
 *  - decide           decide(action, mode) action grading matrix                 [§80]
 *  - readiness        verifyProdReadiness — independent §41 gates, never trusts
 *                     an AI assertion alone                                      [§41, §80]
 *  - escalation       needsHuman / evaluateEscalation — the eight §81 triggers  [§81]
 *  - approval-bridge  requireApproval — loose link to @ai-factory/approvals     [§80, §69]
 *  - store            project-level autonomy settings                           [§80]
 *  - routes           registerAutonomyRoutes(router, deps) HTTP surface
 */
export * from './types';
export * from './decide';
export * from './readiness';
export * from './escalation';
export * from './approval-bridge';
export * from './store';
export * from './routes';
