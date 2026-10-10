/**
 * Tests for the organization designer (spec §14).
 * Run: node --test dist/tests/org-designer.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OrganizationDesigner,
  OrgDesignError,
  type OrgNode,
} from '../src/index';

function node(id: string, title: string, parentId: string | null): OrgNode {
  return { id, agentId: id, title, parentId, status: 'IDLE' };
}

/** §14 example fragment: PM → Tech Lead → coders + QA. */
function sampleOrg(): OrganizationDesigner {
  const d = new OrganizationDesigner();
  d.addNode(node('pm', 'AI PM', null));
  d.addNode(node('tech-lead', 'Tech Lead', 'pm'));
  d.addNode(node('coder1', 'Senior Backend Engineer', 'tech-lead'));
  d.addNode(node('coder2', 'Senior Frontend Engineer', 'tech-lead'));
  d.addNode(node('qa', 'QA Lead', 'tech-lead'));
  return d;
}

describe('OrganizationDesigner', () => {
  it('validates a well-formed org graph (§14)', () => {
    const v = sampleOrg().validate();
    assert.equal(v.ok, true);
    assert.deepEqual(v.errors, []);
  });

  it('detects a cycle', () => {
    const d = sampleOrg();
    // Create a cycle: tech-lead → coder1 → tech-lead.
    d.moveNode('tech-lead', 'coder1');
    const v = d.validate();
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('cycle detected')));
  });

  it('detects a missing parent', () => {
    const d = new OrganizationDesigner();
    d.addNode(node('orphan', 'Lost Engineer', 'ghost'));
    const v = d.validate();
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('missing parent ghost')));
  });

  it('detects multiple roots', () => {
    const d = new OrganizationDesigner();
    d.addNode(node('pm', 'AI PM', null));
    d.addNode(node('pm2', 'Rogue PM', null));
    const v = d.validate();
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('2 roots')));
  });

  it('detects a missing root', () => {
    const d = new OrganizationDesigner();
    d.addNode(node('a', 'A', 'b'));
    d.addNode(node('b', 'B', 'a'));
    const v = d.validate();
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('no root')));
    assert.ok(v.errors.some((e) => e.includes('cycle detected')));
  });

  it('rejects duplicate node ids and self-parenting on add', () => {
    const d = sampleOrg();
    assert.throws(() => d.addNode(node('pm', 'Dup', null)), OrgDesignError);
    assert.throws(
      () => d.addNode({ ...node('x', 'X', null), parentId: 'x' }),
      OrgDesignError,
    );
  });

  it('moveNode re-parents a node and rejects unknown ids/parents', () => {
    const d = sampleOrg();
    d.moveNode('qa', 'pm');
    assert.equal(d.getNode('qa').parentId, 'pm');
    assert.equal(d.validate().ok, true);
    assert.throws(() => d.moveNode('nope', 'pm'), OrgDesignError);
    assert.throws(() => d.moveNode('qa', 'nope'), OrgDesignError);
  });

  it('removeNode re-parents children to the removed node\'s parent', () => {
    const d = sampleOrg();
    d.removeNode('tech-lead');
    assert.throws(() => d.getNode('tech-lead'), OrgDesignError);
    assert.equal(d.getNode('coder1').parentId, 'pm');
    assert.equal(d.getNode('qa').parentId, 'pm');
    assert.equal(d.validate().ok, true);
  });

  it('toJSON/fromJSON round-trips the graph', () => {
    const d = sampleOrg();
    const json = d.toJSON();
    const restored = OrganizationDesigner.fromJSON(json);
    assert.deepEqual(restored.toGraph(), d.toGraph());
    assert.equal(restored.validate().ok, true);
  });

  it('fromJSON rejects invalid input', () => {
    assert.throws(() => OrganizationDesigner.fromJSON('not json'), OrgDesignError);
    assert.throws(
      () => OrganizationDesigner.fromJSON('{"nodes": "nope"}'),
      OrgDesignError,
    );
  });
});
