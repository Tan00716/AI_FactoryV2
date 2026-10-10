/**
 * Tests for the v2 organization graph — SPEC v2 §9.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OrgGraphError,
  OrgGraphV2,
  type ActorKind,
  type OrgNodeV2,
} from '../src/index';

const HUMAN: ActorKind = 'HUMAN';
const AI: ActorKind = 'AI';

function node(id: string, type: OrgNodeV2['type'], orgId = 'org-1'): OrgNodeV2 {
  return { id, orgId, type, displayName: id, version: 1, status: 'ACTIVE' };
}

function edgeBase(source: string, target: string) {
  return {
    source_node_id: source,
    target_node_id: target,
    project_scope: null as string | null,
    authority_scope: 'org',
    valid_from: '2026-10-10T00:00:00.000Z',
    valid_to: null as string | null,
    created_by: 'h1',
    policy_ref: 'pol-1',
  };
}

function graphWithTeam(): OrgGraphV2 {
  const g = new OrgGraphV2();
  g.addNode(node('owner', 'HUMAN'), HUMAN);
  g.addNode(node('pm', 'AI_EMPLOYEE'), HUMAN);
  g.addNode(node('coder', 'AI_EMPLOYEE'), HUMAN);
  g.addEdge({ ...edgeBase('pm', 'owner'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
  g.addEdge({ ...edgeBase('coder', 'pm'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
  return g;
}

function graphError(fn: () => unknown): OrgGraphError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof OrgGraphError, `expected OrgGraphError, got ${e}`);
    return e as OrgGraphError;
  }
  assert.fail('expected OrgGraphError');
}

describe('edge directions and storage rules (§9.1)', () => {
  it('MANAGES is never stored — it is a projection', () => {
    const g = graphWithTeam();
    const err = graphError(() =>
      g.applyChange(
        [{ op: 'addEdge', edge: { ...edgeBase('owner', 'pm'), relationship_type: 'MANAGES' as never } }],
        HUMAN,
      ),
    );
    assert.equal(err.code, 'MANAGES_NOT_STORED');
  });

  it('manages() projects PRIMARY_REPORTS_TO in reverse', () => {
    const g = graphWithTeam();
    assert.deepEqual(g.manages('owner').map((n) => n.id), ['pm']);
    assert.deepEqual(g.manages('pm').map((n) => n.id), ['coder']);
    assert.deepEqual(g.manages('coder'), []);
  });

  it('primaryManager returns the single manager', () => {
    const g = graphWithTeam();
    assert.equal(g.primaryManager('coder')!.id, 'pm');
    assert.equal(g.primaryManager('owner'), null);
  });

  it('rejects a second active primary manager for the same employee', () => {
    const g = graphWithTeam();
    g.addNode(node('pm2', 'AI_EMPLOYEE'), HUMAN);
    const err = graphError(() =>
      g.addEdge({ ...edgeBase('coder', 'pm2'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN),
    );
    assert.equal(err.code, 'MULTIPLE_PRIMARY_MANAGERS');
  });

  it('rejects cross-org edges', () => {
    const g = graphWithTeam();
    g.addNode(node('ext', 'AI_EMPLOYEE', 'org-2'), HUMAN);
    const err = graphError(() =>
      g.addEdge({ ...edgeBase('coder', 'ext'), relationship_type: 'CONSULTS' }, HUMAN),
    );
    assert.equal(err.code, 'SCOPE_VIOLATION');
  });

  it('rejects self edges', () => {
    const g = graphWithTeam();
    const err = graphError(() =>
      g.addEdge({ ...edgeBase('pm', 'pm'), relationship_type: 'CONSULTS' }, HUMAN),
    );
    assert.equal(err.code, 'SELF_EDGE');
  });
});

describe('graph constraints (§9.2)', () => {
  it('primary management cycles are rejected', () => {
    const g = graphWithTeam();
    const err = graphError(() =>
      g.addEdge({ ...edgeBase('owner', 'coder'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN),
    );
    assert.ok(['CYCLE_DETECTED', 'MULTIPLE_PRIMARY_MANAGERS'].includes(err.code));
  });

  it('delegation chains must be acyclic, depth-limited, and actually granted', () => {
    const g = graphWithTeam();
    g.addEdge({ ...edgeBase('pm', 'coder'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
    g.assertDelegationChain(['pm', 'coder']); // ok
    // A report edge is not a delegation grant.
    g.addEdge({ ...edgeBase('coder', 'pm'), relationship_type: 'FUNCTIONALLY_REPORTS_TO' }, HUMAN);
    const err = graphError(() => g.assertDelegationChain(['coder', 'pm']));
    assert.equal(err.code, 'DELEGATION_NOT_GRANTED');
    // Cycle.
    g.addEdge({ ...edgeBase('coder', 'pm'), relationship_type: 'CAN_DELEGATE_TO' }, HUMAN);
    const cyc = graphError(() => g.assertDelegationChain(['pm', 'coder', 'pm']));
    assert.equal(cyc.code, 'DELEGATION_CYCLE');
    // Depth.
    const deep = new OrgGraphV2({ maxDelegationDepth: 1 });
    const deepErr = graphError(() => deep.assertDelegationChain(['a', 'b', 'c']));
    assert.equal(deepErr.code, 'DELEGATION_DEPTH_EXCEEDED');
  });

  it('report propagation dedups and hop-limits (no storm on cycles)', () => {
    const g = new OrgGraphV2({ maxReportHops: 3 });
    for (const id of ['a', 'b', 'c']) g.addNode(node(id, 'AI_EMPLOYEE'), HUMAN);
    // Lateral cycle a→b→c→a must not loop forever.
    g.addEdge({ ...edgeBase('a', 'b'), relationship_type: 'ESCALATES_TO' }, HUMAN);
    g.addEdge({ ...edgeBase('b', 'c'), relationship_type: 'ESCALATES_TO' }, HUMAN);
    g.addEdge({ ...edgeBase('c', 'a'), relationship_type: 'ESCALATES_TO' }, HUMAN);
    const { deliveredTo, hops } = g.propagateReport('origin-1', 'a');
    assert.ok(hops <= 3, `hops bounded, got ${hops}`);
    assert.equal(new Set(deliveredTo).size, deliveredTo.length, 'no duplicate deliveries');
  });
});

describe('versioned transactional change (§9.4)', () => {
  it('commits atomically and bumps the graph version', () => {
    const g = graphWithTeam();
    const v0 = g.version;
    const res = g.applyChange(
      [
        { op: 'addNode', node: node('qa', 'AI_EMPLOYEE') },
        { op: 'addEdge', edge: { ...edgeBase('qa', 'pm'), relationship_type: 'PRIMARY_REPORTS_TO' } },
      ],
      HUMAN,
    );
    assert.equal(res.graphVersion, v0 + 1);
    assert.equal(g.primaryManager('qa')!.id, 'pm');
  });

  it('rolls back the whole change when any op is invalid', () => {
    const g = graphWithTeam();
    const v0 = g.version;
    graphError(() =>
      g.applyChange(
        [
          { op: 'addNode', node: node('qa', 'AI_EMPLOYEE') },
          // coder already has pm — second primary manager is invalid.
          { op: 'addEdge', edge: { ...edgeBase('coder', 'qa'), relationship_type: 'PRIMARY_REPORTS_TO' } },
        ],
        HUMAN,
      ),
    );
    assert.equal(g.version, v0, 'version unchanged');
    assert.equal(g.getNode('qa'), undefined, 'partial node not committed');
  });

  it('moving a member drops old authorizations (no silent carry-over)', () => {
    const g = graphWithTeam();
    g.addNode(node('pm2', 'AI_EMPLOYEE'), HUMAN);
    g.addEdge({ ...edgeBase('pm2', 'owner'), relationship_type: 'PRIMARY_REPORTS_TO' }, HUMAN);
    const res = g.applyChange(
      [{ op: 'addEdge', edge: { ...edgeBase('coder', 'pm2'), relationship_type: 'PRIMARY_REPORTS_TO' } }],
      HUMAN,
    );
    assert.equal(g.primaryManager('coder')!.id, 'pm2');
    assert.ok(res.authorizationsDropped.length > 0, 'old edge recorded as dropped');
  });

  it('retire uses a tombstone; history still resolves', () => {
    const g = graphWithTeam();
    const v0 = g.version;
    g.retireNode('coder', HUMAN);
    assert.equal(g.getNode('coder')!.tombstone, true);
    const snap = g.resolveAt(v0);
    assert.ok(snap.nodes.some((n) => n.id === 'coder' && !n.tombstone));
  });
});

describe('protected relationships (§9.1)', () => {
  it('AI cannot modify a human identity or superior', () => {
    const g = graphWithTeam();
    const err = graphError(() =>
      g.updateNode('owner', { identity: { name: 'Mallory' } }, AI),
    );
    assert.equal(err.code, 'PROTECTED_RELATIONSHIP');
    // A human actor may.
    const updated = g.updateNode('owner', { identity: { name: 'Tan' } }, HUMAN);
    assert.equal(updated.identity!.name, 'Tan');
  });

  it('AI may still update non-protected fields of AI employees', () => {
    const g = graphWithTeam();
    const updated = g.updateNode('coder', { displayName: 'Coder v2' }, AI);
    assert.equal(updated.displayName, 'Coder v2');
  });
});
