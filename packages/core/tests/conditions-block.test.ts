/**
 * §21.4 block conditions (G-36): BUDGET_BLOCK / RESOURCE_BLOCK are real
 * TaskConditionValue members the v2 engine accepts via setCondition, so
 * a budget/resource overrun can put the affected task into a block
 * condition instead of surfacing only as a thrown error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditLog,
  BLOCK_CONDITIONS,
  TaskConditionValue,
  WorkflowEngineV2,
} from '../src/index';

function engine() {
  return new WorkflowEngineV2({ audit: new AuditLog(), now: () => 1700000000000 });
}

describe('§21.4 block conditions (G-36)', () => {
  it('BLOCK_CONDITIONS is exactly the §21.4 pair', () => {
    assert.deepEqual([...BLOCK_CONDITIONS], ['BUDGET_BLOCK', 'RESOURCE_BLOCK']);
  });

  it('the engine accepts BUDGET_BLOCK and RESOURCE_BLOCK as task conditions', () => {
    const e = engine();
    e.register('t-1');
    e.setCondition('t-1', 'BUDGET_BLOCK', 'token budget exhausted', 'budget-tracker');
    assert.equal(e.get('t-1').condition.condition, 'BUDGET_BLOCK');

    e.register('t-2');
    e.setCondition('t-2', 'RESOURCE_BLOCK', 'process capacity exhausted', 'budget-tracker');
    assert.equal(e.get('t-2').condition.condition, 'RESOURCE_BLOCK');
  });

  it('a blocked task can return to ACTIVE when the limit clears', () => {
    const e = engine();
    e.register('t-1');
    e.setCondition('t-1', 'BUDGET_BLOCK', 'money budget exhausted', 'budget-tracker');
    e.setCondition('t-1', 'ACTIVE', 'budget increase approved', 'human');
    assert.equal(e.get('t-1').condition.condition, 'ACTIVE');
  });

  it('the pair type-checks as TaskConditionValue literals', () => {
    const values: TaskConditionValue[] = ['BUDGET_BLOCK', 'RESOURCE_BLOCK'];
    assert.equal(values.length, 2);
  });
});
