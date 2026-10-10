/**
 * Task squad + organization designer demo — spec §20, §14.
 *
 *  1. Design the PERSISTENT organization (§14): PM → Tech Lead → two
 *     Senior Engineers + QA Lead. Validate the graph.
 *  2. Assemble a temporary TASK SQUAD (§20) for Task #1042 from the org
 *     members, show it active, then archive it on task completion —
 *     members return to the pool without touching the org itself.
 *
 * Run after building the package:
 *   npx tsc -p packages/squads/tsconfig.json
 *   node packages/squads/dist/demo/squad.demo.js
 */
import { AgentRegistry } from '@ai-factory/core';
import {
  OrganizationDesigner,
  SquadManager,
  type OrgNode,
} from '../src/index';

function main(): void {
  // --- Persistent organization: register real agents, then model the graph.
  const registry = new AgentRegistry();
  const pm = registry.register({ name: 'pm', jobTitle: 'AI PM' });
  const lead = registry.register({ name: 'tech-lead', jobTitle: 'Tech Lead', parentAgentId: pm.id });
  const be = registry.register({
    name: 'backend-eng',
    jobTitle: 'Senior Backend Engineer',
    parentAgentId: lead.id,
  });
  const fe = registry.register({
    name: 'frontend-eng',
    jobTitle: 'Senior Frontend Engineer',
    parentAgentId: lead.id,
  });
  const qa = registry.register({
    name: 'qa-lead',
    jobTitle: 'QA Lead',
    parentAgentId: lead.id,
  });

  const designer = new OrganizationDesigner();
  const add = (id: string, title: string, agentId: string, parentId: string | null) => {
    const n: OrgNode = { id, agentId, title, parentId, status: 'IDLE' };
    designer.addNode(n);
  };
  add('pm', 'AI PM', pm.id, null);
  add('tech-lead', 'Tech Lead', lead.id, 'pm');
  add('backend', 'Senior Backend Engineer', be.id, 'tech-lead');
  add('frontend', 'Senior Frontend Engineer', fe.id, 'tech-lead');
  add('qa', 'QA Lead', qa.id, 'tech-lead');

  const v = designer.validate();
  console.log(`[§14] persistent org graph valid: ${v.ok}`);
  console.log('      PM → Tech Lead → {Backend, Frontend, QA}');

  // --- Task squad: temporary, assembled per task complexity (§20 example).
  const squads = new SquadManager();
  const squad = squads.assemble('TASK-1042', [lead.id, be.id, qa.id]);
  console.log(`\n[§20] assembled squad for TASK-1042 (${squad.memberIds.length} members):`);
  for (const m of squad.memberIds) {
    console.log(`      ├── ${registry.get(m).jobTitle}`);
  }
  console.log(`      active squads: ${squads.listActive().length}`);

  // Task done → archive. Members return to the pool; the persistent org
  // and the registry are untouched (pure bookkeeping).
  const done = squads.archive('TASK-1042');
  console.log(`\n[§20] archived squad ${done.taskId} at ${done.archivedAt}`);
  console.log(`      active squads: ${squads.listActive().length}, archived: ${squads.listArchived().length}`);
  console.log(`      org nodes still intact: ${designer.toGraph().nodes.length}`);
}

main();
