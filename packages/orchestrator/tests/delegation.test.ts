/**
 * Tests for the Delegation record — spec §12.2.
 *
 * Hard rules under test:
 *  1. scope must be a subset of the parent scope (superset → SCOPE_VIOLATION)
 *  2. budget_reservation is reserved from the parent's remaining budget,
 *     never a copy of the total (over-reserve → BUDGET_EXCEEDED)
 *  3. delegation chain is acyclic and depth-limited (cycle → CYCLE_VIOLATION,
 *     over-depth → DEPTH_EXCEEDED)
 *  4. the delegator keeps supervision after delegating; owner changes only
 *     on handoff, and only the owner may hand off
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DelegationError,
  DelegationManager,
  isSubset,
  type CreateDelegationInput,
} from '../src/index';

function rootInput(overrides: Partial<CreateDelegationInput> = {}): CreateDelegationInput {
  return {
    delegation_id: 'dlg-root',
    delegator: 'mgr-pm',
    delegatee: 'mgr-lead',
    root_authorization_id: 'auth-001',
    task_id: 'task-crm-bug',
    requirement_version: 'REQ-001@1',
    scope: ['project:crm', 'path:/workspace/crm', 'tool:shell.exec'],
    AC_refs: ['AC-1', 'AC-2'],
    allowed_outputs: ['diff', 'test-report'],
    evidence_requirements: ['unit-tests', 'diff'],
    capability_ceiling: ['project:crm', 'path:/workspace/crm', 'tool:shell.exec'],
    budget_reservation: 1000,
    reporting_targets: ['mgr-pm'],
    review_policy: 'independent-qa',
    ...overrides,
  };
}

let childSeq = 0;
function childInput(parentId: string, overrides: Partial<CreateDelegationInput> = {}): CreateDelegationInput {
  childSeq += 1;
  return {
    delegation_id: `dlg-child-${childSeq}`,
    parent_delegation_id: parentId,
    delegator: 'mgr-lead',
    delegatee: 'coder-1',
    root_authorization_id: 'auth-001',
    task_id: 'task-crm-bug',
    requirement_version: 'REQ-001@1',
    scope: ['project:crm', 'path:/workspace/crm'],
    AC_refs: ['AC-1'],
    allowed_outputs: ['diff'],
    evidence_requirements: ['unit-tests'],
    budget_reservation: 400,
    reporting_targets: ['mgr-lead'],
    review_policy: 'manager-review',
    ...overrides,
  };
}

function activeManager(): DelegationManager {
  const m = new DelegationManager({ clock: { now: () => 1_700_000_000_000 } });
  m.activate(m.createRoot(rootInput()).delegation_id);
  return m;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DelegationError, `expected DelegationError, got ${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected DelegationError with code ${code}, but no error was thrown`);
}

describe('Delegation — §12.2 record fields', () => {
  it('carries all 17 mandated fields plus oversight/owner bookkeeping', () => {
    const m = activeManager();
    const d = m.get('dlg-root');
    for (const f of [
      'delegation_id', 'parent_delegation_id', 'delegator', 'delegatee',
      'root_authorization_id', 'task_id', 'requirement_version', 'scope',
      'AC_refs', 'allowed_outputs', 'evidence_requirements',
      'capability_ceiling', 'budget_reservation', 'due_at',
      'reporting_targets', 'review_policy', 'status', 'version',
    ] as const) {
      assert.ok(f in d, `missing field ${f}`);
    }
    assert.equal(d.parent_delegation_id, null);
    assert.equal(d.status, 'ACTIVE');
    assert.equal(d.version, 2); // created (v1) + activated (v2)
  });
});

describe('scope subset rule (§12.2)', () => {
  it('accepts a child whose scope is a subset of the parent scope', () => {
    const m = activeManager();
    const c = m.create(childInput('dlg-root', { delegation_id: 'dlg-c1' }));
    assert.deepEqual(c.scope, ['project:crm', 'path:/workspace/crm']);
    assert.equal(c.parent_delegation_id, 'dlg-root');
  });

  it('rejects a child scope that is a superset with SCOPE_VIOLATION', () => {
    const m = activeManager();
    expectCode(
      () =>
        m.create(
          childInput('dlg-root', {
            delegation_id: 'dlg-c2',
            scope: ['project:crm', 'path:/workspace/crm', 'path:/etc/secrets'],
          }),
        ),
      'SCOPE_VIOLATION',
    );
  });

  it('isSubset is a pure set check', () => {
    assert.equal(isSubset(['a'], ['a', 'b']), true);
    assert.equal(isSubset(['a', 'c'], ['a', 'b']), false);
    assert.equal(isSubset([], ['a']), true);
  });
});

describe('budget reservation rule (§12.2: 预算从父任务预留)', () => {
  it('reserves from the parent remaining budget, not a copy of the total', () => {
    const m = activeManager();
    m.create(childInput('dlg-root', { delegation_id: 'dlg-c1', budget_reservation: 400 }));
    // Root had 1000; 400 is reserved by c1, so 600 remains for others.
    assert.equal(m.remainingBudget('dlg-root'), 600);
  });

  it('rejects over-reservation with BUDGET_EXCEEDED', () => {
    const m = activeManager();
    expectCode(
      () => m.create(childInput('dlg-root', { delegation_id: 'dlg-c1', budget_reservation: 1200 })),
      'BUDGET_EXCEEDED',
    );
  });

  it('sibling reservations accumulate against the same parent budget', () => {
    const m = activeManager();
    m.create(childInput('dlg-root', { delegation_id: 'dlg-c1', budget_reservation: 600 }));
    // 400 remains; a 500 reservation must fail even though it is < total 1000.
    expectCode(
      () => m.create(childInput('dlg-root', { delegation_id: 'dlg-c2', budget_reservation: 500 })),
      'BUDGET_EXCEEDED',
    );
    m.create(childInput('dlg-root', { delegation_id: 'dlg-c2', budget_reservation: 400 }));
    assert.equal(m.remainingBudget('dlg-root'), 0);
  });

  it('a grandchild reserves from its parent, not the root total', () => {
    const m = activeManager();
    m.activate(m.create(childInput('dlg-root', { delegation_id: 'dlg-c1', budget_reservation: 400 })).delegation_id);
    // c1 has 400; grandchild may take at most 400.
    m.create(childInput('dlg-c1', { delegation_id: 'dlg-g1', budget_reservation: 400 }));
    assert.equal(m.remainingBudget('dlg-c1'), 0);
    assert.equal(m.remainingBudget('dlg-root'), 600);
  });
});

describe('chain depth and acyclicity (§12.2/§12.3)', () => {
  it('rejects delegations deeper than the limit with DEPTH_EXCEEDED', () => {
    const m = new DelegationManager({ maxDepth: 3, clock: { now: () => 1 } });
    m.activate(m.createRoot(rootInput({ delegation_id: 'r' })).delegation_id);
    m.activate(m.create(childInput('r', { delegation_id: 'c1', budget_reservation: 100 })).delegation_id);
    m.activate(m.create(childInput('c1', { delegation_id: 'c2', budget_reservation: 50 })).delegation_id);
    // depth would be 4 > 3
    expectCode(
      () => m.create(childInput('c2', { delegation_id: 'c3', budget_reservation: 10 })),
      'DEPTH_EXCEEDED',
    );
  });

  it('rejects a cycle via reparent with CYCLE_VIOLATION', () => {
    const m = activeManager();
    m.activate(m.create(childInput('dlg-root', { delegation_id: 'dlg-c1', budget_reservation: 100 })).delegation_id);
    m.activate(m.create(childInput('dlg-c1', { delegation_id: 'dlg-g1', budget_reservation: 50 })).delegation_id);
    // Move the root under its own grandchild → cycle.
    expectCode(() => m.reparent('dlg-root', 'dlg-g1'), 'CYCLE_VIOLATION');
    // Self-parent is also a cycle.
    expectCode(() => m.reparent('dlg-c1', 'dlg-c1'), 'CYCLE_VIOLATION');
  });

  it('reparent succeeds when the new parent satisfies all constraints', () => {
    const m = activeManager();
    m.activate(m.create(childInput('dlg-root', { delegation_id: 'dlg-c1', budget_reservation: 100 })).delegation_id);
    const c2 = m.activate(m.create(childInput('dlg-root', { delegation_id: 'dlg-c2', budget_reservation: 100 })).delegation_id);
    const moved = m.reparent(c2.delegation_id, 'dlg-c1');
    assert.equal(moved.parent_delegation_id, 'dlg-c1');
    assert.equal(m.depthOf(c2.delegation_id), 3);
  });
});

describe('supervision retention and handoff (§12.2)', () => {
  it('owner stays the delegator before handoff; oversight_by is the delegator', () => {
    const m = activeManager();
    const c = m.create(childInput('dlg-root', { delegation_id: 'dlg-c1' }));
    assert.equal(c.owner, 'mgr-lead');
    assert.equal(c.oversight_by, 'mgr-lead');
    assert.equal(c.handoff_at, null);
  });

  it('only the current owner may hand off', () => {
    const m = activeManager();
    const c = m.activate(m.create(childInput('dlg-root', { delegation_id: 'dlg-c1' })).delegation_id);
    expectCode(() => m.handoff(c.delegation_id, 'someone-else'), 'NOT_OWNER');
  });

  it('handoff moves owner to the delegatee; oversight stays with the delegator', () => {
    const m = activeManager();
    const c = m.activate(m.create(childInput('dlg-root', { delegation_id: 'dlg-c1' })).delegation_id);
    const after = m.handoff(c.delegation_id, 'mgr-lead');
    assert.equal(after.owner, 'coder-1');
    assert.equal(after.oversight_by, 'mgr-lead');
    assert.ok(after.handoff_at !== null);
  });
});

describe('guard rails', () => {
  it('rejects a child under a non-ACTIVE parent', () => {
    const m = new DelegationManager({ clock: { now: () => 1 } });
    m.createRoot(rootInput({ delegation_id: 'r' })); // stays DRAFT
    expectCode(() => m.create(childInput('r', { delegation_id: 'c' })), 'PARENT_NOT_ACTIVE');
  });

  it('rejects root authorization mismatch', () => {
    const m = activeManager();
    expectCode(
      () =>
        m.create(
          childInput('dlg-root', { delegation_id: 'dlg-cx', root_authorization_id: 'auth-999' }),
        ),
      'ROOT_AUTHORIZATION_MISMATCH',
    );
  });

  it('rejects a capability ceiling wider than the parent', () => {
    const m = activeManager();
    expectCode(
      () =>
        m.create(
          childInput('dlg-root', {
            delegation_id: 'dlg-cc',
            capability_ceiling: ['project:crm', 'path:/workspace/crm', 'tool:db.prod.write'],
          }),
        ),
      'CAPABILITY_VIOLATION',
    );
  });

  it('unknown delegation ids are reported', () => {
    const m = activeManager();
    expectCode(() => m.create(childInput('nope', { delegation_id: 'x' })), 'DELEGATION_NOT_FOUND');
  });
});
