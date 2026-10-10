/**
 * Task auto-decomposition — spec §95.
 *
 * Deterministic, rule-based templates per task kind. This is explicitly a
 * HEURISTIC: it produces the PM/Tech-Lead skeleton (goal, acceptance
 * criteria, risks, subtasks, dependencies, specialists, test + deployment
 * strategies). Any nuanced reasoning (e.g. "is this risk actually real?",
 * "does this decomposition fit the codebase?") belongs to the AI layer
 * (see README.md "AI vs code boundary"). Code owns the *structure* so every
 * task gets a complete, auditable plan; AI owns the *judgement*.
 */
import type { DependencyKind } from '@ai-factory/core';

export type DecompositionKind = 'bugfix' | 'feature' | 'refactor' | 'research';

export interface DecompositionInput {
  title: string;
  goal: string;
  kind: DecompositionKind;
  constraints?: string[];
}

/** Phase label inside a plan; doubles as the subtask kind. */
export type SubtaskPhase =
  | 'investigate'
  | 'reproduce'
  | 'fix'
  | 'test'
  | 'regression'
  | 'design'
  | 'implement'
  | 'integrate'
  | 'review'
  | 'document'
  | 'spike'
  | 'recommend';

export interface PlannedSubtask {
  title: string;
  kind: SubtaskPhase;
  /** Rough effort estimate, e.g. "2h" or "1d". Heuristic — not a commitment. */
  estimate: string;
}

export interface PlannedDependency {
  /** Zero-based subtask index. */
  from: number;
  /** Zero-based subtask index. */
  to: number;
  kind: DependencyKind;
}

export interface DecompositionPlan {
  goal: string;
  acceptanceCriteria: string[];
  risks: string[];
  subtasks: PlannedSubtask[];
  dependencies: PlannedDependency[];
  requiredSpecialists: string[];
  testStrategy: string;
  deploymentStrategy: string;
}

interface Template {
  phases: SubtaskPhase[];
  titles: (input: DecompositionInput) => string[];
  estimates: string[];
  /** Chain edges [from,to] added as depends_on unless overridden. */
  chain: boolean;
  acceptanceCriteria: (input: DecompositionInput) => string[];
  risks: (input: DecompositionInput) => string[];
  requiredSpecialists: string[];
  testStrategy: string;
  deploymentStrategy: string;
}

function withTitle(input: DecompositionInput): string {
  return input.title.trim();
}

/** §95 example template — bugfix: investigate → reproduce → fix → tests → regression. */
const BUGFIX: Template = {
  phases: ['investigate', 'reproduce', 'fix', 'test', 'regression'],
  titles: (i) => [
    `Investigate root cause of: ${withTitle(i)}`,
    `Reproduce: ${withTitle(i)}`,
    `Implement fix for: ${withTitle(i)}`,
    `Add/extend tests covering: ${withTitle(i)}`,
    `Run regression suite after fix: ${withTitle(i)}`,
  ],
  estimates: ['2h', '2h', '4h', '3h', '2h'],
  chain: true,
  acceptanceCriteria: (i) => [
    `Root cause of "${withTitle(i)}" is identified and recorded as evidence`,
    `A failing reproduction exists before the fix and passes after it`,
    `Fix merged with code review approval`,
    `Regression suite passes with no new failures`,
  ],
  risks: (i) => [
    'Root cause may differ from surface symptom; reproduction may be flaky',
    'Fix may introduce regressions in adjacent code paths',
    ...(i.constraints ?? []).map((c) => `Constraint must be respected: ${c}`),
  ],
  requiredSpecialists: ['backend-engineer', 'qa-engineer'],
  testStrategy:
    'Reproduce-first: write a failing test that captures the bug, fix, then re-run ' +
    'the targeted suite plus the full regression suite before review.',
  deploymentStrategy:
    'Standard pipeline deploy (dev → UAT → prod) with a rollback plan; hotfix ' +
    'branch if the bug is production-impacting (P0/P1).',
};

/** §95 feature template — design → backend → frontend → integration → qa. */
const FEATURE: Template = {
  phases: ['design', 'implement', 'implement', 'integrate', 'test'],
  titles: (i) => [
    `Design technical plan for: ${withTitle(i)}`,
    `Implement backend for: ${withTitle(i)}`,
    `Implement frontend for: ${withTitle(i)}`,
    `Integrate frontend + backend for: ${withTitle(i)}`,
    `QA pass for: ${withTitle(i)}`,
  ],
  estimates: ['4h', '1d', '1d', '4h', '4h'],
  chain: true,
  acceptanceCriteria: (i) => [
    `Design document approved covering API contract and data model for "${withTitle(i)}"`,
    'Backend and frontend implemented against the agreed contract',
    'End-to-end happy path works in UAT',
    'QA sign-off recorded as evidence',
  ],
  risks: (i) => [
    'Scope creep during design; contract drift between backend and frontend',
    'Integration issues discovered late',
    ...(i.constraints ?? []).map((c) => `Constraint must be respected: ${c}`),
  ],
  requiredSpecialists: ['tech-lead', 'backend-engineer', 'frontend-engineer', 'qa-engineer'],
  testStrategy:
    'Contract tests at the API boundary, unit tests per component, integration ' +
    'tests for the end-to-end path, then a full QA pass.',
  deploymentStrategy:
    'Feature-flagged rollout: dev → UAT → staged prod rollout with monitoring, ' +
    'flag rollback as the first-line recovery.',
};

const REFACTOR: Template = {
  phases: ['investigate', 'design', 'implement', 'test', 'review'],
  titles: (i) => [
    `Analyze current code for: ${withTitle(i)}`,
    `Design refactor plan for: ${withTitle(i)}`,
    `Execute refactor for: ${withTitle(i)}`,
    `Verify behavior parity for: ${withTitle(i)}`,
    `Review + document refactor: ${withTitle(i)}`,
  ],
  estimates: ['3h', '3h', '1d', '4h', '2h'],
  chain: true,
  acceptanceCriteria: (i) => [
    `All existing tests pass unchanged for "${withTitle(i)}"`,
    'No behavior change observable by consumers',
    'Refactor plan reviewed before execution',
  ],
  risks: (i) => [
    'Hidden behavior dependencies; refactor scope creep',
    'Test coverage gaps masking behavior changes',
    ...(i.constraints ?? []).map((c) => `Constraint must be respected: ${c}`),
  ],
  requiredSpecialists: ['backend-engineer', 'tech-lead'],
  testStrategy:
    'Characterization tests first (lock current behavior), then incremental ' +
    'refactor with the full suite green at every step.',
  deploymentStrategy:
    'Normal pipeline deploy; no feature flag needed (behavior-neutral), ' +
    'but staged rollout recommended for large refactors.',
};

const RESEARCH: Template = {
  phases: ['investigate', 'spike', 'test', 'recommend', 'document'],
  titles: (i) => [
    `Scope research question: ${withTitle(i)}`,
    `Survey existing solutions for: ${withTitle(i)}`,
    `Build spike/prototype for: ${withTitle(i)}`,
    `Evaluate options and recommend for: ${withTitle(i)}`,
    `Document findings for: ${withTitle(i)}`,
  ],
  estimates: ['2h', '4h', '1d', '3h', '2h'],
  chain: true,
  acceptanceCriteria: (i) => [
    `Research question scoped and recorded for "${withTitle(i)}"`,
    'At least two options evaluated with pros/cons',
    'A concrete recommendation with rationale is documented',
  ],
  risks: (i) => [
    'Open-ended timebox creep; inconclusive results',
    ...(i.constraints ?? []).map((c) => `Constraint must be respected: ${c}`),
  ],
  requiredSpecialists: ['researcher', 'tech-lead'],
  testStrategy:
    'Spike validation: prototype the riskiest assumption first; no production-grade ' +
    'testing — evaluate feasibility and trade-offs only.',
  deploymentStrategy:
    'No deployment (research output is a document). If the recommendation is adopted, ' +
    'a follow-up feature/bugfix task is decomposed from this plan.',
};

const TEMPLATES: Record<DecompositionKind, Template> = {
  bugfix: BUGFIX,
  feature: FEATURE,
  refactor: REFACTOR,
  research: RESEARCH,
};

function buildDependencies(template: Template, count: number): PlannedDependency[] {
  const deps: PlannedDependency[] = [];
  if (template.chain) {
    for (let i = 0; i + 1 < count; i++) {
      // Subtask i+1 cannot start until subtask i is done.
      deps.push({ from: i + 1, to: i, kind: 'depends_on' });
    }
  }
  return deps;
}

/**
 * Deterministically decompose a task using the rule-based template for its
 * kind. Same input always yields the same plan. Documented as heuristic:
 * it does not read the codebase or reason about novelty — it scaffolds the
 * structure an AI/PM then refines.
 */
export function decompose(input: DecompositionInput): DecompositionPlan {
  const template = TEMPLATES[input.kind];
  const titles = template.titles(input);
  const subtasks: PlannedSubtask[] = titles.map((title, i) => ({
    title,
    kind: template.phases[i]!,
    estimate: template.estimates[i]!,
  }));
  return {
    goal: input.goal,
    acceptanceCriteria: template.acceptanceCriteria(input),
    risks: template.risks(input),
    subtasks,
    dependencies: buildDependencies(template, subtasks.length),
    requiredSpecialists: [...template.requiredSpecialists],
    testStrategy: template.testStrategy,
    deploymentStrategy: template.deploymentStrategy,
  };
}
