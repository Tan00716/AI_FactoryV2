import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, ALL_FAILURE_TYPES } from '../src/index';

describe('classifyFailure', () => {
  const cases: Array<[string, string]> = [
    ['model overloaded, please retry later', 'MODEL_ERROR'],
    ['tool execution failed: unknown tool "deploy"', 'TOOL_ERROR'],
    ['fetch failed: socket hang up (ECONNRESET)', 'NETWORK_ERROR'],
    ['401 unauthorized: invalid api key', 'AUTH_ERROR'],
    ['build failed: failed to compile src/index.ts', 'BUILD_ERROR'],
    ['3 tests failed: assertion error in suite', 'TEST_ERROR'],
    ["TypeError: cannot read properties of undefined (reading 'id')", 'CODE_ERROR'],
    ['ENOENT: command not found: docker', 'ENVIRONMENT_ERROR'],
    ['permission denied: EACCES writing /etc/hosts', 'PERMISSION_ERROR'],
    ['out of memory: heap exhausted, quota exceeded', 'RESOURCE_LIMIT'],
    ['no progress after 4 attempts, same error again and again', 'LOOP_STAGNATION'],
    ['something weird happened ???', 'UNKNOWN'],
  ];

  for (const [message, expected] of cases) {
    it(`classifies "${message.slice(0, 40)}…" as ${expected}`, () => {
      const r = classifyFailure({ message });
      assert.equal(r.type, expected);
      if (expected === 'UNKNOWN') {
        assert.ok(r.confidence < 0.9, 'unknown fallback should not be confident');
      } else {
        assert.ok(r.confidence >= 0.9, 'rule hit should be confident');
      }
      assert.ok(r.matched.length > 0);
    });
  }

  it('context phase disambiguates: build phase → BUILD_ERROR', () => {
    const r = classifyFailure({ message: 'SyntaxError: unexpected token', context: { phase: 'build' } });
    assert.equal(r.type, 'BUILD_ERROR');
  });

  it('context phase disambiguates: test phase → TEST_ERROR', () => {
    const r = classifyFailure({ message: 'SyntaxError: unexpected token', context: { phase: 'test' } });
    assert.equal(r.type, 'TEST_ERROR');
  });

  it('repeated identical failures escalate to LOOP_STAGNATION', () => {
    const r = classifyFailure({
      message: 'build failed again',
      context: { consecutiveSameFailures: 3 },
    });
    assert.equal(r.type, 'LOOP_STAGNATION');
  });

  it('covers all 12 spec failure types', () => {
    assert.equal(ALL_FAILURE_TYPES.length, 12);
    const seen = new Set(cases.map(([, t]) => t));
    for (const t of ALL_FAILURE_TYPES) assert.ok(seen.has(t), `missing case for ${t}`);
  });
});
