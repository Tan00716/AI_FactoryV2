/**
 * Strategy selection — spec §78.
 *
 * selectStrategy(failureType, attempt) walks a per-type escalation chain:
 * earlier attempts use cheap strategies (retry), later attempts escalate to
 * expensive ones (specialist, human, abort). The attempt counter drives both
 * the recommended strategy and the suggested exponential backoff.
 */

import type { FailureType, RecoveryStrategy } from './types';

export interface StrategyRecommendation {
  strategy: RecoveryStrategy;
  /** Human-readable reason, e.g. "retry #2 for TEST_ERROR — flaky tests often pass on re-run". */
  reason: string;
  /** Attempt index (0-based) at which the chain escalates to ask-human/abort. */
  escalateAfter: number;
  /** Suggested wait before the next attempt (ms), exponential backoff. */
  backoffMs: number;
  /** Set for RESOURCE_LIMIT: abort comes with an upgrade hint. */
  upgradeHint?: string;
}

/**
 * Escalation chains per failure type. Index = attempt number (0-based);
 * attempts beyond the chain keep using the last strategy.
 */
const CHAINS: Record<FailureType, RecoveryStrategy[]> = {
  MODEL_ERROR: ['retry', 'retry', 'change-model', 'ask-human'],
  TOOL_ERROR: ['retry', 'retry', 'create-specialist', 'ask-human'],
  NETWORK_ERROR: ['retry', 'retry', 'retry', 'env-restart', 'ask-human'],
  AUTH_ERROR: ['retry', 'ask-human'],
  BUILD_ERROR: ['retry', 'revert-change', 'ask-human'],
  TEST_ERROR: ['retry', 'retry', 'create-specialist', 'ask-human'],
  CODE_ERROR: ['retry', 'retry', 'change-agent', 'ask-human'],
  ENVIRONMENT_ERROR: ['retry', 'env-restart', 'ask-human'],
  PERMISSION_ERROR: ['ask-human'],
  RESOURCE_LIMIT: ['retry', 'abort'],
  LOOP_STAGNATION: ['change-agent', 'ask-human'],
  UNKNOWN: ['retry', 'ask-human'],
};

const REASONS: Record<RecoveryStrategy, string> = {
  retry: 'transient faults often clear on re-run',
  'change-model': 'the current model is failing — switch to a different model',
  'change-agent': 'a fresh agent avoids the stalled reasoning path',
  'create-specialist': 'spawn a specialist to fix what the generalist cannot',
  'revert-change': 'roll back the last change and try a different approach',
  'snapshot-restore': 'restore the pre-operation snapshot to a known-good state',
  'env-restart': 'restart the environment to clear corrupted state',
  'ask-human': 'automatic recovery is exhausted or unsafe — escalate to a human',
  abort: 'further attempts are futile or risky — abort the operation',
};

const MAX_BACKOFF_MS = 30_000;

function backoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

export function selectStrategy(
  failureType: FailureType,
  attempt: number,
): StrategyRecommendation {
  const chain = CHAINS[failureType] ?? CHAINS.UNKNOWN;
  const idx = Math.min(Math.max(attempt, 0), chain.length - 1);
  const strategy = chain[idx] as RecoveryStrategy;
  const escalateAfter = chain.findIndex(
    (s) => s === 'ask-human' || s === 'abort',
  );
  const rec: StrategyRecommendation = {
    strategy,
    reason: `${strategy} (attempt ${attempt + 1}) for ${failureType}: ${REASONS[strategy]}.`,
    escalateAfter: escalateAfter === -1 ? chain.length : escalateAfter,
    backoffMs: backoffMs(attempt),
  };
  if (strategy === 'abort' && failureType === 'RESOURCE_LIMIT') {
    rec.upgradeHint =
      'Raise the resource ceiling (memory / tokens / quota / concurrency) before retrying, then re-run.';
  }
  return rec;
}

/** Exposed for tests/diagnostics: the raw escalation chain for a type. */
export function escalationChain(failureType: FailureType): RecoveryStrategy[] {
  return [...(CHAINS[failureType] ?? CHAINS.UNKNOWN)];
}
