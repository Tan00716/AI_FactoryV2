/**
 * org-graph demo — SPEC v2 §9.
 *
 *  1. Build a hybrid org: human owner → AI PM → coder + QA.
 *  2. Show MANAGES as a projection (never stored).
 *  3. Move the coder to a new manager: old authorizations are dropped,
 *     not silently carried over.
 *  4. AI tries to rename the human owner → PROTECTED_RELATIONSHIP.
 *
 * Run: node packages/squads/dist/demo/org-graph.demo.js
 */
import { OrgGraphV2, type OrgNodeV2 } from '../src/index';

const g = new OrgGraphV2();
const mk = (id: string, type: OrgNodeV2['type']): OrgNodeV2 => ({
  id, orgId: 'org-1', type, displayName: id, version: 1, status: 'ACTIVE',
});
const e = (s: string, t: string, rt: 'PRIMARY_REPORTS_TO' | 'CAN_DELEGATE_TO') => ({
  source_node_id: s, target_node_id: t, relationship_type: rt,
  project_scope: null, authority_scope: 'org',
  valid_from: new Date().toISOString(), valid_to: null,
  created_by: 'owner', policy_ref: 'pol-1',
});

for (const n of [mk('owner', 'HUMAN'), mk('pm', 'AI_EMPLOYEE'), mk('coder', 'AI_EMPLOYEE'), mk('qa', 'AI_EMPLOYEE')]) {
  g.addNode(n, 'HUMAN');
}
g.addEdge(e('pm', 'owner', 'PRIMARY_REPORTS_TO'), 'HUMAN');
g.addEdge(e('coder', 'pm', 'PRIMARY_REPORTS_TO'), 'HUMAN');
g.addEdge(e('qa', 'pm', 'PRIMARY_REPORTS_TO'), 'HUMAN');
g.addEdge(e('pm', 'coder', 'CAN_DELEGATE_TO'), 'HUMAN');

console.log('manages(owner) =', g.manages('owner').map((n) => n.id).join(', '));
console.log('manages(pm)    =', g.manages('pm').map((n) => n.id).join(', '));
console.log('primaryManager(coder) =', g.primaryManager('coder')!.id);

g.assertDelegationChain(['pm', 'coder']);
console.log('delegation chain pm→coder: granted and acyclic');

const moved = g.applyChange(
  [{ op: 'addNode', node: mk('pm2', 'AI_EMPLOYEE') },
   { op: 'addEdge', edge: { ...e('pm2', 'owner', 'PRIMARY_REPORTS_TO') } },
   { op: 'addEdge', edge: { ...e('coder', 'pm2', 'PRIMARY_REPORTS_TO') } }],
  'HUMAN',
);
console.log('coder moved to pm2; authorizations dropped:', moved.authorizationsDropped);
console.log('primaryManager(coder) =', g.primaryManager('coder')!.id);

try {
  g.updateNode('owner', { identity: { name: 'Mallory' } }, 'AI');
  console.log('FAIL: AI renamed the human owner');
  process.exit(1);
} catch (err) {
  console.log('AI rename of human owner blocked:', (err as Error).message);
}

console.log('\norg-graph demo: all checks passed');
