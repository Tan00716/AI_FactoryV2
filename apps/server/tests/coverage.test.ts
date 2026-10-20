/**
 * Coverage parser/store tests — imports ../src/coverage.ts straight from
 * src under node's type-stripping ESM loader. This module is node
 * builtins only (+ type-only imports), so it resolves (dual-mode
 * import rule in AGENTS.md).
 *
 * Run: npm run test:server (TMPDIR wrapper); or
 *   node --test apps/server/tests/coverage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CoveragePathError,
  CoverageParseError,
  CoverageStore,
  coverageRoots,
  detectCoverageFormat,
  parseCoberturaReport,
  parseCoverageReport,
  parseLcovReport,
  parseV8Report,
  resolveCoverageReportPath,
} from '../src/coverage.ts';

const LCOV = `TN:
SF:/home/user/proj/src/a.ts
DA:1,1
DA:2,0
DA:3,5
end_of_record
SF:/home/user/proj/src/b.ts
DA:1,0
DA:2,0
end_of_record
`;

test('lcov: parses DA records into per-line hits', () => {
  const files = parseLcovReport(LCOV);
  assert.equal(files.length, 2);
  const a = files.find((f) => f.path.endsWith('a.ts'))!;
  assert.equal(a.totalLines, 3);
  assert.equal(a.coveredLines, 2);
  assert.deepEqual(a.lines, { '1': 1, '2': 0, '3': 5 });
  // worst-first sort: b.ts (0%) before a.ts (66.7%)
  assert.ok(files[0].path.endsWith('b.ts'));
});

test('lcov: merges duplicate SF records by summing hits', () => {
  const files = parseLcovReport(
    `SF:/x/a.ts\nDA:1,2\nend_of_record\nSF:/x/a.ts\nDA:1,3\nDA:2,0\nend_of_record\n`,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].lines['1'], 5);
});

test('lcov: empty report throws CoverageParseError', () => {
  assert.throws(() => parseLcovReport('TN:\nend_of_record\n'), CoverageParseError);
});

const COBERTURA = `<?xml version="1.0" ?>
<coverage version="1.0" line-rate="0.5">
  <sources><source>/home/user/proj</source></sources>
  <packages>
    <package name="src">
      <classes>
        <class name="a" filename="src/a.ts" line-rate="0.66">
          <lines>
            <line number="1" hits="1" branch="false"/>
            <line hits="0" number="2"/>
            <line number="3" hits="4"/>
          </lines>
        </class>
        <class filename="src/b.ts" name="b" line-rate="0">
          <lines><line number="9" hits="0"/></lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`;

test('cobertura: resolves relative filenames against <sources>', () => {
  const files = parseCoberturaReport(COBERTURA);
  assert.equal(files.length, 2);
  const a = files.find((f) => f.path.endsWith(path.join('src', 'a.ts')))!;
  assert.equal(a.path, path.join('/home/user/proj', 'src', 'a.ts'));
  assert.deepEqual(a.lines, { '1': 1, '2': 0, '3': 4 });
  assert.equal(a.totalLines, 3);
  assert.equal(a.coveredLines, 2);
});

test('cobertura: attribute order does not matter (number/hits swapped)', () => {
  const files = parseCoberturaReport(COBERTURA);
  const a = files.find((f) => f.path.endsWith('a.ts'))!;
  assert.equal(a.lines['2'], 0); // <line hits="0" number="2"/>
});

test('cobertura: non-coverage XML throws', () => {
  assert.throws(() => parseCoberturaReport('<html></html>'), CoverageParseError);
});

const V8 = JSON.stringify({
  result: [
    {
      scriptId: '1',
      url: 'file:///home/user/proj/src/a.ts',
      functions: [
        {
          functionName: '',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 0, endOffset: 40, count: 2 },
            { startOffset: 40, endOffset: 90, count: 0 },
          ],
        },
      ],
    },
    { scriptId: '2', url: 'node:internal/buffer', functions: [] },
    { scriptId: '3', url: 'data:text/javascript,1', functions: [] },
  ],
});
const V8_SOURCE = `const a = 1;\nconst b = 2;\nconst c = 3;\nconsole.log(a, b, c);\n`;

test('v8: block ranges translate to approximate line hits, skips non-file urls', () => {
  const files = parseV8Report(V8, (p) => (p === '/home/user/proj/src/a.ts' ? V8_SOURCE : null));
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, '/home/user/proj/src/a.ts');
  // first ~2 lines (0-40 chars) covered with count 2; the rest touched but 0
  assert.ok(f.coveredLines >= 1);
  assert.equal(f.lines['1'], 2);
  assert.equal(f.totalLines, 4);
});

test('v8: invalid JSON throws CoverageParseError', () => {
  assert.throws(() => parseV8Report('{nope', () => null), CoverageParseError);
});

test('detectCoverageFormat: distinguishes the three formats', () => {
  assert.equal(detectCoverageFormat(LCOV), 'lcov');
  assert.equal(detectCoverageFormat(COBERTURA), 'cobertura');
  assert.equal(detectCoverageFormat(V8), 'v8');
  assert.equal(detectCoverageFormat('random text'), null);
});

test('parseCoverageReport: auto-detects + summarizes', () => {
  const r = parseCoverageReport(LCOV, { reportPath: '/tmp/x.info' });
  assert.equal(r.format, 'lcov');
  assert.equal(r.summary.totalLines, 5);
  assert.equal(r.summary.coveredLines, 2);
  assert.ok(Math.abs(r.summary.coverage - 0.4) < 1e-9);
});

test('parseCoverageReport: explicit format wins over detection', () => {
  const r = parseCoverageReport(LCOV, { format: 'lcov' });
  assert.equal(r.format, 'lcov');
});

test('parseCoverageReport: unknown format is an honest parse error', () => {
  assert.throws(() => parseCoverageReport('hello'), CoverageParseError);
});

test('path jail: relative reports resolve under the first root', () => {
  const saved = process.env.FACTORY_COVERAGE_ROOTS;
  process.env.FACTORY_COVERAGE_ROOTS = '/tmp/aa' + (path.delimiter ?? ':') + '/tmp/bb';
  try {
    assert.equal(resolveCoverageReportPath('x/lcov.info'), path.resolve('/tmp/aa/x/lcov.info'));
    assert.throws(() => resolveCoverageReportPath('../../etc/passwd'), CoveragePathError);
    assert.throws(() => resolveCoverageReportPath('/etc/passwd'), CoveragePathError);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_COVERAGE_ROOTS;
    else process.env.FACTORY_COVERAGE_ROOTS = saved;
  }
});

test('path jail: default root is the process cwd', () => {
  const saved = process.env.FACTORY_COVERAGE_ROOTS;
  delete process.env.FACTORY_COVERAGE_ROOTS;
  try {
    assert.deepEqual(coverageRoots(), [path.resolve(process.cwd())]);
  } finally {
    if (saved !== undefined) process.env.FACTORY_COVERAGE_ROOTS = saved;
  }
});

function tmpStore(): { store: CoverageStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-coverage-'));
  return { store: new CoverageStore(path.join(dir, 'coverage-reports.json')), dir };
}

test('store: record then get latest; history capped', () => {
  const { store } = tmpStore();
  for (let i = 0; i < 40; i++) {
    const r = parseCoverageReport(LCOV, { reportPath: '/tmp/x.info' });
    store.record('proj', r, { trigger: 'import' });
  }
  const rec = store.get('proj');
  assert.ok(rec.latest);
  assert.equal(rec.latest.format, 'lcov');
  assert.equal(rec.history.length, 30); // MAX_COVERAGE_HISTORY
  assert.equal(rec.latest.files.length, 2);
  assert.equal(rec.latest.files[0].lines['2'], 0);
});

test('store: corrupt file is fail-closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-coverage-corrupt-'));
  const file = path.join(dir, 'coverage-reports.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.throws(() => new CoverageStore(file).get('proj'), /corrupt/);
});

test('store: unknown project returns null latest', () => {
  const { store } = tmpStore();
  const rec = store.get('nope');
  assert.equal(rec.latest, null);
  assert.deepEqual(rec.history, []);
});
