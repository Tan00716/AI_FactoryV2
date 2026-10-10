/**
 * Demo: §49 API contracts — one valid envelope passes; a forged
 * client-submitted actor is overwritten server-side; a malformed envelope is
 * rejected with per-field issues.
 *
 * Run: node packages/api-contracts/dist/demo/contracts.demo.js
 */
import {
  applyServerActor,
  reason,
  validateCommandEnvelope,
  validateTransitionRequest,
} from '../src/index';

const payload = {
  task: { id: 'task-42', version: 5 },
  requirement: { id: 'req-9', version: 2 },
  from: 'IN_PROGRESS',
  to: 'CODE_REVIEW',
  candidateDigest: 'sha256:candidate-77',
  evidenceManifestRef: { id: 'manifest-77', version: 1 },
  approvalRefs: [],
};

console.log('== 1. valid envelope passes ==');
const good = {
  schemaVersion: '2.0',
  requestId: 'req-2026-001',
  idempotencyKey: 'idem-abc-123',
  organizationId: 'org-acme',
  actor: { id: 'agent-7', type: 'AI' },
  payload,
};
const r1 = validateCommandEnvelope(good, validateTransitionRequest);
console.log('  ok:', r1.ok);

console.log('== 2. forged actor gains nothing ==');
const forged = {
  ...good,
  actor: { id: 'mallory', type: 'HUMAN' }, // client claims to be HUMAN
};
const r2 = validateCommandEnvelope(forged, validateTransitionRequest);
console.log('  shape ok (actor shape is valid):', r2.ok);
if (r2.ok) {
  // The server derives identity from the authenticated session:
  const serverSide = applyServerActor(r2.value, { id: 'agent-7', type: 'AI' });
  console.log('  actor after server derivation:', JSON.stringify(serverSide.actor));
  console.log('  denial body example:', JSON.stringify(reason('UNAUTHORIZED')));
}

console.log('== 3. malformed envelope rejected with issues ==');
const bad = {
  schemaVersion: '2.0',
  requestId: '', // empty
  idempotencyKey: 'idem-abc-123',
  // organizationId missing
  actor: { id: 'agent-7', type: 'AI' },
  payload: { ...payload, to: '' }, // empty target state
};
const r3 = validateCommandEnvelope(bad, validateTransitionRequest);
console.log('  ok:', r3.ok);
if (!r3.ok) {
  for (const issue of r3.issues) {
    console.log(`  - ${issue.path}: ${issue.message}`);
  }
}

console.log('\ndone.');
