/**
 * Default environments — spec §40.
 *
 * Approval policy is NOT hardcoded: it is derived from @ai-factory/approvals'
 * policy check (evaluateAction('deploy.<env>')), so the single source of truth
 * for "who must approve a deploy" stays in the approvals package. PROD →
 * HUMAN_APPROVAL via that check (spec §41 Mode A).
 */

import {
  evaluateAction,
  type ActionEvaluation,
  type ApprovalLevel,
} from '@ai-factory/approvals';
import type { ApprovalPolicy, Environment, EnvironmentName } from './types';

/**
 * The sensitive-action name the approvals policy maps to a deploy on an
 * environment. Matches the approvals TOOL_APPROVAL_LEVELS entries
 * ('deploy.prod', 'deploy.uat'); unknown envs default to AUTO there.
 */
export function approvalActionFor(env: EnvironmentName): string {
  return `deploy.${env.toLowerCase()}`;
}

/**
 * Ask @ai-factory/approvals what review a deploy to this environment needs
 * (spec §45 policy check). Returns the raw evaluation so callers can surface
 * the policy reason in UI / audit logs.
 */
export function evaluateApprovalPolicy(env: EnvironmentName): ActionEvaluation {
  return evaluateAction(approvalActionFor(env));
}

/**
 * Map the approvals ApprovalLevel onto the environment approval-policy enum.
 * BLOCKED is not a legal deploy policy; if policy ever maps a deploy action
 * to BLOCKED we refuse the deploy instead of inventing a policy (the deploy
 * path throws ApprovalBlockedError).
 */
export function approvalPolicyFor(env: EnvironmentName): ApprovalPolicy {
  const level: ApprovalLevel = evaluateApprovalPolicy(env).level;
  if (level === 'HUMAN_APPROVAL') return 'HUMAN_APPROVAL';
  if (level === 'AI_REVIEW_PLUS_POLICY') return 'AI_REVIEW';
  if (level === 'AUTO') return 'AUTO';
  throw new ApprovalBlockedError(approvalActionFor(env));
}

export class ApprovalBlockedError extends Error {
  constructor(action: string) {
    super(
      `Deploy action '${action}' is BLOCKED by approval policy and can never be approved`,
    );
    this.name = 'ApprovalBlockedError';
  }
}

/** The four default environments (spec §40). */
export const ENVIRONMENTS: Record<EnvironmentName, Environment> = {
  LOCAL: {
    name: 'LOCAL',
    runtime: 'node:22 local process',
    variables: { NODE_ENV: 'development', PORT: '3000' },
    secretsRef: 'none (local dev)',
    url: 'http://localhost:3000',
    deploymentMethod: 'none — runs in place',
    permissions: ['developer'],
    healthCheck: 'process exit code 0',
    rollbackMethod: 'restart local process / git restore',
    approvalPolicy: approvalPolicyFor('LOCAL'),
  },
  DEV: {
    name: 'DEV',
    runtime: 'node:22 docker compose',
    variables: { NODE_ENV: 'development', PORT: '8080' },
    secretsRef: 'dev-secrets (vault ref)',
    url: 'http://localhost:8080',
    deploymentMethod: 'docker compose up --build',
    permissions: ['developer'],
    healthCheck: 'HTTP GET /healthz → 200',
    rollbackMethod: 'docker compose up with previous image tag',
    approvalPolicy: approvalPolicyFor('DEV'),
  },
  UAT: {
    name: 'UAT',
    runtime: 'k8s staging cluster',
    variables: { NODE_ENV: 'staging', PORT: '8080' },
    secretsRef: 'uat-secrets (vault ref)',
    url: 'https://uat.example.internal',
    deploymentMethod: 'helm upgrade',
    permissions: ['developer', 'qa-lead'],
    healthCheck: 'HTTP GET /healthz → 200, then smoke tests',
    rollbackMethod: 'helm rollback',
    approvalPolicy: approvalPolicyFor('UAT'),
  },
  PROD: {
    name: 'PROD',
    runtime: 'k8s production cluster',
    variables: { NODE_ENV: 'production', PORT: '8080' },
    // Spec §40: agents never receive raw production secrets — vault ref only.
    secretsRef: 'prod-secrets (vault ref, never injected raw)',
    url: 'https://app.example.com',
    deploymentMethod: 'helm upgrade --atomic',
    permissions: ['release-manager'],
    healthCheck: 'HTTP GET /healthz → 200, then smoke tests + canary check',
    rollbackMethod: 'helm rollback',
    // Derived from @ai-factory/approvals: evaluateAction('deploy.prod') → HUMAN_APPROVAL (spec §41 Mode A).
    approvalPolicy: approvalPolicyFor('PROD'),
  },
};

/** Look up a default environment by name. Throws on unknown names. */
export function getEnvironment(name: EnvironmentName): Environment {
  const env = ENVIRONMENTS[name];
  if (!env) throw new Error(`Unknown environment: ${name}`);
  return env;
}
