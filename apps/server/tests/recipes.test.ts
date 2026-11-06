/**
 * Recipe migration unit tests (deterministic recipe-based migration).
 *
 * Imports ../src/recipes.ts directly: the module value-imports node
 * builtins plus package-level @ai-factory/runtime /
 * @ai-factory/diagpack, which resolve via main -> dist under node's
 * type-stripping ESM loader.
 *
 * Fixture projects are throwaway directories under a temp dir — never
 * any real project directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CustomRecipeStore,
  RecipeError,
  RecipeExecutor,
  RecipeRunStore,
  applyActionFor,
  computePlan,
  loadBuiltinRecipes,
  matchGlob,
  parseRecipeJson,
  recipeErrorStatus,
  resolveProjectDir,
  runVerifyCommand,
  validateRecipe,
  type ApprovalChecker,
  type RecipeSpec,
} from '../src/recipes.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.AI_FACTORY_RECIPES_BUILTIN_DIR = path.join(here, '..', 'src', 'recipes', 'builtin');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-test-'));
}

function fixture(root: string, name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

interface AuditEvent { actor: string; event: string; entity: string; entityId: string }
function auditCollector(events: AuditEvent[]) {
  return {
    record(actor: string, event: string, entity: string, entityId: string) {
      events.push({ actor, event, entity, entityId });
    },
  };
}

/** Fake central-approval checker: tests flip statuses explicitly. */
function fakeApprovals() {
  const map = new Map<string, { status: string; action: string; requester?: string }>();
  const checker: ApprovalChecker = {
    getApproval(id: string) {
      return map.get(id) ?? null;
    },
  };
  return { map, checker };
}

function makeExecutor(root: string, approvals: ApprovalChecker, events: AuditEvent[]) {
  return new RecipeExecutor({
    runStore: new RecipeRunStore(path.join(root, 'runs.json')),
    customStore: new CustomRecipeStore(path.join(root, 'custom.json')),
    audit: auditCollector(events),
    approvals,
  });
}

function pkgJson(extra: Record<string, unknown>): string {
  return JSON.stringify({ name: 'fixture', version: '1.0.0', ...extra }, null, 2) + '\n';
}

const OK_SCRIPTS = { build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' };

/* ------------------------------------------------------------------ */
/* Spec validation                                                      */
/* ------------------------------------------------------------------ */

test('validateRecipe: strict keys, op shapes, prototype-path guard', () => {
  const base = {
    name: 'ok-recipe',
    version: '1.0.0',
    description: 'd',
    match: { files: ['package.json'] },
    transform: [{ op: 'replace', file: 'a.txt', search: 'x', replace: 'y' }],
  };
  assert.equal(validateRecipe(base, 'custom').name, 'ok-recipe');
  assert.throws(() => validateRecipe({ ...base, bogus: 1 }, 'custom'), /unknown recipe key/);
  assert.throws(
    () => validateRecipe({ ...base, transform: [{ op: 'teleport', file: 'a', search: 'x', replace: 'y' }] }, 'custom'),
    /unknown op/,
  );
  assert.throws(
    () => validateRecipe({ ...base, transform: [{ op: 'json-patch', file: 'a.json', path: '__proto__.x', value: 1 }] }, 'custom'),
    /prototype/,
  );
  assert.throws(
    () => validateRecipe({ ...base, transform: [{ op: 'replace', file: '../evil.txt', search: 'x', replace: 'y' }] }, 'custom'),
    /relative POSIX path/,
  );
  assert.throws(() => parseRecipeJson('{not json', 'custom'), /parse error/);
});

test('matchGlob: segment wildcards and **', () => {
  assert.equal(matchGlob('package.json', 'package.json'), true);
  assert.equal(matchGlob('package.json', 'packages/a/package.json'), false);
  assert.equal(matchGlob('packages/*/package.json', 'packages/a/package.json'), true);
  assert.equal(matchGlob('src/**/*.js', 'src/index.js'), true);
  assert.equal(matchGlob('src/**/*.js', 'src/deep/nested/x.js'), true);
  assert.equal(matchGlob('**/*.test.ts', 'a.test.ts'), true);
  assert.equal(matchGlob('**/*.test.ts', 'src/a.test.ts'), true);
  assert.equal(matchGlob('*.js', 'src/a.js'), false);
});

/* ------------------------------------------------------------------ */
/* Builtin library                                                      */
/* ------------------------------------------------------------------ */

test('builtin library: exactly 10 recipes, all valid, unique names, honest notes', () => {
  const builtins = loadBuiltinRecipes();
  assert.equal(builtins.length, 10, `expected 10 builtins, got ${builtins.map((b) => b.name).join(',')}`);
  const names = new Set(builtins.map((b) => b.name));
  assert.equal(names.size, 10);
  for (const b of builtins) {
    assert.equal(b.source, 'builtin');
    assert.ok(b.description.length > 10, `${b.name} needs a description`);
    assert.ok(b.notes && b.notes.length > 10, `${b.name} needs an honest-boundary note`);
    assert.ok(b.transform.length > 0, `${b.name} needs ops`);
  }
});

/* ------------------------------------------------------------------ */
/* Plan computation                                                     */
/* ------------------------------------------------------------------ */

test('plan: react-19 on fixture — applicable, diff preview, scan lists nested package.json, plan is pure', () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({
      scripts: OK_SCRIPTS,
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    }),
    'packages/inner/package.json': pkgJson({ dependencies: { react: '^18.2.0' } }),
  });
  const recipe = loadBuiltinRecipes().find((r) => r.name === 'react-19-upgrade')!;
  const before = fs.readFileSync(path.join(proj, 'package.json'), 'utf8');
  const plan = computePlan(recipe, proj);
  assert.equal(plan.applicable, true);
  assert.equal(plan.errorOps, 0);
  assert.equal(plan.appliedOps, 2);
  const pf = plan.files.find((f) => f.file === 'package.json')!;
  assert.equal(pf.willChange, true);
  assert.ok(pf.afterContent!.includes('"react": "^19.2.0"'));
  assert.ok(pf.diff!.includes('+'), 'diff preview shows added lines');
  assert.ok(pf.diff!.includes('^19.2.0'));
  // Nested package.json still on ^18 is NOT silently passed over.
  const nested = plan.unhandled.find((u) => u.file === 'packages/inner/package.json');
  assert.ok(nested, `expected nested package.json in unhandled, got ${JSON.stringify(plan.unhandled)}`);
  // Plan is pure: nothing on disk changed.
  assert.equal(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'), before);
});

test('plan: preconditions absent → not applicable, ops listed unhandled', () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', { 'package.json': pkgJson({ dependencies: { vue: '^3.0.0' } }) });
  const recipe = loadBuiltinRecipes().find((r) => r.name === 'react-19-upgrade')!;
  const plan = computePlan(recipe, proj);
  assert.equal(plan.applicable, false);
  assert.ok(plan.notes[0].includes('preconditions not met'));
  assert.ok(plan.unhandled.length >= 1);
});

test('plan: esm-package-type scanFor lists files still using require/module.exports', () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({ scripts: OK_SCRIPTS }),
    'src/index.js': 'const x = require("./x");\nmodule.exports = x;\n',
    'src/clean.js': 'export const y = 1;\n',
  });
  const recipe = loadBuiltinRecipes().find((r) => r.name === 'esm-package-type')!;
  const plan = computePlan(recipe, proj);
  assert.equal(plan.applicable, true);
  const hit = plan.unhandled.find((u) => u.file === 'src/index.js');
  assert.ok(hit, `expected src/index.js unhandled, got ${JSON.stringify(plan.unhandled)}`);
  assert.ok(!plan.unhandled.some((u) => u.file === 'src/clean.js'));
  const pf = plan.files.find((f) => f.file === 'package.json')!;
  assert.ok(pf.afterContent!.includes('"type": "module"'));
});

test('plan: replace op mustMatch:false no-match lands in unhandled, not error', () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', { 'a.txt': 'hello\n' });
  const recipe: RecipeSpec = validateRecipe(
    {
      name: 'soft-replace',
      version: '1.0.0',
      description: 'd',
      match: { files: ['a.txt'] },
      transform: [{ op: 'replace', file: 'a.txt', search: 'zzz', replace: 'q', mustMatch: false }],
    },
    'custom',
  );
  const plan = computePlan(recipe, proj);
  assert.equal(plan.errorOps, 0);
  assert.equal(plan.noMatchOps, 1);
  assert.ok(plan.unhandled.some((u) => u.opIndex === 0));
});

test('resolveProjectDir: path jail is fail-closed (empty roots deny, outside roots deny)', () => {
  const root = tmpRoot();
  const proj = fixture(root, 'app', { 'a.txt': 'x' });
  const saved = process.env.FACTORY_RECIPE_ROOTS;
  try {
    delete process.env.FACTORY_RECIPE_ROOTS;
    assert.throws(
      () => resolveProjectDir(proj),
      (e: unknown) => e instanceof RecipeError && e.code === 'PATH_ESCAPE',
    );
    process.env.FACTORY_RECIPE_ROOTS = path.join(root, 'elsewhere');
    assert.throws(() => resolveProjectDir(proj), /outside the allowed roots/);
    process.env.FACTORY_RECIPE_ROOTS = root;
    assert.equal(resolveProjectDir(proj), fs.realpathSync(proj));
  } finally {
    if (saved === undefined) delete process.env.FACTORY_RECIPE_ROOTS;
    else process.env.FACTORY_RECIPE_ROOTS = saved;
  }
});

/* ------------------------------------------------------------------ */
/* Approval gate + execution                                            */
/* ------------------------------------------------------------------ */

async function planAndApprove(
  root: string,
  executor: RecipeExecutor,
  approvals: ReturnType<typeof fakeApprovals>,
  recipeName: string,
  proj: string,
  opts: { status?: string; actionRunId?: string } = {},
): Promise<{ runId: string; approvalId: string }> {
  const run = executor.createPlan(recipeName, proj, 'tester');
  const approvalId = `appr-${run.id}`;
  approvals.map.set(approvalId, {
    status: opts.status ?? 'APPROVED',
    action: applyActionFor(opts.actionRunId ?? run.id),
    requester: 'tester',
  });
  return { runId: run.id, approvalId };
}

test('approval gate: missing / mismatched / pending approvals all rejected with 403 codes', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({ scripts: OK_SCRIPTS, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }),
  });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const run = executor.createPlan('react-19-upgrade', proj, 'tester');

  await assert.rejects(
    () => executor.executeRun(run.id, undefined, 'tester'),
    (e: unknown) => e instanceof RecipeError && e.code === 'APPROVAL_REQUIRED' && recipeErrorStatus(e) === 403,
  );
  await assert.rejects(
    () => executor.executeRun(run.id, 'nope', 'tester'),
    (e: unknown) => e instanceof RecipeError && e.code === 'APPROVAL_REQUIRED',
  );
  approvals.map.set('appr-other', { status: 'APPROVED', action: applyActionFor('a-different-run') });
  await assert.rejects(
    () => executor.executeRun(run.id, 'appr-other', 'tester'),
    (e: unknown) => e instanceof RecipeError && e.code === 'APPROVAL_MISMATCH',
  );
  approvals.map.set('appr-pending', { status: 'PENDING', action: applyActionFor(run.id) });
  await assert.rejects(
    () => executor.executeRun(run.id, 'appr-pending', 'tester'),
    (e: unknown) => e instanceof RecipeError && e.code === 'APPROVAL_NOT_APPROVED',
  );
  assert.ok(events.some((e) => e.event === 'RECIPE_EXECUTION_REJECTED'));
  // Nothing was applied while the gate rejected.
  const content = fs.readFileSync(path.join(proj, 'package.json'), 'utf8');
  assert.ok(content.includes('^18.3.1'));
});

test('drift: file changed after planning → execute refuses with RECIPE_DRIFT (409)', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({ scripts: OK_SCRIPTS, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }),
  });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const { runId, approvalId } = await planAndApprove(root, executor, approvals, 'react-19-upgrade', proj);
  fs.writeFileSync(path.join(proj, 'package.json'), pkgJson({ scripts: OK_SCRIPTS, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', extra: '1' } }), 'utf8');
  await assert.rejects(
    () => executor.executeRun(runId, approvalId, 'tester'),
    (e: unknown) => e instanceof RecipeError && e.code === 'RECIPE_DRIFT' && recipeErrorStatus(e) === 409,
  );
});

/* ------------------------------------------------------------------ */
/* End-to-end: 3 builtin recipes on fixture projects (transform+verify) */
/* ------------------------------------------------------------------ */

test('e2e builtin 1/3: react-19-upgrade transforms package.json and verify passes', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({ scripts: OK_SCRIPTS, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }),
  });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const { runId, approvalId } = await planAndApprove(root, executor, approvals, 'react-19-upgrade', proj);
  const done = await executor.executeRun(runId, approvalId, 'tester');
  assert.equal(done.status, 'done');
  assert.equal(done.verifyResults.length, 2);
  assert.ok(done.verifyResults.every((v) => v.ok && v.exitCode === 0));
  const after = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
  assert.equal(after.dependencies.react, '^19.2.0');
  assert.equal(after.dependencies['react-dom'], '^19.2.0');
  const names = events.map((e) => e.event);
  for (const want of ['RECIPE_PLAN_CREATED', 'RECIPE_FILE_APPLIED', 'RECIPE_APPLIED', 'RECIPE_VERIFY_PASSED', 'RECIPE_RUN_DONE']) {
    assert.ok(names.includes(want), `audit missing ${want}: ${names.join(',')}`);
  }
});

test('e2e builtin 2/3: typescript-5-5-upgrade bumps TS and removes tslint', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({
      scripts: OK_SCRIPTS,
      devDependencies: { typescript: '^4.9.5', tslint: '^6.1.3' },
    }),
  });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const { runId, approvalId } = await planAndApprove(root, executor, approvals, 'typescript-5-5-upgrade', proj);
  const done = await executor.executeRun(runId, approvalId, 'tester');
  assert.equal(done.status, 'done');
  const after = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
  assert.equal(after.devDependencies.typescript, '^5.5.4');
  assert.ok(!('tslint' in after.devDependencies));
});

test('e2e builtin 3/3: eslint-9-flat-config creates eslint.config.mjs and bumps eslint', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({ scripts: OK_SCRIPTS, devDependencies: { eslint: '^8.57.0' } }),
    '.eslintrc.json': '{ "extends": "eslint:recommended" }\n',
  });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const { runId, approvalId } = await planAndApprove(root, executor, approvals, 'eslint-9-flat-config', proj);
  const planned = executor.createPlan; // (plan already created inside planAndApprove)
  void planned;
  const done = await executor.executeRun(runId, approvalId, 'tester');
  assert.equal(done.status, 'done');
  const created = fs.readFileSync(path.join(proj, 'eslint.config.mjs'), 'utf8');
  assert.ok(created.includes('flat config'));
  const after = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
  assert.equal(after.devDependencies.eslint, '^9.39.1');
  // The legacy .eslintrc.json is surfaced as unhandled, not deleted.
  assert.ok(fs.existsSync(path.join(proj, '.eslintrc.json')));
  assert.ok(done.plan.unhandled.some((u) => (u.file ?? '').startsWith('.eslintrc')));
});

test('e2e builtin: jest-to-vitest-deps — removals applied, jest usage in tests listed unhandled', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'package.json': pkgJson({
      scripts: OK_SCRIPTS,
      devDependencies: { jest: '^29.7.0', '@types/jest': '^29.5.0' },
    }),
    'src/util.test.ts': "import { jest } from '@jest/globals';\nconst f = jest.fn();\nexport default f;\n",
  });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const { runId, approvalId } = await planAndApprove(root, executor, approvals, 'jest-to-vitest-deps', proj);
  const done = await executor.executeRun(runId, approvalId, 'tester');
  assert.equal(done.status, 'done');
  const after = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
  assert.equal(after.devDependencies.vitest, '^2.1.9');
  assert.ok(!('jest' in after.devDependencies));
  assert.ok(!('@types/jest' in after.devDependencies));
  // ts-jest/babel-jest were absent → remove attempts are no-match, listed as unhandled (not errors).
  assert.ok(done.plan.unhandled.some((u) => u.reason.includes('nothing to remove')));
  // Test file still using jest is surfaced, not rewritten.
  assert.ok(done.plan.unhandled.some((u) => u.file === 'src/util.test.ts'));
  assert.ok(fs.readFileSync(path.join(proj, 'src/util.test.ts'), 'utf8').includes('jest.fn('));
});

/* ------------------------------------------------------------------ */
/* Verify failure + custom recipes                                      */
/* ------------------------------------------------------------------ */

test('verify failure: files are applied, run is failed with the verify result recorded', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', { 'a.txt': 'old\n' });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const recipe = executor.addCustomRecipe(
    JSON.stringify({
      name: 'verify-fail-recipe',
      version: '1.0.0',
      description: 'd',
      match: { files: ['a.txt'] },
      transform: [{ op: 'replace', file: 'a.txt', search: 'old', replace: 'new' }],
      verify: { test: 'node -e "process.exit(3)"' },
    }),
    'tester',
  );
  assert.equal(recipe.source, 'custom');
  const { runId, approvalId } = await planAndApprove(root, executor, approvals, 'verify-fail-recipe', proj);
  const done = await executor.executeRun(runId, approvalId, 'tester');
  assert.equal(done.status, 'failed');
  assert.equal(done.verifyResults.length, 1);
  assert.equal(done.verifyResults[0].exitCode, 3);
  assert.ok(done.failReason!.includes('verify failed'));
  assert.equal(fs.readFileSync(path.join(proj, 'a.txt'), 'utf8'), 'new\n');
  assert.ok(events.some((e) => e.event === 'RECIPE_VERIFY_FAILED'));
});

test('custom recipes: builtin name shadowing refused; regex + insert ops work end-to-end', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', {
    'src/app.ts': "import React from 'react';\n// TODO marker\n",
  });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  assert.throws(
    () =>
      executor.addCustomRecipe(
        JSON.stringify({
          name: 'react-19-upgrade',
          version: '9.9.9',
          description: 'shadow attempt',
          match: { files: ['x'] },
          transform: [{ op: 'replace', file: 'x', search: 'a', replace: 'b' }],
        }),
        'tester',
      ),
    /builtin recipe name/,
  );
  executor.addCustomRecipe(
    JSON.stringify({
      name: 'regex-insert-demo',
      version: '1.0.0',
      description: 'd',
      match: { files: ['src/app.ts'] },
      transform: [
        { op: 'regex-replace', file: 'src/app.ts', pattern: "from 'react'", replace: "from 'preact'" },
        { op: 'insert', file: 'src/app.ts', anchor: '// TODO marker', position: 'after', text: '\n// inserted by recipe' },
      ],
    }),
    'tester',
  );
  const { runId, approvalId } = await planAndApprove(root, executor, approvals, 'regex-insert-demo', proj);
  const done = await executor.executeRun(runId, approvalId, 'tester');
  assert.equal(done.status, 'done');
  const after = fs.readFileSync(path.join(proj, 'src/app.ts'), 'utf8');
  assert.ok(after.includes("from 'preact'"));
  assert.ok(after.includes('// inserted by recipe'));
});

// ---------- V3R14 #6(e): credential env scrub + output redaction ----------

test('runVerifyCommand: credential env is scrubbed from the child, output is redacted', async () => {
  const keys = ['FACTORY_API_TOKEN', 'FACTORY_API_TOKENS', 'FACTORY_SECRET_PROBE'];
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    process.env[k] = `test-value-for-${k.toLowerCase()}-1234567890`;
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-recipes-6e-'));
  try {
    const r = await runVerifyCommand('printenv', cwd);
    assert.equal(r.ok, true);
    // Line-prefix assertions (R13 #6(d) precedent): the key NAME may
    // legitimately appear as text in unrelated ambient vars.
    const lines = r.output.split('\n');
    for (const k of keys) {
      assert.ok(!lines.some((line) => line.startsWith(`${k}=`)), `output leaked ${k}`);
      assert.ok(!r.output.includes(`test-value-for-${k.toLowerCase()}`), `output leaked the value for ${k}`);
    }
    assert.match(r.output, /^PATH=/m);
    // Secret-shaped values echoed by the verify command are masked, not
    // echoed verbatim (redactText masks the value with an ellipsis marker).
    const echo = await runVerifyCommand(`echo "api_key=sk-proj-v3r14rcEchoToken123456"`, cwd);
    assert.equal(echo.ok, true);
    assert.ok(!echo.output.includes('sk-proj-v3r14rcEchoToken123456'), 'output echoed the secret value verbatim');
    assert.ok(echo.output.includes('\u2026'), 'masked preview expected');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- V3R15 #6(g): recipes `source` key round-trip ----------

test('custom recipes round-trip: persisted file has no `source` key, re-read store lists and plans it', async () => {
  const root = tmpRoot();
  process.env.FACTORY_RECIPE_ROOTS = root;
  const proj = fixture(root, 'app', { 'a.txt': 'old\n' });
  const events: AuditEvent[] = [];
  const approvals = fakeApprovals();
  const executor = makeExecutor(root, approvals.checker, events);
  const recipeJson = JSON.stringify({
    name: 'round-trip-demo',
    version: '1.0.0',
    description: 'd',
    match: { files: ['a.txt'] },
    transform: [{ op: 'replace', file: 'a.txt', search: 'old', replace: 'new' }],
  });
  const added = executor.addCustomRecipe(recipeJson, 'tester');
  assert.equal(added.source, 'custom');
  const customPath = path.join(root, 'custom.json');
  // Write side: the persisted file must not carry the `source` stamp —
  // pre-fix it did, and every re-read rejected the whole store as corrupt.
  const disk = fs.readFileSync(customPath, 'utf8');
  assert.ok(!disk.includes('"source"'), `persisted file still carries source: ${disk.slice(0, 200)}`);
  // Read side: a fresh store re-reading the file lists the recipe, and a
  // fresh executor can plan it (pre-fix: isCorrupt=true, list empty,
  // createPlan threw RECIPE_NOT_FOUND → 404).
  const store2 = new CustomRecipeStore(customPath);
  assert.equal(store2.isCorrupt(), false);
  assert.equal(store2.list().length, 1);
  assert.equal(store2.list()[0].name, 'round-trip-demo');
  const executor2 = makeExecutor(root, approvals.checker, events);
  const run = executor2.createPlan('round-trip-demo', proj, 'tester');
  assert.equal(run.status, 'planned');
  // Read-side tolerance: a legacy poison file (written pre-fix, with
  // `"source": "custom"`) now loads instead of corrupting the store.
  const parsed = JSON.parse(disk) as { recipes: Record<string, unknown>[] };
  fs.writeFileSync(
    customPath,
    JSON.stringify({ recipes: [{ ...parsed.recipes[0], source: 'custom' }] }, null, 2),
    'utf8',
  );
  const store3 = new CustomRecipeStore(customPath);
  assert.equal(store3.isCorrupt(), false);
  assert.equal(store3.list().length, 1);
  // ...while a mismatched `source` value is still rejected (strict-key
  // posture kept — the R15 #6(g) tolerance is equality-gated).
  fs.writeFileSync(
    customPath,
    JSON.stringify({ recipes: [{ ...parsed.recipes[0], source: 'builtin' }] }, null, 2),
    'utf8',
  );
  const store4 = new CustomRecipeStore(customPath);
  assert.equal(store4.isCorrupt(), true);
  assert.equal(store4.list().length, 0);
});
