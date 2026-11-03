/**
 * API path-prefix regression (V3.0 audit round 2, item #1, generalized by
 * the standalone double-prefix sweep).
 *
 * The desktop api client builds request URLs as BASE + path, where BASE
 * already ends in `/api` (see defaultApiBase in apps/desktop/src/api.ts).
 * Call sites historically passed both bare (`/tasks`) and `/api`-prefixed
 * (`/api/tasks`) paths; without normalization the latter resolved to
 * `/api/api/tasks` and the server (exact-path dispatch, no double-prefix
 * handling) answered 404, which panels rendered as a silent empty state.
 * That is how the Rules panel, Profiler, PrLink, Queue, and the run-history
 * clear button all broke at different times.
 *
 * The fix is normalization at the request layer: req/reqText/reqWithStatus
 * strip exactly one leading `/api` segment (see stripApiPrefix in api.ts),
 * so both conventions resolve to the same URL and no call site can
 * reintroduce the bug by picking the wrong convention.
 *
 * This test therefore pins RESOLUTION, not literals: `/api/...` path
 * literals are allowed to exist in api.ts, but they must resolve through
 * stripApiPrefix to a path that never contains `/api/api/`. It runs at
 * the source level, in the style of the other desktop unit tests (no
 * api.ts import: the module needs a browser fetch environment).
 * Run: node --test apps/desktop/tests/unit/rules-api-path.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const apiTs = readFileSync(join(repoRoot, 'apps/desktop/src/api.ts'), 'utf8');
const terminalTsx = readFileSync(
  join(repoRoot, 'apps/desktop/src/components/TerminalPanel.tsx'), 'utf8');
const timelineTsx = readFileSync(
  join(repoRoot, 'apps/desktop/src/components/CascadeTimelinePanel.tsx'), 'utf8');

/** Evaluate the real stripApiPrefix out of api.ts source (types erased). */
function loadStripApiPrefix() {
  const m = apiTs.match(/export function stripApiPrefix[\s\S]*?\n\}/);
  assert.ok(m, 'stripApiPrefix must exist in api.ts');
  const js = m[0]
    .replace('export function stripApiPrefix(path: string): string', 'function stripApiPrefix(path)');
  return new Function(`${js}; return stripApiPrefix;`)();
}

const strip = loadStripApiPrefix();

test('stripApiPrefix strips exactly one leading /api segment', () => {
  assert.equal(strip('/api/tasks'), '/tasks');
  assert.equal(strip('/api/tasks/runs/history'), '/tasks/runs/history');
  assert.equal(strip('/api'), '');
  assert.equal(strip('/tasks'), '/tasks');
  assert.equal(strip('/tasks/runs'), '/tasks/runs');
  // Only one layer: a doubly-prefixed literal stays visibly wrong.
  assert.equal(strip('/api/api/tasks'), '/api/tasks');
  // Lookalike prefixes are not touched.
  assert.equal(strip('/apix/tasks'), '/apix/tasks');
  assert.equal(strip('/apiary/x'), '/apiary/x');
  assert.equal(strip(''), '');
});

test('all three request helpers resolve through stripApiPrefix', () => {
  for (const helper of ['req', 'reqText', 'reqWithStatus']) {
    const at = apiTs.indexOf(`async function ${helper}`);
    assert.ok(at >= 0, `${helper} definition exists`);
    const body = apiTs.slice(at, at + 1200);
    assert.match(
      body,
      /fetch\(`\$\{BASE\}\$\{stripApiPrefix\(path\)\}`/,
      `${helper} must fetch BASE + stripApiPrefix(path)`,
    );
  }
  // No helper may still concatenate the raw path.
  assert.equal(apiTs.includes('fetch(`${BASE}${path}`'), false);
});

test('every /api/-prefixed call-site path resolves without /api/api/', () => {
  const re = /\b(reqWithStatus|reqText|req)\s*<[\s\S]{0,2000}?>\s*\(\s*['"`](\/api[^'"`]*)/g;
  const resolved = [];
  let m;
  while ((m = re.exec(apiTs)) !== null) {
    const literal = m[2].replace(/\$\{[^}]*\}/g, 'X');
    const out = strip(literal);
    assert.ok(!out.includes('/api/api/'), `resolved path must not double-prefix: ${m[2]} -> ${out}`);
    assert.ok(out.startsWith('/'), `resolved path keeps its leading slash: ${out}`);
    resolved.push(out);
  }
  // The sweep counted 184 such call sites; a large drop means the regex
  // lost coverage, not that call sites vanished.
  assert.ok(resolved.length >= 150, `expected ~184 prefixed call sites, found ${resolved.length}`);
});

test('rules methods still resolve to bare /rules paths', () => {
  for (const name of ['rulesView', 'rulesAdd', 'rulesPatch', 'rulesDelete', 'rulesOrder']) {
    assert.ok(apiTs.includes(`${name}:`) || apiTs.includes(`${name} `), `${name} method exists`);
  }
  assert.match(apiTs, /rulesView[\s\S]{0,200}`\/rules\$\{/);
  assert.ok(apiTs.includes("req<{ rule: RuleDto }>('/rules'"));
  assert.match(apiTs, /rulesOrder[\s\S]{0,300}'\/rules\/order'/);
});

test('panel-local fetches no longer double-prefix', () => {
  assert.equal(terminalTsx.includes('API_BASE}/api/'), false);
  assert.equal(timelineTsx.includes('API_BASE}/api/'), false);
  assert.ok(terminalTsx.includes('API_BASE}/terminal/history'));
  assert.ok(timelineTsx.includes('API_BASE}/shadow-checkpoints/${cp.id}/restore'));
});
