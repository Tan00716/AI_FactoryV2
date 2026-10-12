/**
 * Tests for the §52.4 migration wired into the production import path.
 *
 * runV1Migrations: signal-based detection per section, every section
 * reported applied/skipped (never silent), idempotent on migrated data.
 * importProjectAi: a v1 package is migrated BEFORE validation/write —
 * the files on disk carry the migrated reading, the result carries the
 * structured report, and re-importing the written files is a no-op.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildExportFiles,
  importProjectAi,
  migrateImportFiles,
  parseYaml,
  runV1Migrations,
  type ExportFiles,
  type ProjectExportData,
  type YamlMap,
} from '../src/index';

/* A hand-written v1-era package: flat policy with auto, agents with
 * parent_agent/children, free-text memory, v1 DONE tasks. */
const V1_FILES: ExportFiles = {
  '.ai/project.yaml': 'project:\n  id: proj-old\n  name: OldApp\n',
  '.ai/policy.yaml': 'production_approval: auto\n',
  '.ai/agents/pm.yaml': 'name: pm\nchildren:\n  - coder\n',
  '.ai/agents/coder.yaml':
    'name: coder\nparent_agent_id: pm\npermissions:\n  - deploy.prod\n  - secret.read\n',
  '.ai/memory/notes.md': 'deploy on fridays is fine\n',
  '.ai/memory/lesson.yaml': 'content: "the cache lies"\n',
  '.ai/tasks/t1.yaml': 'id: t1\nstatus: DONE\n',
  '.ai/tasks/t2.yaml':
    'id: t2\nstatus: DONE\nevidence_complete: true\nrequirement_scope_provable: true\n',
};

function readTree(dir: string): ExportFiles {
  const out: ExportFiles = {};
  const walk = (cur: string, rel: string): void => {
    for (const name of readdirSync(cur)) {
      const abs = join(cur, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out[r] = readFileSync(abs, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

function docAt(files: ExportFiles, path: string): YamlMap {
  const doc = parseYaml(files[path]);
  assert.ok(typeof doc === 'object' && doc !== null && !Array.isArray(doc), `${path} should be a map`);
  return doc as YamlMap;
}

describe('runV1Migrations (§52.4, data level)', () => {
  it('migrates every v1 section and reports each one applied', () => {
    const report = runV1Migrations({
      agents: [
        { id: 'pm', children: ['coder'] },
        { id: 'coder', parent_agent_id: 'pm', permissions: ['deploy.prod'] },
      ],
      tasks: [
        { id: 't1', status: 'DONE' },
        { id: 't2', status: 'DONE', evidenceComplete: true, requirementScopeProvable: true },
      ],
      memory: ['deploy on fridays is fine', { type: 'lesson', content: 'structured v2' }],
      policy: { production_approval: 'auto' },
    });
    assert.equal(report.detected, true);
    assert.equal(report.orgEdges.status, 'applied');
    assert.equal(report.orgEdges.count, 1);
    assert.equal(report.orgEdges.edges[0].relationship_type, 'PRIMARY_REPORTS_TO');
    assert.equal(report.permissionCeilings.status, 'applied');
    assert.equal(report.permissionCeilings.count, 1);
    assert.deepEqual(report.permissionCeilings.ceilings[1].ceiling, ['deploy.prod']);
    assert.equal(report.taskCompletions.status, 'applied');
    assert.equal(report.taskCompletions.verified, 1);
    assert.equal(report.taskCompletions.legacyUnverified, 1);
    assert.equal(report.memory.status, 'applied');
    assert.equal(report.memory.count, 1, 'only the free-text entry migrates');
    assert.equal(report.memory.entries[0].status, 'UNVERIFIED');
    assert.equal(report.productionApproval.status, 'applied');
    assert.equal(report.productionApproval.result?.mode, 'auto_pending_checks');
  });

  it('v2-shaped sections are all skipped with reasons — nothing silent', () => {
    const report = runV1Migrations({
      agents: [{ id: 'a1', name: 'Builder', permissions: ['repo.write'] }],
      memory: [{ type: 'lesson', title: 'Cache it', content: 'structured' }],
      policy: { workflow: { production_approval: 'human' } },
    });
    assert.equal(report.detected, false);
    for (const item of [
      report.orgEdges,
      report.permissionCeilings,
      report.taskCompletions,
      report.memory,
    ]) {
      assert.equal(item.status, 'skipped');
      assert.ok(item.note.length > 0, 'skipped sections still explain themselves');
    }
    assert.equal(report.productionApproval.result?.mode, 'human');
  });

  it('empty input detects nothing and still reports every section', () => {
    const report = runV1Migrations({});
    assert.equal(report.detected, false);
    assert.equal(report.orgEdges.status, 'skipped');
    assert.equal(report.taskCompletions.status, 'skipped');
    assert.equal(report.memory.status, 'skipped');
    assert.equal(report.productionApproval.status, 'skipped');
  });

  it('nested policy auto is staged exactly like flat auto', () => {
    const report = runV1Migrations({ policy: { workflow: { production_approval: 'auto' } } });
    assert.equal(report.detected, true);
    assert.equal(report.productionApproval.result?.mode, 'auto_pending_checks');
  });

  it('already-migrated task records are not re-migrated (idempotent)', () => {
    const report = runV1Migrations({
      tasks: [
        { id: 't1', status: 'legacy_completion_unverified', completion_status: 'legacy_completion_unverified', v1_status: 'DONE' },
        { id: 't2', status: 'DONE', completion_status: 'VERIFIED', milestone: 'IMPLEMENTED', v1_status: 'DONE' },
      ],
    });
    assert.equal(report.detected, false);
    assert.equal(report.taskCompletions.status, 'skipped');
    assert.equal(report.taskCompletions.verified, 1, 'standing VERIFIED result is preserved');
    assert.equal(report.taskCompletions.legacyUnverified, 1);
  });
});

describe('importProjectAi with v1 data (§52.4 on the production path)', () => {
  it('migrates a v1 package before writing: files on disk carry the v2 reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-io-v1-'));
    const res = importProjectAi(V1_FILES, { targetDir: dir });
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.equal(res.migration?.detected, true);
    assert.equal(res.migration?.orgEdges.count, 1);
    assert.equal(res.migration?.taskCompletions.verified, 1);
    assert.equal(res.migration?.taskCompletions.legacyUnverified, 1);
    assert.equal(res.migration?.memory.count, 2);
    assert.equal(res.migration?.productionApproval.result?.mode, 'auto_pending_checks');

    const written = readTree(dir);

    // Agent docs: v1 org fields are gone (they live on as edges in the report).
    assert.ok(!written['.ai/agents/coder.yaml'].includes('parent_agent_id'));
    assert.ok(!written['.ai/agents/pm.yaml'].includes('children'));
    assert.ok(written['.ai/agents/coder.yaml'].includes('deploy.prod'));

    // Migration report artifact: edges + ceilings are preserved there.
    const reportOnDisk = JSON.parse(written['.ai/migration-report.json']) as {
      detected: boolean;
      orgEdges: { edges: Array<{ source_node_id: string; target_node_id: string }> };
      permissionCeilings: { ceilings: Array<{ agentId: string; ceiling: string[] }> };
    };
    assert.equal(reportOnDisk.detected, true);
    assert.deepEqual(reportOnDisk.orgEdges.edges, [
      {
        source_node_id: 'coder',
        target_node_id: 'pm',
        relationship_type: 'PRIMARY_REPORTS_TO',
        migrated_from: 'v1.parent_agent',
      },
    ]);
    assert.deepEqual(
      reportOnDisk.permissionCeilings.ceilings.find((c) => c.agentId === 'coder')?.ceiling,
      ['deploy.prod', 'secret.read'],
    );

    // Free-text memory became a structured doc marked UNVERIFIED; the .md is gone.
    assert.ok(!('.ai/memory/notes.md' in written));
    const notes = docAt(written, '.ai/memory/notes.yaml');
    assert.equal(notes['status'], 'UNVERIFIED');
    assert.equal(notes['migrated_from'], 'v1.free_text');
    assert.match(String(notes['content']), /fridays/);
    const lesson = docAt(written, '.ai/memory/lesson.yaml');
    assert.equal(lesson['status'], 'UNVERIFIED');
    assert.equal(lesson['content'], 'the cache lies');

    // Task claims: raw v1 DONE no longer stands as the status.
    const t1 = docAt(written, '.ai/tasks/t1.yaml');
    assert.equal(t1['status'], 'legacy_completion_unverified');
    assert.equal(t1['completion_status'], 'legacy_completion_unverified');
    assert.equal(t1['v1_status'], 'DONE');
    const t2 = docAt(written, '.ai/tasks/t2.yaml');
    assert.equal(t2['completion_status'], 'VERIFIED');
    assert.equal(t2['milestone'], 'IMPLEMENTED');

    // Policy: staged auto did NOT land as an active auto.
    const policy = docAt(written, '.ai/policy.yaml');
    const wf = policy['workflow'] as YamlMap;
    assert.equal(wf['production_approval'], 'human');
    assert.ok(!('production_approval' in policy), 'flat v1 key normalized away');
  });

  it('re-importing the migrated files detects nothing and changes nothing', () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'project-io-v1a-'));
    const first = importProjectAi(V1_FILES, { targetDir: dir1 });
    assert.equal(first.ok, true);

    const migratedFiles = readTree(dir1);
    const dir2 = mkdtempSync(join(tmpdir(), 'project-io-v1b-'));
    const second = importProjectAi(migratedFiles, { targetDir: dir2 });
    assert.equal(second.ok, true, JSON.stringify(second.issues));
    assert.equal(second.migration?.detected, false);
    assert.equal(second.migration?.orgEdges.status, 'skipped');
    assert.equal(second.migration?.taskCompletions.status, 'skipped');
    assert.equal(second.migration?.memory.status, 'skipped');

    const rewritten = readTree(dir2);
    // The first import's report artifact is carried over as a regular
    // file; the second import generates nothing new and changes nothing.
    assert.deepEqual(Object.keys(rewritten).sort(), Object.keys(migratedFiles).sort());
    for (const p of Object.keys(migratedFiles)) {
      assert.equal(rewritten[p], migratedFiles[p], `${p} changed on re-import`);
    }
  });

  it('a genuine v2 export imports untouched: no detection, no report file, byte-identical', () => {
    const data: ProjectExportData = {
      project: { id: 'proj-1', name: 'MyApp', description: 'demo', path: '/tmp/myapp' },
      policy: { production_approval: 'human', max_concurrent_agents: 4 },
      agents: [
        { id: 'agent-1', name: 'Builder', mission: 'Build things', skills: ['ts'], autonomyLevel: 3, permissions: ['repo.write'] },
      ],
      skills: [{ id: 'skill-1', version: '1.0.0', trustLevel: 'OFFICIAL', status: 'ACTIVE' }],
      workflows: [{ id: 'wf-1', name: 'Ship It', definition: { steps: ['build', 'test'] } }],
      knowledge: [{ id: 'k-1', title: 'Runbook', content: 'do the thing', source: 'wiki' }],
      memory: [{ id: 'm-1', scope: 'project', type: 'lesson', title: 'Cache it', confidence: 0.9 }],
      mcp: [],
    };
    const files = buildExportFiles(data);
    const { files: out, report } = migrateImportFiles(files);
    assert.equal(report.detected, false);
    assert.equal(out, files, 'undetected map is returned unchanged (same reference)');

    const dir = mkdtempSync(join(tmpdir(), 'project-io-v2-'));
    const res = importProjectAi(files, { targetDir: dir });
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.equal(res.migration?.detected, false);
    const written = readTree(dir);
    assert.deepEqual(Object.keys(written).sort(), Object.keys(files).sort());
    for (const p of Object.keys(files)) assert.equal(written[p], files[p], `${p} changed`);
  });

  it('migration never masks validation: a v1 package with a secret value is still rejected', () => {
    const bad: ExportFiles = {
      ...V1_FILES,
      '.ai/agents/coder.yaml': 'name: coder\nparent_agent_id: pm\napi_key: hunter2\n',
    };
    const dir = mkdtempSync(join(tmpdir(), 'project-io-bad-'));
    const res = importProjectAi(bad, { targetDir: dir });
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => /secret value/.test(i.message)));
    assert.equal(res.migration?.detected, true, 'migration ran and is reported even on rejection');
    assert.equal(existsSync(join(dir, '.ai')), false, 'nothing was written');
  });

  it('migrateV1: false restores the legacy verbatim behavior (no report)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'project-io-off-'));
    const res = importProjectAi(V1_FILES, { targetDir: dir, migrateV1: false });
    assert.equal(res.migration, undefined);
    // Legacy path rejects the free-text memory file in validation —
    // exactly the silent-era behavior the default now fixes.
    assert.equal(res.ok, false);
  });
});
