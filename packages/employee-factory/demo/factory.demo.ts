/**
 * Dynamic AI employee factory demo — spec §18, §19, §59.
 *
 *  1. A Tech Lead requests a PostgreSQL Concurrency Specialist (§18 example):
 *     the self-modification proposal is auto-approved (§59) and governance
 *     checks pass (§19), so the employee is created with template-generated
 *     mission/instructions/skills.
 *  2. The same lead requests a Production Administrator: the proposal is
 *     BLOCKed (§59) and never reaches creation; governance would deny it
 *     too (role not in the allow-list).
 *
 * Run after building the package:
 *   npx tsc -p packages/employee-factory/tsconfig.json
 *   node packages/employee-factory/dist/demo/factory.demo.js
 */
import { AgentRegistry } from '@ai-factory/core';
import {
  createEmployee,
  proposeChange,
  GovernanceError,
  type FactoryPolicy,
} from '../src/index';

const policy: FactoryPolicy = {
  maxChildren: 6,
  maxDepth: 2,
  maxConcurrentAgents: 10,
  maxTotalAgents: 50,
  maxRuntimeMs: 3_600_000,
  maxBudget: 1000,
  allowedRoles: ['engineer', 'specialist', 'lead', 'coder', 'qa', 'reviewer'],
  allowedModels: ['reasoning', 'default'],
  allowedTools: ['SQL Sandbox', 'Repository', 'Terminal'],
  allowedPermissions: [
    'filesystem.read',
    'filesystem.write',
    'shell.execute',
    'git.commit',
    'database.read',
    'database.write',
    'deploy.dev',
  ],
};

function main(): void {
  const registry = new AgentRegistry();
  const techLead = registry.register({ name: 'tech-lead', jobTitle: 'Tech Lead' });
  console.log(`Parent: ${techLead.jobTitle} (${techLead.id})\n`);

  // --- 1. PostgreSQL Concurrency Specialist: proposal → auto-approved → created.
  const proposal = proposeChange(policy, {
    kind: 'create',
    target: 'PostgreSQL Concurrency Specialist',
    rationale: 'This bug appears to involve PostgreSQL transaction isolation.',
    requestedBy: 'tech-lead',
  });
  console.log(`[§59] proposal "Create ${proposal.target}" → ${proposal.status.toUpperCase()}`);
  console.log(`      reason: ${proposal.reason}`);

  if (proposal.status === 'auto-approved') {
    const specialist = createEmployee(
      registry,
      'tech-lead',
      {
        jobTitle: 'PostgreSQL Concurrency Specialist',
        specialty: 'PostgreSQL',
        parentId: techLead.id,
      },
      policy,
    );
    console.log('\n[§18] created:');
    console.log(`  jobTitle : ${specialist.jobTitle}`);
    console.log(`  mission  : ${specialist.mission}`);
    console.log(`  skills   : ${specialist.skills.join(', ')}`);
    console.log(`  tools    : ${specialist.tools.join(', ')}`);
    console.log(`  model    : ${specialist.model} (${specialist.reasoningLevel})`);
    console.log(`  parent   : Tech Lead`);
  }

  // --- 2. Production Administrator: proposal BLOCKed; governance also denies.
  console.log('\n---');
  const bad = proposeChange(policy, {
    kind: 'create',
    target: 'Production Administrator',
    rationale: 'I want to deploy straight to production.',
    requestedBy: 'tech-lead',
  });
  console.log(`[§59] proposal "Create ${bad.target}" → ${bad.status.toUpperCase()}`);
  console.log(`      reason: ${bad.reason}`);

  try {
    createEmployee(
      registry,
      'tech-lead',
      { jobTitle: 'Production Administrator', parentId: techLead.id },
      policy,
    );
    console.log('[§19] ERROR: creation should have been denied');
  } catch (e) {
    if (e instanceof GovernanceError) {
      console.log(`[§19] governance denied creation (reason: ${e.reason})`);
    } else {
      throw e;
    }
  }

  console.log(`\nRegistry now holds ${registry.list().length} agents.`);
}

main();
