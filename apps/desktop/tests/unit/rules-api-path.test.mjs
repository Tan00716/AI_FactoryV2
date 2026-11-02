/**
 * Rules API path regression (V3.0 audit round 2, item #1).
 *
 * The desktop api client builds request URLs as BASE + path, where BASE
 * already ends in `/api` (see defaultApiBase in apps/desktop/src/api.ts).
 * The five rules* methods once passed `/api/rules...` paths, so every
 * Rules panel request went to `/api/api/rules` and the server answered
 * 404 "Not found": the panel showed "loading" forever, a save kept the
 * form values, and no rule ever appeared. The server side was fine the
 * whole time (direct curl: GET 200, POST 201).
 *
 * This test pins the convention at the source level, in the style of the
 * other desktop unit tests (no api.ts import: the module needs a browser
 * fetch environment). It fails if any `/api/rules` path literal reappears
 * in api.ts, and requires all five rules methods to use bare `/rules`
 * paths. Run: node --test apps/desktop/tests/unit/rules-api-path.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const apiTs = readFileSync(join(repoRoot, 'apps/desktop/src/api.ts'), 'utf8');

test('no rules method double-prefixes the /api base', () => {
  // '/api/watch/rules' is a different endpoint and must not trip this.
  const hits = apiTs.match(/['`]\/api\/rules(?![\w/])/g) ?? [];
  assert.deepEqual(hits, [], 'api.ts must not contain an /api/rules path literal');
  assert.equal(apiTs.includes('`/api/rules'), false);
  assert.equal(apiTs.includes("'/api/rules"), false);
});

test('all five rules methods use bare /rules paths', () => {
  for (const name of ['rulesView', 'rulesAdd', 'rulesPatch', 'rulesDelete', 'rulesOrder']) {
    assert.ok(apiTs.includes(`${name}:`) || apiTs.includes(`${name} `), `${name} method exists`);
  }
  assert.match(apiTs, /rulesView[\s\S]{0,200}`\/rules\$\{/);
  assert.ok(apiTs.includes("req<{ rule: RuleDto }>('/rules'"));
  assert.match(apiTs, /rulesOrder[\s\S]{0,300}'\/rules\/order'/);
});
