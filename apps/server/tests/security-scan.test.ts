/**
 * Security scan tests (wave2-④) — deterministic secret / SAST / SCA
 * detectors, security-rules file, quality-gate linkage.
 *
 * Pure-engine tests import ../src/inspections.ts and
 * ../src/quality-gate.ts directly (node builtins only, type-stripping
 * loader). The quality-gate linkage test boots the real server from
 * dist over HTTP (same harness style as quality-routes.test.ts).
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/security-scan.test.ts
 * (the HTTP part requires `npm run build` first — the server boots from dist).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditDependencies,
  BUILTIN_VULNERABLE,
  compareVersions,
  defaultInspectionProfile,
  defaultSecurityRules,
  isValidRange,
  loadSecurityRules,
  runSecurityScan,
  sastPatternsChecker,
  secretScanChecker,
  saveSecurityRules,
  SECURITY_BLACKLIST_SNAPSHOT,
  validateSecurityRules,
  versionInRange,
  InspectionConfigError,
} from '../src/inspections.ts';
import { defaultQualityGateConfig, validateQualityGateConfig } from '../src/quality-gate.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aif-secscan-'));
}

function write(root: string, rel: string, content: string): void {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.join(fp, '..'), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

const run = (checker: typeof secretScanChecker, file: string, lines: string[]) =>
  checker.run({ file, lines });

// ---------------------------------------------------------------------------
// secret-scan
// ---------------------------------------------------------------------------

test('secret-scan: flags specific token shapes (true positives)', () => {
  const lines = [
    'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
    'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";',
    'const tok = "ghp_' + 'a'.repeat(36) + '";',
    'const gh2 = "github_pat_' + 'a'.repeat(82) + '";',
    'key: "-----BEGIN RSA PRIVATE KEY-----",',
    'const k = "AIza' + 'b'.repeat(35) + '";',
    'const sg = "SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43) + '";',
    'const npm = "npm_' + 'c'.repeat(36) + '";',
  ];
  const out = run(secretScanChecker, 'src/config.ts', lines);
  assert.equal(out.length, lines.length, JSON.stringify(out.map((o) => o.message)));
  for (const f of out) {
    assert.equal(f.severity, 'error');
    assert.equal(f.checker, 'secret-scan');
    // The matched secret is masked — never echoed into findings/audit.
    assert.match(f.message, /…/);
    assert.ok(!f.message.includes('AKIAIOSFODNN7EXAMPLE'), 'full key must not appear in the message');
  }
  const names = out.map((f) => f.detail).sort();
  assert.deepEqual(names, [
    'aws-access-key',
    'aws-secret-key',
    'github-pat-classic',
    'github-pat-fine-grained',
    'google-api-key',
    'npm-token',
    'private-key',
    'sendgrid-key',
  ]);
});

test('secret-scan: generic assignment heuristics fire with real-looking values', () => {
  const out = run(secretScanChecker, 'src/app.ts', [
    'const api_key = "r34l-s3cr3t-v4lu3-xyz";',
    "password = 'hunter2hunter2';",
    'Authorization = "Bearer abcdefghijklmnop1234";',
    'const url = "https://user:sup3rs3cret@db.internal/x";',
  ]);
  assert.equal(out.length, 4);
  assert.ok(out.every((f) => f.severity === 'error'));
});

test('secret-scan: placeholders and nosec annotations are suppressed', () => {
  const out = run(secretScanChecker, 'src/app.ts', [
    'const api_key = "your-secret-here";', // placeholder
    'const api_key = "example-key-12345678";', // placeholder
    'const api_key = "real-secret-value-987654321"; // nosec', // plain nosec
    'const k = "AKIAIOSFODNN7EXAMPLE"; // nosec:aws-access-key', // scoped nosec
  ]);
  assert.equal(out.length, 0, JSON.stringify(out.map((o) => o.message)));
});

test('secret-scan: scoped nosec with the wrong rule id does not suppress', () => {
  const out = run(secretScanChecker, 'src/app.ts', [
    'const k = "AKIAIOSFODNN7EXAMPLE"; // nosec:other-rule',
  ]);
  assert.equal(out.length, 1);
});

test('secret-scan: generic heuristics skip test files; specific shapes still fire', () => {
  const fixture = 'const api_key = "r34l-s3cr3t-v4lu3-xyz";';
  assert.equal(run(secretScanChecker, 'src/app.ts', [fixture]).length, 1);
  assert.equal(run(secretScanChecker, 'src/app.test.ts', [fixture]).length, 0);
  assert.equal(run(secretScanChecker, 'tests/fixtures/x.ts', [fixture]).length, 0);
  // Unambiguous shapes still fire in fixtures — a real key in a test
  // fixture is still a leak if the repo is real.
  const key = 'const awsKey = "AKIAIOSFODNN7EXAMPLE";';
  assert.equal(run(secretScanChecker, 'src/app.test.ts', [key]).length, 1);
});

test('secret-scan: clean code produces no findings', () => {
  const out = run(secretScanChecker, 'src/app.ts', [
    'const x = 1;',
    '// TODO: rotate keys regularly',
    'const apiUrl = "https://api.example.com/v1";',
    'process.env.AWS_ACCESS_KEY_ID', // env reference, not a value
  ]);
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// sast-patterns
// ---------------------------------------------------------------------------

test('sast: flags injection sinks with error severity', () => {
  const lines = [
    'const r = eval(userInput);',
    'const f = new Function("a", "return a");',
    'db.query(`SELECT * FROM users WHERE id = ${id}`);',
    'execSync("ls " + dir);',
    'httpsAgent = new https.Agent({ rejectUnauthorized: false });',
  ];
  const out = run(sastPatternsChecker, 'src/app.ts', lines);
  // The db.query() line matches two rules (call interpolation + keyword
  // concat) — dual flags on one line are by design. The keyword-concat
  // flag is a warning; the other five are errors.
  assert.equal(out.length, lines.length + 1, JSON.stringify(out.map((o) => o.message)));
  assert.equal(out.filter((f) => f.severity === 'error').length, 5);
  assert.equal(out.filter((f) => f.detail === 'sql-keyword-concat' && f.severity === 'warning').length, 1);
  const ids = [...new Set(out.map((f) => f.detail))].sort();
  assert.deepEqual(ids, ['eval-call', 'function-constructor', 'shell-string-injection', 'sql-keyword-concat', 'sql-string-injection', 'tls-verification-disabled']);
});

test('sast: flags heuristic warnings (context-sensitive rules)', () => {
  const out = run(sastPatternsChecker, 'src/app.py', [
    'data = pickle.loads(blob)',
    'cfg = yaml.load(open("x.yml"))',
    'el.innerHTML = name;',
    'const token = Math.random().toString(36);',
    'const h = createHash("sha1").update(password);',
  ]);
  assert.equal(out.length, 5);
  const ids = out.map((f) => f.detail).sort();
  assert.deepEqual(ids, ['dom-xss-sink', 'insecure-randomness', 'unsafe-deserialization', 'weak-crypto-hash', 'yaml-unsafe-load']);
  assert.ok(out.every((f) => f.severity === 'warning'));
});

test('sast: safe equivalents and missing context produce no findings', () => {
  const out = run(sastPatternsChecker, 'src/app.ts', [
    "const h = createHash('sha1').update(data);", // sha1 without credential context
    'const n = Math.random();', // random without security context
    'spawn("sh", ["-c", cmd]);', // static first arg
    'execFile("git", ["status"]);',
    'cfg = yaml.load(f, Loader=yaml.SafeLoader);', // safe loader
    'eval(x); // nosec:eval-call',
    'const r = 1; // nosec',
  ]);
  assert.equal(out.length, 0, JSON.stringify(out.map((o) => o.message)));
});

// ---------------------------------------------------------------------------
// version ranges
// ---------------------------------------------------------------------------

test('compareVersions: ordering, equality, prerelease', () => {
  assert.equal(compareVersions('4.17.20', '4.17.21'), -1);
  assert.equal(compareVersions('4.17.21', '4.17.20'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), -1);
  assert.ok(Number.isNaN(compareVersions('not-a-version', '1.2.3')));
});

test('versionInRange: operators, compounds, wildcards', () => {
  assert.equal(versionInRange('4.17.20', '<4.17.21'), true);
  assert.equal(versionInRange('4.17.21', '<4.17.21'), false);
  assert.equal(versionInRange('1.2.7', '>=1.0.0 <1.2.8'), true);
  assert.equal(versionInRange('1.2.8', '>=1.0.0 <1.2.8'), false);
  assert.equal(versionInRange('0.9.9', '>=1.0.0 <1.2.8'), false);
  assert.equal(versionInRange('1.2.3', '1.2.3'), true);
  assert.equal(versionInRange('1.2.4', '1.2.x'), true);
  assert.equal(versionInRange('1.3.0', '1.2.x'), false);
  assert.equal(versionInRange('1.2.3', 'not a range'), false);
  assert.equal(versionInRange('garbage', '<4.17.21'), false);
  assert.equal(isValidRange('<4.17.21'), true);
  assert.equal(isValidRange('>=1.0.0 <1.2.8'), true);
  assert.equal(isValidRange('1.2.x'), true);
  assert.equal(isValidRange('soon'), false);
  assert.equal(isValidRange(''), false);
});

// ---------------------------------------------------------------------------
// SCA (lockfile parsing + blacklist)
// ---------------------------------------------------------------------------

test('auditDependencies: package-lock.json vulnerable vs clean', () => {
  const root = tmpRoot();
  write(root, 'package-lock.json', JSON.stringify({
    name: 'demo', lockfileVersion: 3,
    packages: {
      '': { name: 'demo' },
      'node_modules/lodash': { version: '4.17.20' },
      'node_modules/react': { version: '18.3.1' },
    },
  }));
  const a = auditDependencies(root);
  assert.equal(a.scanned, true);
  assert.deepEqual(a.lockfiles, ['package-lock.json']);
  assert.equal(a.total, 2);
  const vuln = a.vulnerable.filter((v) => v.name === 'lodash');
  assert.equal(vuln.length, 1);
  assert.equal(vuln[0].ruleId, 'CVE-2020-8203');
  assert.equal(vuln[0].severity, 'error');
  assert.equal(vuln[0].builtin, true);
  assert.equal(vuln[0].range, '<4.17.21');

  write(root, 'package-lock.json', JSON.stringify({
    name: 'demo', lockfileVersion: 3,
    packages: { '': { name: 'demo' }, 'node_modules/lodash': { version: '4.17.21' } },
  }));
  const b = auditDependencies(root);
  assert.equal(b.vulnerable.filter((v) => v.name === 'lodash').length, 0);
});

test('auditDependencies: pnpm-lock.yaml parsing', () => {
  const root = tmpRoot();
  write(root, 'pnpm-lock.yaml', [
    'lockfileVersion: "9.0"',
    '',
    'packages:',
    '',
    '  minimist@1.2.5:',
    '    resolution: {integrity: sha512-x}',
    '',
    '  lodash@4.17.21:',
    '    resolution: {integrity: sha512-y}',
    '',
    'snapshots:',
    '',
    '  minimist@1.2.5: {}',
    '',
  ].join('\n'));
  const a = auditDependencies(root);
  assert.deepEqual(a.lockfiles, ['pnpm-lock.yaml']);
  const vuln = a.vulnerable.filter((v) => v.name === 'minimist');
  assert.equal(vuln.length, 1);
  assert.equal(vuln[0].ruleId, 'CVE-2021-44906');
  // The snapshots: section must not double-count.
  assert.equal(a.total, 2);
});

test('auditDependencies: corrupt lockfile is disclosed, not fatal', () => {
  const root = tmpRoot();
  write(root, 'package-lock.json', '{not json');
  const a = auditDependencies(root);
  assert.deepEqual(a.lockfiles, []);
  assert.equal(a.total, 0);
  assert.ok(a.skipped.some((s) => s.startsWith('package-lock.json:')));
});

test('auditDependencies: no lockfiles → clean audit', () => {
  const a = auditDependencies(tmpRoot());
  assert.equal(a.scanned, true);
  assert.deepEqual(a.lockfiles, []);
  assert.equal(a.total, 0);
  assert.deepEqual(a.vulnerable, []);
});

test('auditDependencies: builtin blacklist snapshot is disclosed and dated', () => {
  assert.equal(SECURITY_BLACKLIST_SNAPSHOT, '2026-10-20');
  assert.ok(BUILTIN_VULNERABLE.length >= 10);
  const a = auditDependencies(tmpRoot());
  assert.equal(a.snapshot, SECURITY_BLACKLIST_SNAPSHOT);
  assert.match(a.snapshotNote, /not a live feed/);
  assert.match(a.note, /not a substitute for a live feed/);
});

// ---------------------------------------------------------------------------
// security-rules.json (custom rules + exemptions)
// ---------------------------------------------------------------------------

test('security rules: missing file → defaults; save/validate round trip', () => {
  const root = tmpRoot();
  const r = loadSecurityRules(root);
  assert.equal(r.source, 'default-missing');
  assert.deepEqual(r.rules, defaultSecurityRules());
  const saved = saveSecurityRules(root, {
    additionalVulnerable: [{ package: 'left-pad', range: '<1.3.1', severity: 'error', id: 'CUSTOM-1' }],
    suppress: [{ checker: 'secret-scan', file: 'src/fixtures/*', note: 'fixtures' }],
  });
  assert.equal(saved.additionalVulnerable[0].package, 'left-pad');
  assert.equal(saved.suppress[0].file, 'src/fixtures/*');
  const reloaded = loadSecurityRules(root);
  assert.equal(reloaded.source, 'file');
  assert.equal(reloaded.rules.additionalVulnerable.length, 1);
});

test('security rules: custom SCA rule produces non-builtin findings', () => {
  const root = tmpRoot();
  saveSecurityRules(root, {
    additionalVulnerable: [{ package: 'left-pad', range: '<1.3.1', severity: 'error', id: 'CUSTOM-1', note: 'demo rule' }],
  });
  write(root, 'package-lock.json', JSON.stringify({
    name: 'demo', lockfileVersion: 3,
    packages: { '': {}, 'node_modules/left-pad': { version: '1.3.0' } },
  }));
  const { rules } = loadSecurityRules(root);
  const a = auditDependencies(root, rules.additionalVulnerable);
  const hit = a.vulnerable.find((v) => v.name === 'left-pad');
  assert.ok(hit);
  assert.equal(hit.ruleId, 'CUSTOM-1');
  assert.equal(hit.builtin, false);
  assert.equal(hit.note, 'demo rule');
});

test('security rules: invalid input rejected; corrupt file is loud, not fatal', () => {
  assert.throws(
    () => saveSecurityRules(tmpRoot(), { additionalVulnerable: [{ package: 'x', range: 'soon' }] }),
    InspectionConfigError,
  );
  assert.throws(
    () => saveSecurityRules(tmpRoot(), { suppress: [{ file: 'a.ts' }] }),
    InspectionConfigError,
  );
  const { errors } = validateSecurityRules({ additionalVulnerable: 'nope' });
  assert.ok(errors.length > 0);
  const root = tmpRoot();
  write(root, '.ai-factory/security-rules.json', '{not json');
  const r = loadSecurityRules(root);
  assert.equal(r.source, 'default-corrupt');
  assert.deepEqual(r.rules, defaultSecurityRules());
});

// ---------------------------------------------------------------------------
// runSecurityScan integration
// ---------------------------------------------------------------------------

test('runSecurityScan: finds secrets and SCA issues; writes nothing', () => {
  const root = tmpRoot();
  write(root, 'src/leak.ts', 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n');
  write(root, 'src/clean.ts', 'export const x = 1;\n');
  write(root, 'package-lock.json', JSON.stringify({
    name: 'demo', lockfileVersion: 3,
    packages: { '': {}, 'node_modules/minimist': { version: '1.2.5' } },
  }));
  const s = runSecurityScan(root);
  assert.ok(s.filesScanned >= 2);
  assert.ok(s.findings.some((f) => f.checker === 'secret-scan' && f.file === 'src/leak.ts'));
  assert.ok(s.dependencies.vulnerable.some((v) => v.name === 'minimist'));
  assert.equal(s.rulesSource, 'default-missing');
  // No side effects: unlike runInspection, the security scan must not
  // write a baseline file into the scanned root.
  assert.equal(fs.existsSync(path.join(root, '.ai-factory', 'inspections-baseline.json')), false);
});

test('runSecurityScan: project exemptions remove findings', () => {
  const root = tmpRoot();
  write(root, 'src/leak.ts', 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n');
  saveSecurityRules(root, { suppress: [{ checker: 'secret-scan', file: 'src/leak.ts' }] });
  const s = runSecurityScan(root);
  assert.equal(s.findings.filter((f) => f.checker === 'secret-scan').length, 0);
});

// ---------------------------------------------------------------------------
// quality-gate config validation
// ---------------------------------------------------------------------------

test('quality gate: security config validates failOn categories', () => {
  const { config, errors } = validateQualityGateConfig({ security: { failOn: ['secret', 'sca'] } });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.security, { failOn: ['secret', 'sca'] });
  const dupes = validateQualityGateConfig({ security: { failOn: ['secret', 'secret'] } });
  assert.deepEqual(dupes.errors, []);
  assert.deepEqual(dupes.config.security, { failOn: ['secret'] });
  const { config: def } = validateQualityGateConfig({});
  assert.deepEqual(def.security, { failOn: [] });
  assert.deepEqual(defaultQualityGateConfig().security, { failOn: [] });
  for (const bad of [
    { security: { failOn: ['nope'] } },
    { security: { failOn: 'secret' } },
    { security: 'secret' },
  ]) {
    const r = validateQualityGateConfig(bad);
    assert.ok(r.errors.length > 0, `expected errors for ${JSON.stringify(bad)}`);
  }
});

test('inspections: default profile enables security checkers and dependency audit', () => {
  const p = defaultInspectionProfile();
  assert.equal(p.checkers['secret-scan'], true);
  assert.equal(p.checkers['sast-patterns'], true);
  assert.equal(p.dependencyAudit, true);
});

// ---------------------------------------------------------------------------
// HTTP: quality-gate linkage (boots the real server from dist)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
  root: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
      } else {
        const { port } = addr as net.AddressInfo;
        srv.close(() => resolve(port));
      }
    });
  });
}

async function startServer(root: string): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-secscan-http-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(dir, 'factory.db'),
    AI_FACTORY_DATA_DIR: path.join(dir, 'data'),
    FACTORY_INSPECT_ROOTS: root,
  };
  for (const k of ['FACTORY_API_TOKEN', 'FACTORY_SECRETS_DIR', 'FACTORY_RUNTIME_TOOLS']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [serverEntry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) throw new Error('server exited during startup');
  return { port, proc, dir, root };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('POST /api/quality/run: security.failOn blocks on secret findings', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'clean.ts'), 'export const x = 1;\n', 'utf8');
  const s = await startServer(root);
  try {
    const put = await api(s.port, 'PUT', '/api/quality', {
      projectId: 'sec-p',
      lintCmd: 'true',
      security: { failOn: ['secret'] },
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.config.security, { failOn: ['secret'] });

    const clean = await api(s.port, 'POST', '/api/quality/run', { projectId: 'sec-p', kind: 'lint' });
    assert.equal(clean.status, 200);
    assert.equal(clean.body.ok, true);
    assert.equal(clean.body.blocked, false);
    assert.ok(clean.body.security);
    assert.equal(clean.body.security.secret, 0);
    assert.equal(clean.body.security.blocked, false);

    // Drop a hardcoded AWS key into the inspected root: the next run blocks.
    fs.writeFileSync(
      path.join(root, 'leak-config.ts'),
      'export const awsKey = "AKIAIOSFODNN7EXAMPLE";\n',
      'utf8',
    );
    const blocked = await api(s.port, 'POST', '/api/quality/run', { projectId: 'sec-p', kind: 'lint' });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.blocked, true);
    assert.equal(blocked.body.security.blocked, true);
    assert.ok(blocked.body.security.secret >= 1, JSON.stringify(blocked.body.security));
  } finally {
    await stopServer(s);
  }
});

test('POST /api/quality/run: no failOn → no security scan in the response', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'clean.ts'), 'export const x = 1;\n', 'utf8');
  const s = await startServer(root);
  try {
    await api(s.port, 'PUT', '/api/quality', { projectId: 'sec-q', lintCmd: 'true' });
    const r = await api(s.port, 'POST', '/api/quality/run', { projectId: 'sec-q', kind: 'lint' });
    assert.equal(r.status, 200);
    assert.equal(r.body.blocked, false);
    assert.equal(r.body.security ?? null, null);
  } finally {
    await stopServer(s);
  }
});

test('POST /api/inspections/run: response carries security findings + dependency audit', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'leak.ts'), 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n', 'utf8');
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      name: 'demo', lockfileVersion: 3,
      packages: { '': {}, 'node_modules/minimist': { version: '1.2.5' } },
    }),
    'utf8',
  );
  const s = await startServer(root);
  try {
    const r = await api(s.port, 'POST', '/api/inspections/run', { projectId: 'sec-r', root });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.securityFindings));
    assert.ok(r.body.securityFindings.some((f: any) => f.checker === 'secret-scan' && f.file === 'leak.ts'));
    assert.ok(r.body.dependencies);
    assert.deepEqual(r.body.dependencies.lockfiles, ['package-lock.json']);
    assert.ok(r.body.dependencies.vulnerable.some((v: any) => v.name === 'minimist'));
    assert.equal(r.body.dependencies.snapshot, SECURITY_BLACKLIST_SNAPSHOT);
  } finally {
    await stopServer(s);
  }
});

test('PUT /api/inspections/security-rules: invalid rules are 400; valid persist', async () => {
  const root = tmpRoot();
  const s = await startServer(root);
  try {
    const bad = await api(s.port, 'PUT', '/api/inspections/security-rules', {
      projectId: 'sec-s',
      root,
      rules: { additionalVulnerable: [{ package: 'x', range: 'soon' }] },
    });
    assert.equal(bad.status, 400);
    const ok = await api(s.port, 'PUT', '/api/inspections/security-rules', {
      projectId: 'sec-s',
      root,
      rules: {
        additionalVulnerable: [{ package: 'left-pad', range: '<1.3.1', severity: 'error', id: 'CUSTOM-1' }],
        suppress: [{ checker: 'secret-scan', file: 'src/fixtures/*' }],
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.rules.additionalVulnerable.length, 1);
    const get = await api(s.port, 'GET', `/api/inspections/security-rules?projectId=sec-s&root=${encodeURIComponent(root)}`);
    assert.equal(get.status, 200);
    assert.equal(get.body.rules.suppress.length, 1);
    assert.ok(get.body.builtIn.count >= 10);
    assert.equal(get.body.builtIn.snapshot, SECURITY_BLACKLIST_SNAPSHOT);
  } finally {
    await stopServer(s);
  }
});
