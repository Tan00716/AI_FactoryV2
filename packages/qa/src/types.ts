/**
 * QA domain types — spec §37 (automated QA) and §38 (failure loop).
 *
 * QaResultPayload is the machine-readable result attached as 'qa_result'
 * evidence (spec §37 example: { verdict, total, passed, failed, skipped }).
 */

import type { Agent } from '@ai-factory/core';

/** §37 — supported test categories. */
export type TestCategory =
  | 'unit'
  | 'integration'
  | 'api'
  | 'e2e'
  | 'regression'
  | 'ui'
  | 'performance'
  | 'security'
  | 'database'
  | 'migration'
  | 'smoke';

export const ALL_TEST_CATEGORIES: readonly TestCategory[] = [
  'unit',
  'integration',
  'api',
  'e2e',
  'regression',
  'ui',
  'performance',
  'security',
  'database',
  'migration',
  'smoke',
];

/** Machine-readable verdict for one category or the whole run. */
export type QaVerdict = 'PASS' | 'FAIL' | 'SKIPPED';

/** Per-category result produced by a SuiteRunner. */
export interface CategoryResult {
  category: TestCategory;
  verdict: QaVerdict;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  /** Optional captured stdout/stderr tail — used by the Failure Analyzer (§38). */
  output?: string;
}

/** §38 — the six failure classes the analyzer must distinguish. */
export type FailureClass =
  | 'PRODUCT_FAILURE'
  | 'TEST_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'INFRA_FAILURE'
  | 'AI_FAILURE'
  | 'UNKNOWN';

/** One classified failure; feeds the failure loop owner assignment. */
export interface FailureRecord {
  /** Which loop attempt produced it (1-based). */
  attempt: number;
  category: TestCategory;
  classification: FailureClass;
  /** Owner agent name ('coder', 'human', specialist name, …). */
  owner: string;
  message: string;
  at: string;
}

/**
 * §37 — full machine-readable QA result. Attached as the payload of a
 * 'qa_result' evidence record (see qaEvidencePayload in runner.ts).
 */
export interface QaResultPayload {
  verdict: QaVerdict;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  categories: CategoryResult[];
  failures: FailureRecord[];
}

/** QA org snapshot returned by listQaOrg (spec §36). */
export interface QaOrgSnapshot {
  lead: Agent | null;
  specialists: Agent[];
}

/** QA specialist kinds per the §36 org chart. */
export type QaSpecialistKind =
  | 'Functional'
  | 'API'
  | 'E2E'
  | 'Regression'
  | 'Performance'
  | 'Security';
