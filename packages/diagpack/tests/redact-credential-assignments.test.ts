/**
 * Credential-assignment redaction tests — R19 #6(r) (R19 N8–N10).
 *
 * redactCredentialAssignments is the audit-ingestion desensitizer for
 * command/args fields (PROJECT_EXEC `command`, COMMAND_EXECUTED `args` /
 * `expandedArgs`, TASK_CHAIN_STARTED `extraArgs`). Fixtures are synthetic
 * credential SHAPES (not real credentials). Assertions are exact-equality
 * on the redacted string — the strict form of the row-start assignment
 * assertion for a pure function (no substring checks: the value must be
 * gone entirely, which is exactly the shape redactText misses for
 * `FACTORY_API_TOKEN=` and for unquoted / short values).
 *
 * Run compiled: node --test packages/diagpack/dist/tests/*.test.js
 * (npm test segment 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactCredentialAssignments } from '../src/redact.js';

const M = 'r19probe-7f3a9c1e5b8d2a4f6';

test('R19 N8–N10: redactCredentialAssignments masks KEY=VALUE and --flag values, keeps the rest', () => {
  const cases: Array<[string, string]> = [
    // N8 probe shape: inline assignment before a whitelisted command.
    [`FACTORY_API_TOKEN=${M} node -e "console.log(1)"`, 'FACTORY_API_TOKEN=*** node -e "console.log(1)"'],
    // N10 probe shape: literal KEY=VALUE extra arg.
    [`KEY=${M}`, 'KEY=***'],
    // N9 probe shape: --token <value> flag form.
    [`deploy --token ${M} --region us`, 'deploy --token *** --region us'],
    // --flag=value form.
    [`deploy --api-key=${M}`, 'deploy --api-key=***'],
    // Colon form, including `Bearer <value>` after the colon.
    [`curl -H "Authorization: Bearer ${M}" https://x`, 'curl -H "Authorization: ***" https://x'],
    [`token: ${M}`, 'token: ***'],
    // Short value: redactText generic shapes need >= 8 characters.
    ['password=pw', 'password=***'],
    // Quoted values keep their quotes (shape is diagnostic).
    [`API_KEY="${M}"`, 'API_KEY="***"'],
    [`SECRET='${M}'`, "SECRET='***'"],
    [`--password "${M}"`, '--password "***"'],
    // URL query: value stops at `&`, the rest of the query survives.
    ['curl https://example.com/?token=abc123&other=1', 'curl https://example.com/?token=***&other=1'],
    // Shell metacharacter terminates the value.
    [`FACTORY_API_TOKEN=${M}; rm -rf /`, 'FACTORY_API_TOKEN=***; rm -rf /'],
    // Repeated flags are all masked.
    ['--token a --token b', '--token *** --token ***'],
    // Benign commands pass through untouched (no credential-ish key/flag).
    ['echo hello', 'echo hello'],
    ['run --region us --count 3', 'run --region us --count 3'],
    ['node -e "console.log(1)"', 'node -e "console.log(1)"'],
    ['export FOO=bar MODE=fast', 'export FOO=bar MODE=fast'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactCredentialAssignments(input), expected, `input: ${JSON.stringify(input)}`);
  }
  // The marker itself never survives in any output.
  for (const [input] of cases) {
    assert.doesNotMatch(redactCredentialAssignments(input), /r19probe-7f3a9c1e5b8d2a4f6/);
  }
});
