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
