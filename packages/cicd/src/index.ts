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
 *  - ci-results   external CI result verification (auth proof, dedup)  [v2 §40]
 *  - build        reproducible build lock + artifact promotion         [v2 §40]
 *  - sbom         lockfile-derived SBOM (CycloneDX-lite)                [v2 §40]
 *  - risk         risk assessment with un-lowerable system floor       [v2 §41.1]
 *  - reversibility reversibility classes, fake-rollback ban           [v2 §41.2]
 *  - predeploy    §41.3 pre-deploy gate checklist + broker identity   [v2 §41.3]
 *  - canary       progressive rollout stages + feature flags          [v2 §41.4]
 *  - outcome      observation window, outcome, emergency recovery     [v2 §41.5/6]
 */
export * from './types';
export * from './environments';
export * from './pipeline';
export * from './deploy';
export * from './release';
export * from './ci-results';
export * from './build';
export * from './sbom';
export * from './risk';
export * from './reversibility';
export * from './predeploy';
export * from './canary';
export * from './outcome';
