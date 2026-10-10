/**
 * Failure classification — spec §78 (heuristic classifier).
 *
 * Pure function: classifyFailure({message, context}) → FailureType with
 * confidence and the matched rule. Rules are ordered; the first match wins.
 * Context phase hints disambiguate overlapping signals (e.g. a SyntaxError
 * during 'build' is BUILD_ERROR, during 'test' is TEST_ERROR).
 */

import type { FailureType } from './types';

export interface FailureContext {
  /** What the agent was doing when the failure happened. */
  phase?: 'build' | 'test' | 'deploy' | 'runtime' | 'plan';
  /** Name/id of the tool being invoked, if any. */
  tool?: string;
  /** Name/id of the model being used, if any. */
  model?: string;
  /** How many times the same step already failed (stagnation signal). */
  consecutiveSameFailures?: number;
}

export interface ClassifiedFailure {
  type: FailureType;
  /** 0..1 — 0.9 rule hit, 0.6 context-only, 0.1 unknown fallback. */
  confidence: number;
  /** Name of the rule (or 'context' / 'fallback') that produced the type. */
  matched: string;
  message: string;
}

interface Rule {
  name: string;
  type: FailureType;
  test: (message: string, ctx: FailureContext) => boolean;
}

const RULES: Rule[] = [
  {
    name: 'stagnation-pattern',
    type: 'LOOP_STAGNATION',
    test: (m, ctx) =>
      (ctx.consecutiveSameFailures ?? 0) >= 3 ||
      /no progress|stagnat|going in circles|same (result|output|error).{0,40}(again|repeat)|repeatedly.{0,40}(same|identical)|keeps? failing the same/i.test(
        m,
      ),
  },
  {
    name: 'permission-denied',
    type: 'PERMISSION_ERROR',
    test: (m) =>
      /permission denied|EACCES|EPERM|operation not permitted|not permitted|access denied|forbidden/i.test(
        m,
      ),
  },
  {
    name: 'auth-signal',
    type: 'AUTH_ERROR',
    test: (m) =>
      /\b401\b|unauthorized|unauthenticated|invalid (api[-_ ]?key|credentials)|api[-_ ]?key (missing|required)|token (expired|invalid|revoked)|authentication (failed|required)|sign[- ]?in required/i.test(
        m,
      ),
  },
  {
    name: 'resource-limit',
    type: 'RESOURCE_LIMIT',
    test: (m) =>
      /out of memory|\bOOM\b|heap (out of|exhausted)|quota exceeded|\b429\b|too many requests|rate[- ]limit(ed)?|disk (full|quota)|storage limit|context length|token limit|maximum .* exceeded|insufficient (memory|funds|quota)/i.test(
        m,
      ),
  },
  {
    name: 'network-signal',
    type: 'NETWORK_ERROR',
    test: (m) =>
      /ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|network (error|unreachable|timeout)|DNS|502|503|504|bad gateway|service unavailable|gateway timeout|connection (refused|reset|timed out)/i.test(
        m,
      ),
  },
  {
    name: 'build-signal',
    type: 'BUILD_ERROR',
    test: (m, ctx) =>
      ctx.phase === 'build' ||
      /build failed|failed to build|compilation (error|failed)|failed to compile|tsc .*error|webpack|vite .*error|rollup/i.test(
        m,
      ),
  },
  {
    name: 'test-signal',
    type: 'TEST_ERROR',
    test: (m, ctx) =>
      ctx.phase === 'test' ||
      /tests? failed|failing tests?|assertion (failed|error)|expect\(.*\)|✗|FAIL |\bjest\b|\bmocha\b|tap (parser|failed)|test suite/i.test(
        m,
      ),
  },
  {
    name: 'code-signal',
    type: 'CODE_ERROR',
    test: (m) =>
      /TypeError|ReferenceError|RangeError|SyntaxError|null .*undefined|undefined is not|cannot read propert|cannot set propert|is not a function|logic error|bug in/i.test(
        m,
      ),
  },
  {
    name: 'model-signal',
    type: 'MODEL_ERROR',
    test: (m, ctx) =>
      (Boolean(ctx.model) && /model/i.test(m)) ||
      /model.{0,30}(error|failed|overloaded|unavailable|not found)|invalid model|model_not_found|content policy|refused|overloaded/i.test(
        m,
      ),
  },
  {
    name: 'tool-signal',
    type: 'TOOL_ERROR',
    test: (m, ctx) =>
      (Boolean(ctx.tool) && /(tool|function)/i.test(m)) ||
      /tool.{0,30}(failed|error|not found|timed? ?out)|function call failed|mcp.{0,20}error|unknown tool/i.test(
        m,
      ),
  },
  {
    name: 'environment-signal',
    type: 'ENVIRONMENT_ERROR',
    test: (m) =>
      /ENOENT|command not found|cannot find module|module not found|missing (env|environment|dependency|binary|package)|environment variable|node version|python.*not found|docker.*(not running|error)/i.test(
        m,
      ),
  },
];

export function classifyFailure(input: {
  message: string;
  context?: FailureContext;
}): ClassifiedFailure {
  const message = input.message ?? '';
  const context: FailureContext = input.context ?? {};
  for (const rule of RULES) {
    if (rule.test(message, context)) {
      return { type: rule.type, confidence: 0.9, matched: rule.name, message };
    }
  }
  // Context-only hints when the message carries no signal.
  if (context.phase === 'build') {
    return { type: 'BUILD_ERROR', confidence: 0.6, matched: 'context', message };
  }
  if (context.phase === 'test') {
    return { type: 'TEST_ERROR', confidence: 0.6, matched: 'context', message };
  }
  return { type: 'UNKNOWN', confidence: 0.1, matched: 'fallback', message };
}
