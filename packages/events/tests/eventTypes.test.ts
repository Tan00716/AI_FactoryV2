/** §91 event vocabulary + §32.1 v2 additions tests. */
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

/** The 10 v2 event types added by SPEC_V2 §32.1. */
const SPEC_32_V2 = [
  'AUTHORIZATION',
  'REQUIREMENT_VERSION',
  'DELEGATION_REPORT',
  'CONTROL_EPOCH',
  'LEASE_FENCING',
  'QUOTA_HANDOFF',
  'EVIDENCE_INVALIDATION',
  'TAKEOVER',
  'OUTCOME',
  'COMPLETION_INVALIDATION',
];

describe('EVENT_TYPES', () => {
  it('contains every §91 name, verbatim', () => {
    for (const name of SPEC_91) {
      assert.ok((EVENT_TYPES as readonly string[]).includes(name), `missing §91 type ${name}`);
    }
  });

  it('contains the 10 §32.1 v2 additions', () => {
    for (const name of SPEC_32_V2) {
      assert.ok((EVENT_TYPES as readonly string[]).includes(name), `missing §32.1 type ${name}`);
    }
  });

  it('has 39 types total with no duplicates', () => {
    assert.equal(EVENT_TYPES.length, 39);
    assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  });

  it('isEventType guards the vocabulary', () => {
    assert.equal(isEventType('RUN_STARTED'), true);
    assert.equal(isEventType('QA_COMPLETED'), true);
    assert.equal(isEventType('EVIDENCE_INVALIDATION'), true);
    assert.equal(isEventType('COMPLETION_INVALIDATION'), true);
    assert.equal(isEventType('nope'), false);
    assert.equal(isEventType(42), false);
  });
});
