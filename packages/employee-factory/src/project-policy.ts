/**
 * Project policy store — spec §19 (governance) / INV-08 (Batch 66-d).
 *
 * The policy gate for agent auto-creation (enforcePolicy in governance.ts)
 * needs a FactoryPolicy to check against. This module is the minimal
 * store for it: prototype default policies plus an in-memory keyed store
 * (the seam for per-project tightening).
 *
 * DEFAULT_FACTORY_POLICY is the standing governance posture for employee
 * creation (values as previously defined server-side in
 * apps/server/src/routes/workforce.ts — moved here so src-importing
 * consumers stay dual-mode compliant: bare specifier, no extensionless
 * relative value imports).
 *
 * QA_CREATION_POLICY is the policy gate for QA org auto-creation
 * (packages/qa ensureQaLead / createQaSpecialist with QaCreationGate).
 * It is the factory policy extended ONLY for what the QA org flow
 * itself requires, so wiring the gate does not break the existing flow:
 *   - allowedTools += 'filesystem' (packages/qa requests shell+filesystem);
 *   - allowedModels += 'default' (the QA creation request carries no
 *     model, and enforcePolicy defaults it to 'default');
 *   - maxChildren raised to 16 (8 specialist kinds under one QA Lead;
 *     the factory 6 would deny the 7th specialist — a product call,
 *     not a default).
 *
 * These are prototype defaults. Tightening them (fewer tools, fewer
 * children, stricter budgets) is a per-deployment product decision.
 */
import type { FactoryPolicy } from './governance';

/** Standing factory governance posture (§19). */
export const DEFAULT_FACTORY_POLICY: FactoryPolicy = {
  maxChildren: 6,
  maxDepth: 3,
  maxConcurrentAgents: 8,
  maxTotalAgents: 64,
  maxRuntimeMs: 30 * 60 * 1000,
  maxBudget: 1000,
  allowedRoles: [
    'engineer', 'developer', 'qa', 'tester', 'specialist', 'designer',
    'analyst', 'reviewer', 'lead', 'architect', 'devops',
  ],
  allowedModels: ['fast-classifier', 'code-coder', 'reasoning-architect', 'vision-capable', 'local-private', 'reasoning'],
  allowedTools: ['read', 'write', 'shell', 'git', 'test', 'Repository', 'Terminal', 'SQL Sandbox', 'Static Analyzer'],
  allowedPermissions: [
    'filesystem.read', 'filesystem.write', 'shell.execute', 'git.commit',
    'git.push', 'git.merge', 'github.pull_request', 'database.read',
    'deploy.dev', 'deploy.uat', 'agent.create', 'workflow.modify',
  ],
};

/**
 * QA org creation policy (INV-08). Same governance posture as
 * DEFAULT_FACTORY_POLICY; extended only for what the QA org flow requires.
 * Prototype defaults — tighten per deployment.
 */
export const QA_CREATION_POLICY: FactoryPolicy = {
  ...DEFAULT_FACTORY_POLICY,
  maxChildren: 16,
  allowedModels: [...DEFAULT_FACTORY_POLICY.allowedModels, 'default'],
  allowedTools: [...DEFAULT_FACTORY_POLICY.allowedTools, 'filesystem'],
};

/**
 * Minimal project policy store.
 *
 * In-memory, keyed by project id; unknown keys fall back to the default
 * policy. The server wires one instance into RouteContext; routes that
 * auto-create agents (qa.ts) read their gate policy from it. An embedder
 * without the store omits it from the context and the route falls back
 * to QA_CREATION_POLICY — wiring only, no behavior change.
 */
export class FactoryPolicyStore {
  private readonly policies = new Map<string, FactoryPolicy>();

  constructor(private readonly defaultPolicy: FactoryPolicy = QA_CREATION_POLICY) {}

  /** Policy for a project; the default policy when none is configured. */
  forProject(projectId: string): FactoryPolicy {
    return this.policies.get(projectId) ?? this.defaultPolicy;
  }

  /** Configure (or replace) a project's policy. */
  setProjectPolicy(projectId: string, policy: FactoryPolicy): void {
    this.policies.set(projectId, { ...policy });
  }

  /** For tests: drop all configured policies. */
  clear(): void {
    this.policies.clear();
  }
}
