/**
 * Tests for discoverProject (spec §32).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProject } from '../src/index';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'projects-discover-'));
});

function write(rel: string, content = ''): void {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('discoverProject', () => {
  it('detects a node/react/pnpm project with CI, git, AGENTS.md, skills and MCP', () => {
    write('package.json', JSON.stringify({
      dependencies: { react: '^19.0.0', next: '^15.0.0' },
      devDependencies: { jest: '^29.0.0' },
    }));
    write('pnpm-lock.yaml');
    write('tsconfig.json', '{}');
    write('.git/HEAD', 'ref: refs/heads/main');
    write('.github/workflows/ci.yml', 'name: ci');
    write('AGENTS.md', '# agents');
    write('skills/deploy/SKILL.md', '# deploy');
    write('.ai/mcp/servers.json', '{}');

    const p = discoverProject(dir);
    assert.equal(p.language, 'typescript');
    assert.equal(p.framework, 'next');
    assert.equal(p.packageManager, 'pnpm');
    assert.equal(p.testFramework, 'jest');
    assert.equal(p.git, true);
    assert.deepEqual(p.ci, ['github-actions']);
    assert.equal(p.hasAgentsMd, true);
    assert.equal(p.skillsDir, true);
    assert.equal(p.mcpConfig, '.ai/mcp/servers.json');
  });

  it('detects a python/fastapi/poetry project with gitlab CI', () => {
    write('pyproject.toml', '[project]\nname="x"\ndependencies=["fastapi"]\n');
    write('poetry.lock', '');
    write('pytest.ini', '');
    write('.gitlab-ci.yml', '');

    const p = discoverProject(dir);
    assert.equal(p.language, 'python');
    assert.equal(p.framework, 'fastapi');
    assert.equal(p.packageManager, 'poetry');
    assert.equal(p.testFramework, 'pytest');
    assert.deepEqual(p.ci, ['gitlab']);
    assert.equal(p.git, false);
    assert.equal(p.mcpConfig, null);
  });

  it('detects a go project with gin', () => {
    write('go.mod', 'module example.com/x\n\nrequire github.com/gin-gonic/gin v1.9.0\n');
    const p = discoverProject(dir);
    assert.equal(p.language, 'go');
    assert.equal(p.framework, 'gin');
    assert.equal(p.packageManager, 'go');
    assert.equal(p.testFramework, 'go test');
  });

  it('detects django via requirements.txt', () => {
    write('requirements.txt', 'django==5.0\n');
    const p = discoverProject(dir);
    assert.equal(p.language, 'python');
    assert.equal(p.framework, 'django');
    assert.equal(p.packageManager, 'pip');
  });

  it('detects a rust project', () => {
    write('Cargo.toml', '[package]\nname="x"\n');
    const p = discoverProject(dir);
    assert.equal(p.language, 'rust');
    assert.equal(p.packageManager, 'cargo');
    assert.equal(p.testFramework, 'cargo test');
  });

  it('detects node:test from a *.test.js file', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    write('test/smoke.test.js', '');
    const p = discoverProject(dir);
    assert.equal(p.language, 'javascript');
    assert.equal(p.testFramework, 'node:test');
    assert.equal(p.packageManager, 'npm');
  });

  it('detects mcp.json at the root', () => {
    write('mcp.json', '{}');
    const p = discoverProject(dir);
    assert.equal(p.mcpConfig, 'mcp.json');
  });

  it('returns nulls for an unknown empty directory', () => {
    const p = discoverProject(dir);
    assert.equal(p.language, null);
    assert.equal(p.framework, null);
    assert.equal(p.packageManager, null);
    assert.equal(p.testFramework, null);
    assert.equal(p.git, false);
    assert.deepEqual(p.ci, []);
    assert.equal(p.hasAgentsMd, false);
    assert.equal(p.skillsDir, false);
  });

  it('throws for a missing directory', () => {
    assert.throws(() => discoverProject(join(dir, 'nope')), /not found/);
  });

  it('detects Jenkinsfile and yarn', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    write('yarn.lock', '');
    write('Jenkinsfile', '');
    const p = discoverProject(dir);
    assert.equal(p.framework, 'express');
    assert.equal(p.packageManager, 'yarn');
    assert.deepEqual(p.ci, ['jenkins']);
  });
});

describe('discoverProject diagnostics (§6.2)', () => {
  const codes = (p: ReturnType<typeof discoverProject>): string[] =>
    p.diagnostics.map((d) => d.code);

  it('records MULTIPLE_LOCKFILES, lists all of them, and still picks deterministically', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    write('package-lock.json', '{}');
    write('yarn.lock', '');
    const p = discoverProject(dir);
    // detectPackageManager precedence is unchanged: yarn wins over npm.
    assert.equal(p.packageManager, 'yarn');
    const diag = p.diagnostics.find((d) => d.code === 'MULTIPLE_LOCKFILES');
    assert.ok(diag, 'expected a MULTIPLE_LOCKFILES diagnostic');
    assert.match(diag.message, /package-lock\.json/);
    assert.match(diag.message, /yarn\.lock/);
    assert.equal(diag.path, 'yarn.lock');
  });

  it('does not flag a single lockfile', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    write('package-lock.json', '{}');
    const p = discoverProject(dir);
    assert.ok(!codes(p).includes('MULTIPLE_LOCKFILES'));
  });

  it('records MISSING_MANIFEST and NO_TEST_COMMAND for an empty directory', () => {
    const p = discoverProject(dir);
    assert.ok(codes(p).includes('MISSING_MANIFEST'));
    assert.ok(codes(p).includes('NO_TEST_COMMAND'));
    assert.deepEqual(p.commands, []);
  });

  it('records NO_TEST_COMMAND for a node project with no test script, dep or files', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    const p = discoverProject(dir);
    assert.equal(p.testFramework, null);
    assert.ok(codes(p).includes('NO_TEST_COMMAND'));
    assert.ok(!codes(p).includes('MISSING_MANIFEST'));
    assert.ok(!p.commands.some((c) => c.kind === 'test'));
  });

  it('records UNKNOWN_COMMAND when scripts.test invokes no recognized runner', () => {
    write('package.json', JSON.stringify({ scripts: { test: 'make test' } }));
    const p = discoverProject(dir);
    assert.ok(codes(p).includes('UNKNOWN_COMMAND'));
    // UNKNOWN_COMMAND covers the gap; NO_TEST_COMMAND must not double-report.
    assert.ok(!codes(p).includes('NO_TEST_COMMAND'));
    assert.ok(!p.commands.some((c) => c.kind === 'test'));
    const diag = p.diagnostics.find((d) => d.code === 'UNKNOWN_COMMAND');
    assert.match(diag!.message, /make test/);
  });

  it('exposes detected commands, all status detected — never verified', () => {
    write('package.json', JSON.stringify({
      scripts: { test: 'jest', build: 'tsc -p .' },
      devDependencies: { jest: '^29.0.0' },
    }));
    write('tsconfig.json', '{}');
    const p = discoverProject(dir);
    const test = p.commands.find((c) => c.kind === 'test');
    assert.ok(test);
    assert.equal(test.command, 'jest');
    assert.equal(test.source, 'package.json scripts.test');
    const build = p.commands.find((c) => c.kind === 'build');
    assert.ok(build);
    assert.equal(build.command, 'tsc -p .');
    assert.ok(p.commands.length > 0);
    assert.ok(p.commands.every((c) => c.status === 'detected'));
    assert.deepEqual(p.diagnostics, []);
  });

  it('detects the test command from a framework dependency when no script exists', () => {
    write('package.json', JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }));
    const p = discoverProject(dir);
    const test = p.commands.find((c) => c.kind === 'test');
    assert.ok(test);
    assert.equal(test.command, 'vitest');
    assert.equal(test.status, 'detected');
    assert.ok(!codes(p).includes('NO_TEST_COMMAND'));
  });

  it('flags python projects with no test markers instead of guessing a PASS', () => {
    write('requirements.txt', 'django==5.0\n');
    const p = discoverProject(dir);
    // Compat: the stdlib fallback in testFramework is unchanged…
    assert.equal(p.testFramework, 'unittest');
    // …but the diagnostic is honest that nothing was actually detected.
    const diag = p.diagnostics.find((d) => d.code === 'NO_TEST_COMMAND');
    assert.ok(diag);
    assert.match(diag.message, /unittest/);
    assert.ok(!p.commands.some((c) => c.kind === 'test'));
  });

  it('detects a go test command with no diagnostics', () => {
    write('go.mod', 'module example.com/x\n');
    const p = discoverProject(dir);
    const test = p.commands.find((c) => c.kind === 'test');
    assert.ok(test);
    assert.equal(test.command, 'go test ./...');
    assert.equal(test.status, 'detected');
    assert.deepEqual(p.diagnostics, []);
  });
});
