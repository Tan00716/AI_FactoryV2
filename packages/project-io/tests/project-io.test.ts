/**
 * Tests for @ai-factory/project-io: YAML round-trip, export layout,
 * secret redaction, import validation, and validate-then-write semantics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildExportFiles,
  importProjectAi,
  parseYaml,
  stringifyYaml,
  validateImportFiles,
  type ProjectExportData,
} from '../src/index';

function sampleData(): ProjectExportData {
  return {
    project: { id: 'proj-1', name: 'MyApp', description: 'demo', path: '/tmp/myapp' },
    policy: { production_approval: 'human', max_concurrent_agents: 4 },
    agents: [
      {
        id: 'agent-1', name: 'Builder', displayName: 'Builder Bot',
        mission: 'Build things\nfast', skills: ['ts', 'react'], autonomyLevel: 3,
      },
    ],
    skills: [{ id: 'skill-1', version: '1.0.0', description: 'TS help', trustLevel: 'OFFICIAL', status: 'ACTIVE' }],
    workflows: [{ id: 'wf-1', name: 'Ship It', definition: { steps: ['build', 'test'] } }],
    knowledge: [{ id: 'k-1', title: 'Runbook', content: 'do the thing', source: 'wiki' }],
    memory: [{ id: 'm-1', scope: 'project', type: 'lesson', title: 'Cache it', confidence: 0.9 }],
    mcp: [
      {
        name: 'github', version: '1.0.0', transport: 'http',
        tools: [{ name: 'get_file' }], scopes: ['repo:read'],
        env: { GITHUB_TOKEN: 'super-secret-value' },
      },
    ],
  };
}

describe('yaml round-trip', () => {
  it('serializer output parses back identically', () => {
    const doc = {
      project: { name: 'MyApp', tags: ['a', 'b'] },
      note: 'line1\nline2 "quoted" # hash: colon',
      count: 8, flag: true, nothing: null, ratio: 1.5,
      agents: [{ name: 'x', role: 'coder' }, { name: 'y', role: 'qa' }],
    };
    const text = stringifyYaml(doc as never);
    const back = parseYaml(text) as Record<string, unknown>;
    assert.deepEqual(back, doc);
  });

  it('escapes backslash-n without corrupting it', () => {
    const text = stringifyYaml({ v: 'a\\nb' } as never); // literal backslash + n
    const back = parseYaml(text) as Record<string, string>;
    assert.equal(back['v'], 'a\\nb');
  });
});

describe('buildExportFiles', () => {
  it('emits the §103 .ai/ layout', () => {
    const files = buildExportFiles(sampleData());
    assert.ok(files['.ai/project.yaml']);
    assert.ok(files['.ai/policy.yaml']);
    assert.ok(files['.ai/agents/agent-1.yaml']);
    assert.ok(files['.ai/skills/skill-1.yaml']);
    assert.ok(files['.ai/workflows/wf-1.yaml']);
    assert.ok(files['.ai/knowledge/k-1.yaml']);
    assert.ok(files['.ai/memory/m-1.yaml']);
    assert.ok(files['.ai/mcp/github.yaml']);
    assert.equal(Object.keys(files).length, 8);
  });

  it('every emitted file parses as YAML', () => {
    const files = buildExportFiles(sampleData());
    for (const [p, text] of Object.entries(files)) {
      parseYaml(text); // throws on invalid YAML
      assert.ok(p.startsWith('.ai/'), p);
    }
  });

  it('redacts secret values, keeps reference names', () => {
    const files = buildExportFiles(sampleData());
    const mcp = files['.ai/mcp/github.yaml'];
    assert.ok(!mcp.includes('super-secret-value'), 'secret value leaked');
    assert.ok(mcp.includes('GITHUB_TOKEN'), 'reference name missing');
    assert.ok(mcp.includes('env_refs'));
  });

  it('project.yaml carries the project name', () => {
    const files = buildExportFiles(sampleData());
    const doc = parseYaml(files['.ai/project.yaml']) as Record<string, Record<string, string>>;
    assert.equal(doc['project']['name'], 'MyApp');
  });

  it('policy.yaml follows the §98 shape with defaults', () => {
    const files = buildExportFiles(sampleData());
    const doc = parseYaml(files['.ai/policy.yaml']) as Record<string, Record<string, unknown>>;
    assert.equal(doc['workflow']['production_approval'], 'human');
    assert.equal(doc['security']['production_write'], 'denied');
    assert.equal(doc['agents']['max_concurrent'], 4);
  });
});

describe('validateImportFiles', () => {
  it('accepts a clean export', () => {
    assert.deepEqual(validateImportFiles(buildExportFiles(sampleData())), []);
  });

  it('rejects a missing project.yaml', () => {
    const files = buildExportFiles(sampleData());
    delete files['.ai/project.yaml'];
    const issues = validateImportFiles(files);
    assert.ok(issues.some((i) => i.file === '.ai/project.yaml'));
  });

  it('rejects missing required fields', () => {
    const issues = validateImportFiles({
      '.ai/project.yaml': 'project:\n  description: no name here\n',
    });
    assert.ok(issues.some((i) => i.message.includes('"name"')));
  });

  it('rejects illegal enum values', () => {
    const issues = validateImportFiles({
      '.ai/project.yaml': 'project:\n  name: X\n',
      '.ai/policy.yaml': 'workflow:\n  production_approval: yolo\n',
    });
    assert.ok(issues.some((i) => i.message.includes('production_approval')));
  });

  it('rejects malformed YAML with a line number', () => {
    const issues = validateImportFiles({
      '.ai/project.yaml': 'project:\n\tname: tab-indented\n',
    });
    assert.ok(issues.some((i) => i.message.includes('YAML parse error')));
  });

  it('rejects secret values, allows *_ref names', () => {
    const bad = validateImportFiles({
      '.ai/project.yaml': 'project:\n  name: X\n',
      '.ai/mcp/gh.yaml': 'name: gh\nenv:\n  GITHUB_TOKEN: abc123\n',
    });
    assert.ok(bad.some((i) => i.message.includes('secret value')));
    const ok = validateImportFiles({
      '.ai/project.yaml': 'project:\n  name: X\n',
      '.ai/mcp/gh.yaml': 'name: gh\nenv_refs:\n  - GITHUB_TOKEN\n',
    });
    assert.deepEqual(ok, []);
  });

  it('rejects path traversal and files outside .ai/', () => {
    const issues = validateImportFiles({
      '.ai/project.yaml': 'project:\n  name: X\n',
      '../evil.yaml': 'x: 1\n',
      '.ai/../also-evil.yaml': 'x: 1\n',
    });
    assert.ok(issues.some((i) => i.message.includes('traversal') || i.message.includes('outside')));
  });

  it('rejects empty exports', () => {
    assert.ok(validateImportFiles({}).length > 0);
  });
});

describe('importProjectAi', () => {
  it('writes files on valid input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-io-'));
    const files = buildExportFiles(sampleData());
    const res = importProjectAi(files, { targetDir: dir });
    assert.equal(res.ok, true);
    assert.deepEqual(res.issues, []);
    assert.equal(res.written.length, Object.keys(files).length);
    for (const abs of res.written) assert.ok(existsSync(abs), abs);
    const proj = readFileSync(join(dir, '.ai', 'project.yaml'), 'utf8');
    assert.ok(proj.includes('MyApp'));
  });

  it('writes nothing when validation fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-io-'));
    const res = importProjectAi(
      { '.ai/project.yaml': 'project:\n  description: missing name\n' },
      { targetDir: dir },
    );
    assert.equal(res.ok, false);
    assert.ok(res.issues.length > 0);
    assert.deepEqual(res.written, []);
    assert.ok(!existsSync(join(dir, '.ai', 'project.yaml')));
  });
});
