/**
 * Evidence contract v2 demo — SPEC_V2 §39.
 *
 *  1. Eighteen-field evidence contract: create + validate.
 *  2. STALE by append: requirement change appends an invalidation record;
 *     the original record is NOT rewritten, but its effective validity is STALE.
 *     Re-execution creates a new record with lineage.
 *  3. AI cannot write a Gate Verdict: assertGateEvaluator rejects AI callers.
 *  4. DISPUTED escalation: coder/reviewer disagreement → DISPUTED + ESCALATED;
 *     majority vote is refused; independent reproduction resolves.
 *
 * Run after building the package:
 *   npx tsc -p packages/core/tsconfig.json
 *   node packages/core/dist/demo/evidence-v2.demo.js
 */
import {
  EvidenceV2Engine,
  InMemoryEvidenceV2Store,
  evaluateGateV2,
  raiseDispute,
  resolveDispute,
  resolveDisputeByVote,
  validateEvidenceRecordV2,
  type EvaluatorIdentity,
} from '../src/index';

const SYS: EvaluatorIdentity = { kind: 'SYSTEM', id: 'gate-evaluator' };
const AI: EvaluatorIdentity = { kind: 'AI', id: 'coder-agent-1' };

const store = new InMemoryEvidenceV2Store();
const engine = new EvidenceV2Engine(store);

console.log('--- 1. eighteen-field contract ---');
const rec = engine.create({
  type: 'qa_result',
  requirement_version: 'REQ-001@1',
  ac_refs: ['AC-1', 'AC-2'],
  task_id: 'TASK-1042',
  run_id: 'RUN-8831',
  candidate_revision: 'cand-9f2c',
  test_definition_hash: 'td-77aa',
  environment_fingerprint: 'env-dev-fp-1',
  collector_identity: 'trusted-qa-runner',
  exit_code: 0,
  result_summary: {
    test_kind: 'test-result',
    total: 524, passed: 524, failed: 0, skipped: 0,
    ac_results: [
      { ac_id: 'AC-1', passed: true },
      { ac_id: 'AC-2', passed: true },
    ],
  },
  trust_level: 'TRUSTED_COLLECTOR',
});
console.log('keys:', Object.keys(rec).length, '(= 18 contract fields; task/run and started/ended_at are split keys)');
console.log('content_hash:', rec.content_hash.slice(0, 16) + '… (proves bytes, not truth)');
console.log('contract valid:', validateEvidenceRecordV2(rec).ok);

console.log('\n--- 2. STALE by append — original record NOT rewritten ---');
const before = engine.get(rec.evidence_id);
engine.appendInvalidation(rec.evidence_id, 'requirement changed', 'REQ-001@1→@2');
const after = engine.get(rec.evidence_id);
console.log('stored validity_state unchanged:', after.validity_state === before.validity_state);
console.log('stored content_hash unchanged:', after.content_hash === before.content_hash);
console.log('effective validity now:', engine.effectiveValidity(rec.evidence_id));
const re = engine.reExecute(rec.evidence_id, {
  type: 'qa_result',
  requirement_version: 'REQ-001@2',
  ac_refs: ['AC-1', 'AC-2'],
  task_id: 'TASK-1042',
  run_id: 'RUN-8832',
  candidate_revision: 'cand-9f2c',
  test_definition_hash: 'td-77aa',
  environment_fingerprint: 'env-dev-fp-1',
  collector_identity: 'trusted-qa-runner',
  exit_code: 0,
  result_summary: {
    test_kind: 'test-result',
    total: 524, passed: 524, failed: 0, skipped: 0,
    ac_results: [
      { ac_id: 'AC-1', passed: true },
      { ac_id: 'AC-2', passed: true },
    ],
  },
  trust_level: 'TRUSTED_COLLECTOR',
});
console.log('re-executed lineage:', re.lineage, '| effective:', engine.effectiveValidity(re.evidence_id));

console.log('\n--- 3. AI cannot write a Gate Verdict ---');
const gate = {
  gate_id: 'GATE-QA', mandatory_ac_ids: ['AC-1'], max_failed: 0, max_skipped: 0,
  require_independent_review: false, max_finding_severity: 'LOW' as const, freshness_ms: null,
};
try {
  evaluateGateV2(gate, [re], new Map([[re.evidence_id, engine.listInvalidations(re.evidence_id)]]), AI, Date.now());
  console.log('ERROR: AI verdict was accepted');
} catch (err) {
  console.log('AI verdict rejected:', (err as Error).name);
}
const ok = evaluateGateV2(gate, [re], new Map([[re.evidence_id, engine.listInvalidations(re.evidence_id)]]), SYS, Date.now());
console.log('deterministic evaluator verdict:', ok.verdict);

console.log('\n--- 4. DISPUTED escalation — votes never win ---');
const dispute = raiseDispute({
  gate_id: 'GATE-QA',
  raised_by: 'coder-agent-1',
  summary: 'QA failed on AC-2; coder claims the test environment was dirty',
  positions: [
    { party: 'coder-agent-1', claim: 'environment was dirty, failure is not real' },
    { party: 'qa-agent-2', claim: 'failure reproduces on a clean image' },
  ],
});
console.log('dispute:', dispute.gate_verdict, '| escalated:', dispute.escalated);
try {
  resolveDisputeByVote();
} catch (err) {
  console.log('vote resolution refused:', (err as Error).name);
}
const repro = engine.create({
  type: 'qa_result',
  requirement_version: 'REQ-001@2',
  ac_refs: ['AC-2'],
  task_id: 'TASK-1042',
  run_id: 'RUN-8833',
  candidate_revision: 'cand-9f2c',
  environment_fingerprint: 'env-clean-fp-9',
  collector_identity: 'independent-repro-runner',
  exit_code: 1,
  result_summary: {
    test_kind: 'test-result', total: 40, passed: 39, failed: 1, skipped: 0,
    ac_results: [{ ac_id: 'AC-2', passed: false }],
  },
  trust_level: 'TRUSTED_COLLECTOR',
});
const resolved = resolveDispute(dispute, {
  by: 'qa-lead',
  reproduction_evidence: repro,
  disputing_collectors: ['trusted-qa-runner'],
  outcome: 'UPHELD',
});
console.log('resolved by independent reproduction:', resolved.status, '|', resolved.resolution?.outcome);
