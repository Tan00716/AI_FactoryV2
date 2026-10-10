/**
 * Independent production-readiness verification — spec §41 + §80.
 *
 * "Even in fully autonomous mode, the following must be independently
 * checked: Build, Tests, Security, Rollback readiness, Health check,
 * Deployment artifact, Environment status."
 *
 * Key property: verifyProdReadiness NEVER trusts an AI assertion alone.
 * A check marked `aiAssertedOnly` with no concrete evidence id is treated
 * as MISSING and blocks the deploy. Concrete tool evidence (evidenceId)
 * or a direct tool verdict (passed: true) is required for each gate.
 */
import { randomUUID } from 'crypto';

/** The seven §41 checks, in spec order. */
export const PROD_CHECKS = [
  'build',
  'tests',
  'security',
  'rollback',
  'healthCheck',
  'artifact',
  'environment',
] as const;

export type ProdCheckName = (typeof PROD_CHECKS)[number];

export const PROD_CHECK_ZH: Record<ProdCheckName, string> = {
  build: '构建通过',
  tests: '测试通过',
  security: '安全通过',
  rollback: '回滚就绪',
  healthCheck: '健康检查',
  artifact: '部署产物存在',
  environment: '环境状态正常',
};

/** Evidence for a single §41 gate. */
export interface ProdCheckEvidence {
  /** Did the gate actually pass (tool/system verdict)? */
  passed: boolean;
  /** Immutable evidence record id, e.g. a test-result.json artifact (§42). */
  evidenceId?: string;
  /**
   * Set when the ONLY basis for "passed" is an AI's own claim.
   * With no evidenceId this is distrusted and the check counts as missing.
   */
  aiAssertedOnly?: boolean;
  note?: string;
}

export interface ProdReadinessEvidence {
  build?: ProdCheckEvidence;
  tests?: ProdCheckEvidence;
  security?: ProdCheckEvidence;
  rollback?: ProdCheckEvidence;
  healthCheck?: ProdCheckEvidence;
  artifact?: ProdCheckEvidence;
  environment?: ProdCheckEvidence;
  /** Optional provenance: which commit and who is requesting. */
  commitSha?: string;
  requestedBy?: string;
}

export interface ProdReadinessVerdict {
  id: string;
  ready: boolean;
  passed: ProdCheckName[];
  missing: ProdCheckName[];
  /** Bilingual summary; missing checks are named explicitly. */
  message: string;
  commitSha?: string;
  requestedBy?: string;
  checkedAt: number;
}

function checkSatisfied(c: ProdCheckEvidence | undefined): boolean {
  if (!c || c.passed !== true) return false;
  // Never trust an AI assertion alone (§80/§41): assertion without concrete
  // evidence is treated as missing.
  if (c.aiAssertedOnly === true && !c.evidenceId) return false;
  return true;
}

/**
 * Independently verify the §41 production checklist against supplied
 * evidence. Any missing gate rejects the deploy and is named in the message.
 */
export function verifyProdReadiness(
  evidence: ProdReadinessEvidence,
  opts: { now?: () => number } = {},
): ProdReadinessVerdict {
  const now = opts.now ?? Date.now;
  const passed: ProdCheckName[] = [];
  const missing: ProdCheckName[] = [];

  for (const name of PROD_CHECKS) {
    if (checkSatisfied(evidence[name])) passed.push(name);
    else missing.push(name);
  }

  const ready = missing.length === 0;
  const named = missing.map((m) => `${m}(${PROD_CHECK_ZH[m]})`).join(', ');
  const message = ready
    ? 'PROD READY: all 7 gates verified with evidence / 生产就绪：7 项门禁均已凭证据独立校验'
    : `PROD BLOCKED: missing gates — ${named} / 生产部署被拦下：缺失门禁 — ${named}`;

  return {
    id: randomUUID(),
    ready,
    passed,
    missing,
    message,
    commitSha: evidence.commitSha,
    requestedBy: evidence.requestedBy,
    checkedAt: now(),
  };
}
