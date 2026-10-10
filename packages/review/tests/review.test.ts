/**
 * Tests for the Code Review Agent (spec §35) and its gate wiring (spec §12).
 * Run: node --test dist/tests/review.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_DIMENSIONS,
  Finding,
  meetsGate,
  reviewCode,
  reviewGateEvidence,
  ReviewDimension,
  ReviewInput,
  ReviewVerdict,
} from '../src/index';

function forDim(findings: Finding[], dim: ReviewDimension): Finding[] {
  return findings.filter((f) => f.dimension === dim);
}

function reviewed(input: ReviewInput): Finding[] {
  return reviewCode(input).findings;
}

const file = (path: string, after: string, before?: string) => ({
  path,
  after,
  ...(before === undefined ? {} : { before }),
});

/* ---------------- 1. correctness ---------------- */
describe('correctness', () => {
  it('warns on loose equality', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'if (a == b) {\n  go();\n}')],
    });
    const hits = forDim(fs, 'correctness');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
    assert.equal(hits[0]?.line, 1);
  });

  it('is silent for strict equality', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'if (a === b && c !== d) {\n  go();\n}')],
    });
    assert.equal(forDim(fs, 'correctness').length, 0);
  });

  it('warns on an empty catch block', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'try {\n  go();\n} catch (e) {}')],
    });
    const hits = forDim(fs, 'correctness');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
  });

  it('is silent when the catch block handles the error', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'try {\n  go();\n} catch (e) {\n  log(e);\n}')],
    });
    assert.equal(forDim(fs, 'correctness').length, 0);
  });
});

/* ---------------- 2. architecture ---------------- */
describe('architecture', () => {
  it('errors on circular imports between reviewed files', () => {
    const fs = reviewed({
      files: [
        file('src/a.ts', "import { b } from './b';\nexport const a = 1;"),
        file('src/b.ts', "import { a } from './a';\nexport const b = 2;"),
      ],
    });
    const hits = forDim(fs, 'architecture').filter(
      (f) => f.severity === 'error' && f.message.includes('Circular import'),
    );
    assert.ok(hits.length >= 1, 'expected a circular-import error');
  });

  it('is silent for one-way imports', () => {
    const fs = reviewed({
      files: [
        file('src/a.ts', "import { b } from './b';\nexport const a = 1;"),
        file('src/b.ts', 'export const b = 2;'),
      ],
    });
    assert.equal(
      forDim(fs, 'architecture').filter((f) => f.message.includes('Circular')).length,
      0,
    );
  });

  it('warns on deep relative imports', () => {
    const fs = reviewed({
      files: [file('src/deep/mod.ts', "import { x } from '../../../lib/x';")],
    });
    const hits = forDim(fs, 'architecture');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
    assert.match(hits[0]?.message ?? '', /Deep relative import/);
  });
});

/* ---------------- 3. readability ---------------- */
describe('readability', () => {
  it('infos a bare TODO without an issue reference', () => {
    const fs = reviewed({
      files: [file('src/a.ts', '// TODO: refactor this later')],
    });
    const hits = forDim(fs, 'readability');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'info');
  });

  it('is silent for TODO with an issue reference', () => {
    const fs = reviewed({
      files: [file('src/a.ts', '// TODO(#123): refactor this later')],
    });
    assert.equal(forDim(fs, 'readability').length, 0);
  });

  it('infos lines longer than 120 chars', () => {
    const fs = reviewed({
      files: [file('src/a.ts', `const x = '${'y'.repeat(130)}';`)],
    });
    const hits = forDim(fs, 'readability');
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.message ?? '', /exceed 120 chars/);
  });
});

/* ---------------- 4. maintainability ---------------- */
describe('maintainability', () => {
  it('warns on files over 500 lines', () => {
    const big = Array.from({ length: 501 }, () => 'const x = 1;').join('\n');
    const fs = reviewed({ files: [file('src/big.ts', big)] });
    const hits = forDim(fs, 'maintainability');
    assert.ok(hits.some((f) => f.message.includes('501 lines')));
    assert.ok(hits.every((f) => f.severity === 'warning'));
  });

  it('is silent for a short file', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'export function f(): number {\n  return 1;\n}')],
    });
    assert.equal(forDim(fs, 'maintainability').length, 0);
  });

  it('warns on functions over 80 lines', () => {
    const body = Array.from({ length: 81 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const fs = reviewed({
      files: [file('src/a.ts', `export function big(): void {\n${body}\n}`)],
    });
    const hits = forDim(fs, 'maintainability');
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.message ?? '', /spans 8\d lines/);
  });

  it('is silent for short functions', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'export const add = (a: number, b: number): number => a + b;')],
    });
    assert.equal(forDim(fs, 'maintainability').length, 0);
  });
});

/* ---------------- 5. security ---------------- */
describe('security', () => {
  it('blocks committed private key material', () => {
    const fs = reviewed({
      files: [file('keys/id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIB...')],
    });
    const hits = forDim(fs, 'security');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'blocker');
  });

  it('errors on a hardcoded api key', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'const api_key = "sk-live-9f8e7d6c5b4a";')],
    });
    const hits = forDim(fs, 'security');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'error');
    assert.match(hits[0]?.message ?? '', /Hardcoded credential/);
  });

  it('errors on eval()', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'const r = eval(userInput);')],
    });
    const hits = forDim(fs, 'security');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'error');
  });

  it('errors on exec() with string concatenation', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'exec("ls " + dir, cb);')],
    });
    const hits = forDim(fs, 'security');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'error');
    assert.match(hits[0]?.message ?? '', /command injection/);
  });

  it('errors on SQL built via string concatenation', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'const q = "SELECT * FROM users WHERE id = " + id;')],
    });
    const hits = forDim(fs, 'security');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'error');
    assert.match(hits[0]?.message ?? '', /SQL injection/);
  });

  it('is silent for secrets read from the environment', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'const key = process.env.API_KEY;\nconst q = db.query("SELECT 1", []);')],
    });
    assert.equal(forDim(fs, 'security').length, 0);
  });
});

/* ---------------- 6. performance ---------------- */
describe('performance', () => {
  it('warns on await inside a loop', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'for (const u of users) {\n  await fetchUser(u);\n}')],
    });
    const hits = forDim(fs, 'performance');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
  });

  it('is silent when the loop has no await', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'for (const u of users) {\n  queue.push(u);\n}')],
    });
    assert.equal(forDim(fs, 'performance').length, 0);
  });
});

/* ---------------- 7. testCoverage ---------------- */
describe('testCoverage', () => {
  it('warns when a new source file has no test file', () => {
    const fs = reviewed({
      files: [file('src/auth/login.ts', 'export function login(): boolean {\n  return true;\n}')],
    });
    const hits = forDim(fs, 'testCoverage');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
  });

  it('is silent when a matching test file is in the change', () => {
    const fs = reviewed({
      files: [
        file('src/auth/login.ts', 'export function login(): boolean {\n  return true;\n}'),
        file('src/auth/login.test.ts', "import { login } from './login';"),
      ],
    });
    assert.equal(forDim(fs, 'testCoverage').length, 0);
  });

  it('is silent for modified (not new) files', () => {
    const fs = reviewed({
      files: [file('src/auth/login.ts', 'export function login(): boolean {\n  return false;\n}', 'old')],
    });
    assert.equal(forDim(fs, 'testCoverage').length, 0);
  });
});

/* ---------------- 8. regressionRisk ---------------- */
describe('regressionRisk', () => {
  it('warns when a shared module changes', () => {
    const fs = reviewed({
      files: [file('src/shared/cache.ts', 'export const cache = {};', 'old')],
    });
    const hits = forDim(fs, 'regressionRisk');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
  });

  it('is silent for a normal feature file', () => {
    const fs = reviewed({
      files: [file('src/auth/login.ts', 'export const x = 1;', 'old')],
    });
    assert.equal(forDim(fs, 'regressionRisk').length, 0);
  });

  it('warns when a public export is removed', () => {
    const fs = reviewed({
      files: [
        file(
          'src/api.ts',
          'export const keep = 1;',
          'export function helper() {\n  return 1;\n}\nexport const keep = 1;',
        ),
      ],
    });
    const hits = forDim(fs, 'regressionRisk');
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.message ?? '', /'helper'.*removed/);
  });
});

/* ---------------- 9. projectConventions ---------------- */
describe('projectConventions', () => {
  it('warns on console usage when the convention forbids it', () => {
    const fs = reviewed({
      files: [file('src/a.ts', "console.log('hi');")],
      projectConventions: ['no-console'],
    });
    const hits = forDim(fs, 'projectConventions');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
  });

  it('is silent when no conventions are passed', () => {
    const fs = reviewed({
      files: [file('src/a.ts', "console.log('hi');")],
    });
    assert.equal(forDim(fs, 'projectConventions').length, 0);
  });

  it('warns on non-kebab-case file names', () => {
    const fs = reviewed({
      files: [file('src/MyComponent.ts', 'export const x = 1;')],
      projectConventions: ['kebab-case-filenames'],
    });
    const hits = forDim(fs, 'projectConventions');
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.message ?? '', /kebab-case/);
  });
});

/* ---------------- 10. dependencyChanges ---------------- */
describe('dependencyChanges', () => {
  const pkg = (deps: Record<string, string>): string =>
    JSON.stringify({ name: 'x', dependencies: deps }, null, 2);

  it('lists added dependencies', () => {
    const fs = reviewed({
      files: [file('package.json', pkg({ a: '1.0.0', b: '2.0.0' }), pkg({ a: '1.0.0' }))],
    });
    const hits = forDim(fs, 'dependencyChanges');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'info');
    assert.match(hits[0]?.message ?? '', /Dependency added.*b@2\.0\.0/);
  });

  it('warns on removed dependencies', () => {
    const fs = reviewed({
      files: [file('package.json', pkg({ a: '1.0.0' }), pkg({ a: '1.0.0', gone: '3.0.0' }))],
    });
    const hits = forDim(fs, 'dependencyChanges');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.severity, 'warning');
    assert.match(hits[0]?.message ?? '', /Dependency removed.*gone/);
  });

  it('is silent when no package.json is touched', () => {
    const fs = reviewed({
      files: [file('src/a.ts', 'export const x = 1;')],
    });
    assert.equal(forDim(fs, 'dependencyChanges').length, 0);
  });
});

/* ---------------- verdict aggregation ---------------- */
describe('verdict aggregation', () => {
  it('covers all 10 spec dimensions', () => {
    assert.equal(ALL_DIMENSIONS.length, 10);
    for (const d of [
      'correctness',
      'architecture',
      'readability',
      'maintainability',
      'security',
      'performance',
      'testCoverage',
      'regressionRisk',
      'projectConventions',
      'dependencyChanges',
    ] as ReviewDimension[]) {
      assert.ok(ALL_DIMENSIONS.includes(d), `missing dimension ${d}`);
    }
  });

  it('BLOCK when a blocker is present', () => {
    const r = reviewCode({
      files: [file('keys/id_rsa', '-----BEGIN RSA PRIVATE KEY-----')],
    });
    assert.equal(r.verdict, 'BLOCK');
  });

  it('CHANGES_REQUESTED when an error is present', () => {
    const r = reviewCode({ files: [file('src/a.ts', 'eval(x);')] });
    assert.equal(r.verdict, 'CHANGES_REQUESTED');
  });

  it('PASS_WITH_WARNINGS when only warnings/infos are present', () => {
    const r = reviewCode({
      files: [file('src/auth/login.ts', 'for (const u of users) {\n  await f(u);\n}', 'old')],
    });
    assert.equal(r.verdict, 'PASS_WITH_WARNINGS');
  });

  it('PASS for a clean change', () => {
    const r = reviewCode({
      files: [
        file('src/math/sum.ts', 'export function sum(a: number, b: number): number {\n  return a + b;\n}'),
        file('src/math/sum.test.ts', "import { sum } from './sum';"),
      ],
    });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.findings.length, 0);
    assert.equal(r.summary.total, 0);
  });

  it('a blocker outranks errors and warnings', () => {
    const r = reviewCode({
      files: [
        file('keys/id_rsa', '-----BEGIN RSA PRIVATE KEY-----'),
        file('src/a.ts', 'eval(x);'),
      ],
    });
    assert.equal(r.verdict, 'BLOCK');
    assert.equal(r.summary.blocker, 1);
    assert.ok(r.summary.error >= 1);
  });

  it('rejects malformed input', () => {
    assert.throws(() => reviewCode({ files: 'nope' } as unknown as ReviewInput));
    assert.throws(() => reviewCode({ files: [{ path: '' }] }));
  });
});

/* ---------------- gate wiring (§12) ---------------- */
describe('gate wiring', () => {
  const verdicts: ReviewVerdict[] = ['PASS', 'PASS_WITH_WARNINGS', 'CHANGES_REQUESTED', 'BLOCK'];
  for (const v of verdicts) {
    it(`meetsGate(${v}) === ${v === 'PASS' || v === 'PASS_WITH_WARNINGS'}`, () => {
      assert.equal(meetsGate(v), v === 'PASS' || v === 'PASS_WITH_WARNINGS');
    });
  }

  it('reviewGateEvidence builds the §12 payload', () => {
    const result = reviewCode({
      files: [file('src/a.ts', 'eval(x);')],
    });
    const payload = reviewGateEvidence(result);
    assert.equal(payload.type, 'code_review');
    assert.equal(payload.verdict, result.verdict);
    assert.deepEqual(payload.findings, result.findings);
    assert.equal(payload.summary.total, result.summary.total);
    assert.ok(typeof payload.reviewedAt === 'string');
  });
});
