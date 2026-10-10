/**
 * @ai-factory/cicd — CI/CD engine (spec §39–§41, §77).
 *
 * Modules:
 *  - types        pipeline / stage / environment / snapshot / deployment types [§39, §40, §41, §77]
 *  - environments default LOCAL/DEV/UAT/PROD + approvals-policy-derived approval policy [§40, §41]
 *  - pipeline     ordered stage runner with injectable handlers + evidence/audit callbacks [§39]
 *  - deploy       gated deploys: rollback-capability gate, approval gate via
 *                 @ai-factory/approvals, snapshots + auto-rollback on failure [§41, §77]
 *  - release      Environment Manager + Release Manager: full §40 environment
 *                 model, semver releases with changelog drafts, gated deploys
 *                 with health checks and auto-rollback [§40, §41, §77]
 */
export * from './types';
export * from './environments';
export * from './pipeline';
export * from './deploy';
export * from './release';
