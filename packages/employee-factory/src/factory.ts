/**
 * Dynamic AI employee factory — spec §18.
 *
 * Any authorized AI Employee may request creation of another AI Employee
 * (tool: create_ai_employee()). Mission, instructions and skills are
 * auto-generated from specialty templates so the requester only names
 * the job title + specialty; governance (§19) is enforced BEFORE the
 * registry is touched.
 */

import type { Agent, AgentRegistry, Permission } from '@ai-factory/core';
import { defaultPermissionsFor } from '@ai-factory/core';
import {
  enforcePolicy,
  type FactoryPolicy,
  type GovernanceAuditSink,
} from './governance';

/** Injectable clock for deterministic timestamps. */
export interface Clock {
  now: () => number;
}

/** createEmployee context: clock + optional governance audit sink. */
export interface CreateEmployeeContext {
  clock?: Clock;
  /**
   * Receives RELATIVE_CEILING_DENIED intents from the §8.2 check.
   * The server wires this to the audit log; without it the denial
   * still throws (403) but is not separately audited.
   */
  audit?: GovernanceAuditSink;
}

export interface EmployeeSpec {
  jobTitle: string;
  /** Specialty keyword driving template generation, e.g. 'PostgreSQL', 'Security'. */
  specialty?: string;
  /** Parent agent id — links the new employee under its creator (§18 example). */
  parentId?: string;
  /** Overrides the template-generated mission. */
  mission?: string;
  /** Overrides the template-generated skills. */
  skills?: string[];
  /** Overrides the template-selected model. */
  model?: string;
  /** Overrides the template-selected tools. */
  tools?: string[];
  /** Overrides the template-selected permissions. */
  permissions?: Permission[];
  /**
   * §8.2 "任务范围": the task scope this creation happens under, in
   * §12.2 scope-token form. Absent → the task-scope dimension of the
   * relative ceiling check is skipped (never fabricated); present →
   * strict subset against the token-covered tools/permissions.
   */
  taskScope?: string[];
}

/** What a specialty template contributes to a new employee. */
export interface SpecialtyTemplate {
  mission: string;
  instructions: string;
  skills: string[];
  rules: string[];
  tools: string[];
  model: string;
  reasoningLevel: Agent['reasoningLevel'];
}

const POSTGRESQL_TEMPLATE: SpecialtyTemplate = {
  mission: 'Investigate concurrency and transaction issues.',
  instructions: [
    'Reproduce the reported concurrency problem in the SQL sandbox before theorizing.',
    'Inspect transaction isolation levels and lock waits; prefer EXPLAIN (ANALYZE, BUFFERS).',
    'Distinguish MVCC snapshot anomalies (non-repeatable read, phantom read, serialization failure) from true deadlocks.',
    'Propose fixes ordered by blast radius: query rewrite, index change, isolation level, application retry, schema change.',
    'Never touch production data; all experiments run against the development DB snapshot.',
  ].join('\n'),
  skills: ['PostgreSQL', 'MVCC', 'Transactions', 'Isolation', 'Locks', 'Deadlocks'],
  rules: [
    'Always report the isolation level and lock graph for any concurrency finding.',
    'Treat a serialization failure as an expected control-flow event, not a bug.',
  ],
  tools: ['SQL Sandbox', 'Repository', 'Terminal'],
  model: 'reasoning',
  reasoningLevel: 'HIGH',
};

const SECURITY_TEMPLATE: SpecialtyTemplate = {
  mission: 'Review code for security vulnerabilities per OWASP guidance.',
  instructions: [
    'Perform threat modeling first: identify trust boundaries, data flows, and attacker capabilities.',
    'Check every finding against the OWASP Top 10; cite the specific category and CWE.',
    'Verify authentication, authorization, input validation, and output encoding on every changed path.',
    'Scan for hardcoded secrets, unsafe deserialization, SSRF, and dependency vulnerabilities.',
    'Report severity, exploitability, and a concrete fix for each finding; do not fix silently.',
  ].join('\n'),
  skills: ['OWASP Top 10', 'Threat Modeling', 'Static Analysis', 'Secret Scanning'],
  rules: [
    'Never approve code with injection vulnerabilities.',
    'Secrets must never appear in code, logs, or evidence payloads.',
    'Default-deny: any unclear data flow is flagged until proven safe.',
  ],
  tools: ['Repository', 'Terminal', 'Static Analyzer'],
  model: 'reasoning',
  reasoningLevel: 'HIGH',
};

const DEFAULT_TEMPLATE: SpecialtyTemplate = {
  mission: 'Design, implement, and verify software changes.',
  instructions: [
    'Clarify acceptance criteria before writing code.',
    'Keep changes small, tested, and reviewable.',
    'Follow the repository conventions and existing architecture.',
    'Verify with the test suite and report evidence for every claim.',
  ].join('\n'),
  skills: ['Code Writing', 'Debugging', 'Refactoring'],
  rules: ['Do not commit unreviewed code to shared branches.'],
  tools: ['Repository', 'Terminal'],
  model: 'reasoning',
  reasoningLevel: 'MEDIUM',
};

const TEMPLATES: Array<{ match: string[]; template: SpecialtyTemplate }> = [
  { match: ['postgres', 'sql', 'database', 'concurrency'], template: POSTGRESQL_TEMPLATE },
  { match: ['security', 'owasp', 'vulnerability', 'penetration'], template: SECURITY_TEMPLATE },
];

/** Pick the specialty template for a job title / specialty string. */
export function templateFor(specialty: string | undefined): SpecialtyTemplate {
  const key = (specialty ?? '').toLowerCase();
  for (const { match, template } of TEMPLATES) {
    if (match.some((m) => key.includes(m))) return template;
  }
  return DEFAULT_TEMPLATE;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Create an AI Employee (§18) after governance checks (§19).
 *
 *  1. Template-generate mission/instructions/skills/rules/tools/model from `specialty`.
 *  2. Enforce the factory policy — GovernanceError on any violation.
 *     `requestedBy` is recorded as the granter for the §8.2 relative
 *     ceiling check (the grant may not exceed the delegator's own
 *     grantable set, nor the task scope when spec.taskScope is set);
 *     a non-agent requester (e.g. 'human') skips the relative check
 *     but never the absolute (§19) checks.
 *  3. Register in the registry, parented under `spec.parentId`.
 */
export function createEmployee(
  registry: AgentRegistry,
  requestedBy: string,
  spec: EmployeeSpec,
  policy: FactoryPolicy,
  ctx?: CreateEmployeeContext,
): Agent {
  if (!spec.jobTitle?.trim()) {
    throw new Error('EmployeeSpec.jobTitle is required');
  }
  const template = templateFor(spec.specialty ?? spec.jobTitle);
  const permissions = spec.permissions ?? defaultPermissionsFor(spec.jobTitle);
  const model = spec.model ?? template.model;
  const tools = spec.tools ?? template.tools;

  // §19 — governance BEFORE creation.
  enforcePolicy(
    registry,
    {
      parentAgentId: spec.parentId ?? null,
      granterAgentId: requestedBy,
      taskScope: spec.taskScope ?? null,
      jobTitle: spec.jobTitle,
      model,
      tools,
      permissions,
    },
    policy,
    { audit: ctx?.audit },
  );

  const name = slugify(spec.jobTitle);
  const agent = registry.register({
    name,
    displayName: spec.jobTitle.trim(),
    jobTitle: spec.jobTitle.trim(),
    parentAgentId: spec.parentId ?? null,
    mission: spec.mission ?? template.mission,
    instructions: template.instructions,
    skills: spec.skills ?? [...template.skills],
    rules: [...template.rules],
    model,
    reasoningLevel: template.reasoningLevel,
    tools,
    permissions,
    autonomyLevel: 2,
  });
  return agent;
}
