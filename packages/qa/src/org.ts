/**
 * QA org chart — spec §36. QA is not one generic AI: a QA Lead plus
 * on-demand specialists (Functional, API, E2E, Regression, Performance,
 * Security). All idempotent: finding an existing agent returns it.
 */

import type { Agent, AgentRegistry } from '@ai-factory/core';
import type { QaOrgSnapshot, QaSpecialistKind } from './types';

export const QA_LEAD_NAME = 'qa-lead';

const SPECIALIST_SKILLS: Record<QaSpecialistKind, string[]> = {
  Functional: ['test-planning', 'exploratory-testing', 'boundary-analysis'],
  API: ['api-testing', 'contract-testing', 'schema-validation'],
  E2E: ['e2e-testing', 'browser-automation', 'user-journey'],
  Regression: ['regression-suite', 'test-selection', 'flakiness-triage'],
  Performance: ['load-testing', 'profiling', 'benchmarking'],
  Security: ['owasp-testing', 'dependency-audit', 'secret-scan'],
};

/**
 * Find-or-register the QA Lead. Parented under the tech lead when one is
 * already registered, otherwise a top-level agent. Autonomy level 3 (§17):
 * can run tests and file defects, not change product scope.
 */
export function ensureQaLead(agents: AgentRegistry): Agent {
  const existing = agents.list().find((a) => a.name === QA_LEAD_NAME);
  if (existing) return existing;

  const techLead = agents
    .list()
    .find((a) => /tech\s*lead/i.test(a.jobTitle));
  return agents.register({
    name: QA_LEAD_NAME,
    displayName: 'QA Lead',
    jobTitle: 'QA Lead',
    department: 'QA',
    parentAgentId: techLead ? techLead.id : null,
    mission: 'Own test strategy, triage QA failures, and gate releases on evidence (§36).',
    skills: ['test-strategy', 'defect-triage', 'quality-gates'],
    tools: ['shell', 'filesystem'],
    autonomyLevel: 3,
  });
}

/**
 * Register (or return the existing) QA specialist for a §36 kind.
 * Specialists are parented under the QA Lead; the task may create only
 * the needed ones (§36: "dynamically create only the needed specialists").
 */
export function createQaSpecialist(
  agents: AgentRegistry,
  kind: QaSpecialistKind,
): Agent {
  const name = `qa-${kind.toLowerCase()}`;
  const existing = agents.list().find((a) => a.name === name);
  if (existing) return existing;

  const lead = ensureQaLead(agents);
  return agents.register({
    name,
    displayName: `${kind} QA`,
    jobTitle: `${kind} QA`,
    department: 'QA',
    parentAgentId: lead.id,
    mission: `Own ${kind} testing: execute suites, file precise defects, keep the signal green.`,
    skills: SPECIALIST_SKILLS[kind],
    tools: ['shell', 'filesystem'],
    autonomyLevel: 3,
  });
}

/** Lead + specialists for display / API. */
export function listQaOrg(agents: AgentRegistry): QaOrgSnapshot {
  const lead = agents.list().find((a) => a.name === QA_LEAD_NAME) ?? null;
  const specialists = agents
    .list()
    .filter((a) => a.department === 'QA' && a.name !== QA_LEAD_NAME)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { lead, specialists };
}

/** Prefer the matching specialist, else the QA lead, else a bare 'qa' label. */
export function qaSpecialistFor(
  agents: AgentRegistry | undefined,
  category: string,
): string {
  if (agents) {
    const lower = category.toLowerCase();
    const hit = agents
      .list()
      .find((a) => a.department === 'QA' && a.name === `qa-${lower}`);
    if (hit) return hit.name;
    const lead = agents.list().find((a) => a.name === QA_LEAD_NAME);
    if (lead) return lead.name;
  }
  return 'qa';
}
