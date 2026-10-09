/**
 * Failure Analyzer (§38) — classifies a test failure into one of the six
 * spec failure classes. Heuristics are intentionally simple and ordered;
 * the first matching rule wins:
 *
 *  1. AI_FAILURE        — the failure came from an agent tool call itself
 *                         (e.g. "tool call timeout"), not from the product.
 *  2. ENVIRONMENT_FAILURE — networking/host problems: connection refused,
 *                         DNS resolution, timeouts, ports already in use.
 *  3. INFRA_FAILURE     — host resource problems: OOM, missing binaries,
 *                         permission errors, disk full.
 *  4. PRODUCT vs TEST   — assertion-diff keywords ('AssertionError',
 *                         'assert.', 'expected', expect(...)) mean the code
 *                         under test misbehaved UNLESS the message points at
 *                         the harness itself ('test runner', 'beforeEach',
 *                         'afterEach', 'setup', '*.test.*' path) — then it is
 *                         a TEST_FAILURE.
 *  5. UNKNOWN           — nothing matched.
 */

import type { FailureClass } from './types';

export interface FailureInput {
  message: string;
  stderr?: string;
  exitCode?: number | null;
}

const AI_TOOL_RE = /tool\s+(call|error|timeout)/i;

const ENV_RE =
  /(econnrefused|enotfound|econnreset|econnaborted|etimedout|eaddrinuse|ehostunreach|enetunreach)\b|connection\s+(refused|timed?\s*out|reset)|timed?\s*out|dns|no\s+such\s+host|name\s+not\s+resolved|port\s+(in\s+use|already)|network\s+(is\s+)?unreachable|getaddrinfo/i;

const INFRA_RE =
  /\benomem\b|out\s+of\s+memory|javascript\s+heap|spawn\s+enoent|eacces|permission\s+denied|no\s+space\s+left|enospc|exited\s+with\s+code\s+137/i;

const ASSERTION_RE =
  /assertionerror|assert\.|expected|expect\s*\(|did\s+not\s+match|to\s+be\s+\S+|to\s+equal/i;

/** Mentions of the test harness itself → the bug is in the test code.
 *  NOTE: plain `.test.ts` stack-frame paths are deliberately NOT matched —
 *  every failing assertion throws from a test file, so a path alone says
 *  nothing about where the bug lives. */
const TEST_HARNESS_RE =
  /test\s+runner|beforeeach|aftereach|before\s+all|after\s+all|mocha|jest\.|vitest|setup\s+file|teardown/i;

export function classifyFailure(input: FailureInput): FailureClass {
  const text = [input.message, input.stderr ?? ''].join('\n');
  if (AI_TOOL_RE.test(text)) return 'AI_FAILURE';
  if (ENV_RE.test(text)) return 'ENVIRONMENT_FAILURE';
  if (INFRA_RE.test(text)) return 'INFRA_FAILURE';
  if (ASSERTION_RE.test(text)) {
    return TEST_HARNESS_RE.test(text) ? 'TEST_FAILURE' : 'PRODUCT_FAILURE';
  }
  return 'UNKNOWN';
}
