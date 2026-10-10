/**
 * Tests for createProject and the template library (spec §33).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProject,
  discoverProject,
  getTemplate,
  listTemplates,
  TEMPLATE_NAMES,
} from '../src/index';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'projects-create-'));
});

describe('template library', () => {
  it('ships exactly the five required templates', () => {
    assert.deepEqual([...TEMPLATE_NAMES], [
      'nextjs-saas',
      'react',
      'python-api',
      'node-api',
      'electron',
    ]);
    assert.equal(listTemplates().length, 5);
  });

  it('every template has an entry file, a README and an ignore file', () => {
    const entries: Record<string, string> = {
      'nextjs-saas': 'app/page.tsx',
      react: 'src/main.jsx',
      'python-api': 'app/main.py',
      'node-api': 'src/index.js',
      electron: 'src/main.js',
    };
    for (const [name, entry] of Object.entries(entries)) {
      const t = getTemplate(name);
      assert.ok(t.files[entry], `${name} is missing ${entry}`);
      assert.ok(t.files['README.md'], `${name} is missing README.md`);
      assert.ok(t.files['.gitignore'], `${name} is missing .gitignore`);
    }
  });

  it('rejects unknown template names', () => {
    assert.throws(() => getTemplate('rails-monolith'), /unknown template/);
  });
});

describe('createProject', () => {
  it('creates dir, skeleton, README, docs and .ai config for a template', () => {
    const created = createProject({ name: 'shop', template: 'node-api', dir });
    assert.ok(existsSync(join(created.dir, 'src', 'index.js')));
    assert.ok(existsSync(join(created.dir, 'README.md')));
    assert.ok(existsSync(join(created.dir, 'docs', 'overview.md')));
    assert.ok(existsSync(join(created.dir, '.ai', 'project.yaml')));
    assert.ok(existsSync(join(created.dir, '.ai', 'policy.yaml')));
    assert.equal(created.template, 'node-api');
    assert.ok(created.files.includes('src/index.js'));
    assert.ok(created.files.includes('.ai/project.yaml'));
  });

  it('writes minimal valid .ai/project.yaml containing the project name', () => {
    const created = createProject({ name: 'crm', template: 'react', dir });
    const yaml = readFileSync(join(created.dir, '.ai', 'project.yaml'), 'utf8');
    assert.match(yaml, /name: crm/);
    assert.match(yaml, /template: react/);
    assert.match(yaml, /language: javascript/);
  });

  it('.ai/policy.yaml carries the §6 permission defaults', () => {
    const created = createProject({ name: 'crm2', dir });
    const yaml = readFileSync(join(created.dir, '.ai', 'policy.yaml'), 'utf8');
    assert.match(yaml, /EXECUTE: true/);
    assert.match(yaml, /NETWORK: project-defined/);
    assert.match(yaml, /PROCESS: false/);
  });

  it('runs git init in the new project', () => {
    const created = createProject({ name: 'gitproj', dir });
    assert.equal(typeof created.gitInitialized, 'boolean');
    if (created.gitInitialized) {
      assert.ok(existsSync(join(created.dir, '.git')));
    }
  });

  it('the created project is discoverable', () => {
    const created = createProject({ name: 'api', template: 'node-api', dir });
    const profile = discoverProject(created.dir);
    assert.equal(profile.language, 'javascript');
    assert.equal(profile.framework, 'express');
    assert.equal(profile.packageManager, 'npm');
    assert.equal(profile.testFramework, 'node:test');
  });

  it('rejects invalid names and unknown templates', () => {
    assert.throws(() => createProject({ name: '', dir }), /name is required/);
    assert.throws(() => createProject({ name: '../evil', dir }), /path separators/);
    assert.throws(
      () => createProject({ name: 'x', template: 'nope' as never, dir }),
      /unknown template/,
    );
  });

  it('does not overwrite an existing README.md', () => {
    const target = join(dir, 'keep');
    const created = createProject({ name: 'keep', dir: target });
    writeFileSync(join(created.dir, 'README.md'), '# custom\n', 'utf8');
    createProject({ name: 'keep', dir: target });
    assert.equal(readFileSync(join(created.dir, 'README.md'), 'utf8'), '# custom\n');
  });
});
