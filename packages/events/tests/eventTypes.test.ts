/** §91 event vocabulary tests. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, isEventType } from '../src/index.js';

/** The 29 names enumerated in the §91 block of AI_factory.txt (verified by script). */
const SPEC_91 = [
  'PROJECT_CREATED', 'TASK_CREATED', 'TASK_STARTED', 'TASK_ASSIGNED',
  'AGENT_CREATED', 'AGENT_UPDATED', 'AGENT_ARCHIVED',
  'RUN_STARTED', 'RUN_STEP', 'TOOL_CALLED', 'ARTIFACT_CREATED',
  'PR_CREATED', 'REVIEW_COMPLETED', 'CI_COMPLETED', 'QA_COMPLETED',
  'DEPLOYMENT_STARTED', 'DEPLOYMENT_COMPLETED',
  'GATE_PASSED', 'GATE_FAILED', 'WORKFLOW_TRANSITIONED',
  'ERROR', 'BLOCKED', 'ESCALATED',
  'ROLLBACK_STARTED', 'ROLLBACK_COMPLETED', 'TASK_COMPLETED',
  'KNOWLEDGE_UPDATED', 'SKILL_UPDATED', 'MCP_UPDATED',
];

describe('EVENT_TYPES', () => {
  it('contains every §91 name, verbatim, with no extras', () => {
    assert.deepEqual([...EVENT_TYPES].sort(), [...SPEC_91].sort());
  });

  it('has no duplicates', () => {
    assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  });

  it('isEventType guards the vocabulary', () => {
    assert.equal(isEventType('RUN_STARTED'), true);
    assert.equal(isEventType('QA_COMPLETED'), true);
    assert.equal(isEventType('nope'), false);
    assert.equal(isEventType(42), false);
  });
});
