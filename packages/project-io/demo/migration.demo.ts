/**
 * migration demo — SPEC v2 §52.3 / §52.4.
 *
 *  1. A hostile import package (path traversal + executable + tampered
 *     hash + claimed admin role) is rejected/quarantined — never trusted.
 *  2. v1 agents migrate: parent_agent/children → PRIMARY_REPORTS_TO edges;
 *     permissions → ceilings (not grants).
 *  3. v1 DONE tasks migrate to legacy_completion_unverified — the demo
 *     asserts no bulk "Outcome Verified" claim is produced.
 *  4. v1 production_approval=auto is staged pending Risk/Reversibility/
 *     Observe checks, not enabled.
 *
 * Run: node packages/project-io/dist/demo/migration.demo.js
 */
import {
  migrateOrgEdges,
  migratePermissionsToCeilings,
  migrateProductionApproval,
  migrateTaskCompletion,
  remapPermissionsToLocal,
  stageUntrustedImport,
  validateUntrustedPackage,
} from '../src/index';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}

console.log('== 1. hostile import package ==');
check('traversal + executable + tampered hash rejected', () => {
  const issues = validateUntrustedPackage({
    files: {
      '.ai/skills/nice.json': '{"id":"nice"}',
      '../../etc/cron.d/evil': 'payload',
      '.ai/mcp/dropper.exe': 'MZ...',
      '.ai/export/project.json': '{"id":"p1"}',
    },
    meta: {
      source: 'attacker.example',
      fileHashes: { '.ai/export/project.json': '0'.repeat(64) },
      declaredLicense: 'unknown',
    },
  });
  const kinds = issues.map((i) => i.message).join(' | ');
  for (const want of ['traversal', 'executable', 'tampered', 'license']) {
    if (!kinds.includes(want)) throw new Error(`missing rejection for: ${want}`);
  }
  console.log(`       ${issues.length} issues: package NOT trusted`);
});

check('staged entities quarantined; admin never inherited', () => {
  const staged = stageUntrustedImport({
    files: {
      '.ai/agents/coder.json': '{"id":"coder"}',
      '.ai/mcp/gh.json': '{"id":"gh"}',
    },
    meta: { source: 'third-party' },
  });
  if (!staged.staged.every((s) => s.status === 'QUARANTINED')) {
    throw new Error('expected every entity QUARANTINED');
  }
  const { grants, dropped } = remapPermissionsToLocal(
    [{ principalId: 'mallory', role: 'admin' }],
    'local-authority',
  );
  if (grants.length !== 0 || dropped.length !== 1) throw new Error('admin leaked through');
  console.log(`       dropped: ${dropped[0]}`);
});

console.log('== 2. v1 org migration ==');
check('parent_agent/children → PRIMARY_REPORTS_TO; perms → ceilings', () => {
  const { edges, warnings } = migrateOrgEdges([
    { id: 'pm', children: ['coder'] },
    { id: 'coder', parent_agent_id: 'pm', permissions: ['deploy.prod'] },
  ]);
  if (warnings.length !== 0) throw new Error(`unexpected warnings: ${JSON.stringify(warnings)}`);
  if (edges.length !== 1 || edges[0].relationship_type !== 'PRIMARY_REPORTS_TO') {
    throw new Error('edge migration wrong');
  }
  const [ceiling] = migratePermissionsToCeilings([{ id: 'coder', permissions: ['deploy.prod'] }]);
  if (!ceiling.ceiling.includes('deploy.prod')) throw new Error('ceiling lost');
  console.log(`       edge: ${edges[0].source_node_id}→${edges[0].target_node_id} (${edges[0].migrated_from})`);
});

console.log('== 3. v1 DONE migration ==');
check('old DONE → legacy_completion_unverified (no bulk upgrade)', () => {
  const tasks = [
    { id: 't1', status: 'DONE' },
    { id: 't2', status: 'DONE', evidenceComplete: true, requirementScopeProvable: true },
  ];
  const results = tasks.map(migrateTaskCompletion);
  if (results[0].status !== 'legacy_completion_unverified') throw new Error('t1 upgraded!');
  if (results[1].status !== 'VERIFIED') throw new Error('t2 should convert with full proof');
  console.log('       t1 → legacy_completion_unverified; t2 → VERIFIED (proven individually)');
});

console.log('== 4. v1 production_approval=auto ==');
check('auto staged pending checks, not enabled', () => {
  const r = migrateProductionApproval({ production_approval: 'auto' });
  if (r.mode !== 'auto_pending_checks') throw new Error('auto was enabled!');
  console.log(`       required checks: ${(r as { requiredChecks: string[] }).requiredChecks.join(', ')}`);
});

if (failures > 0) {
  console.log(`\n${failures} demo check(s) FAILED`);
  process.exit(1);
}
console.log('\nmigration demo: all checks passed');
