// P0 security probes — v2 round. Adversarial spot-checks at API level.
// Complements (does not replace) the 1470 unit tests.
const { resolveSafePath } = require('/home/hatch/workspace/ai-factory/packages/security/dist/src/index.js');
const { SecretRef, redactSecrets, createRedactingAudit } = require('/home/hatch/workspace/ai-factory/packages/security/dist/src/index.js');
const { ApprovalManager, ApprovalBlockedError, ApprovalDeciderNotAuthorizedError, ApprovalNotPendingError } = require('/home/hatch/workspace/ai-factory/packages/approvals/dist/src/index.js');
const { EvidenceEngine } = require('/home/hatch/workspace/ai-factory/packages/core/dist/src/index.js');
const { checkTransitionV2 } = require('/home/hatch/workspace/ai-factory/packages/core/dist/src/index.js');

const results = [];
function report(id, name, pass, evidence) {
  results.push({ id, name, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}\n    evidence: ${evidence}`);
}

const ROOT = '/home/hatch/workspace/ai-factory/data';

// ---- P1: path traversal ----
{
  const attacks = ['../../etc/passwd', '/etc/passwd', '/tmp/evil', 'subdir/../../../etc/passwd', 'a\u0000b'];
  let rejected = 0; const notes = [];
  for (const a of attacks) {
    try { const r = resolveSafePath(ROOT, a); notes.push(`${a} -> RESOLVED ${r}`); }
    catch (e) { rejected++; notes.push(`${a} -> REJECTED ${e.name || e.message}`); }
  }
  report('P1', 'path traversal', rejected === attacks.length, `${rejected}/${attacks.length} rejected; ${notes.join('; ')}`);
}

// ---- P2: secret canary ----
{
  const canary = 'canary-' + Math.random().toString(36).slice(2);
  const ref = SecretRef.create('db-password');
  const strForm = String(ref);
  const redacted = redactSecrets(`password=${canary}`);
  const leakedInStr = strForm.includes(canary);
  const redactedCanary = !redacted.includes(canary);
  report('P2', 'secret leakage (canary)', !leakedInStr && redactedCanary,
    `SecretRef String() leaks canary: ${leakedInStr} (expected false); redactSecrets hides canary: ${redactedCanary} (expected true)`);
}

// ---- P3: DEF-001 regression (permission bypass) ----
{
  const mgr = new ApprovalManager();
  let blockedRefused = false, rogueRefused = false; const notes = [];
  try {
    mgr.request({ action: 'secret.write', requester: 'agent-1', risk_level: 'LOW' });
    notes.push('request(secret.write) CREATED ticket (BAD)');
  } catch (e) {
    blockedRefused = e instanceof ApprovalBlockedError || /BLOCKED/i.test(e.message);
    notes.push(`request(secret.write) threw ${e.name}: ${e.message.slice(0, 80)}`);
  }
  let ticket = null;
  try {
    ticket = mgr.request({ action: 'deploy.prod', requester: 'agent-1', risk_level: 'CRITICAL', required_approvers: ['human'] });
    notes.push(`request(deploy.prod) created ${ticket.approval_id} (expected: PENDING, human required)`);
  } catch (e) { notes.push(`request(deploy.prod) threw ${e.name} (unexpected)`); }
  if (ticket) {
    try {
      mgr.decide(ticket.approval_id, { approved: true, decided_by: 'rogue-agent' });
      notes.push('decide by rogue-agent SUCCEEDED (BAD)');
    } catch (e) {
      rogueRefused = e instanceof ApprovalDeciderNotAuthorizedError || /does not satisfy/i.test(e.message);
      notes.push(`decide by rogue-agent threw ${e.name}`);
    }
  }
  report('P3', 'DEF-001 permission bypass (regression)', blockedRefused && rogueRefused, notes.join('; '));
}

// ---- P4: evidence tampering (SEALED) ----
{
  const eng = new EvidenceEngine();
  const rec = eng.create({ title: 'probe', payload: { a: 1 } });
  const sealed = eng.seal(rec.id);
  const shaBefore = sealed.sha256;
  let updateBlocked = false, deleteBlocked = false;
  try { eng.update(rec.id, { title: 'tampered' }); } catch (e) { updateBlocked = /Sealed/i.test(e.name || e.message); }
  try { eng.delete(rec.id); } catch (e) { deleteBlocked = /Sealed/i.test(e.name || e.message); }
  const shaAfter = eng.get(rec.id).sha256;
  report('P4', 'evidence tampering (SEALED)', updateBlocked && deleteBlocked && shaBefore === shaAfter,
    `update blocked=${updateBlocked}, delete blocked=${deleteBlocked}, sha identical=${shaBefore === shaAfter}`);
}

// ---- P5: workflow gate bypass ----
{
  const base = { taskId: 't1', taskVersion: 1, actor: 'agent', requirementVersion: 'REQ-1@1', candidateDigest: 'd1', implementerId: null, evidence: [], evidenceReqVersions: {}, staleEvidenceIds: [], budgetOk: true, quotaOk: true, confinementOk: true, dependenciesReady: true };
  const jump = checkTransitionV2('TODO', 'DONE', base);
  const qaNoEv = checkTransitionV2('QA', 'PENDING_UAT_MERGE', base);
  const ok = !jump.ok && !qaNoEv.ok;
  report('P5', 'workflow gate bypass', ok,
    `TODO->DONE ok=${jump.ok} (expected false, reason=${jump.reason}); QA->PENDING_UAT_MERGE without evidence ok=${qaNoEv.ok} (expected false)`);
}

// ---- P6: replay / double decision ----
{
  const mgr = new ApprovalManager();
  const t = mgr.request({ action: 'deploy.staging', requester: 'agent-1', risk_level: 'MEDIUM', required_approvers: ['human'] });
  mgr.decide(t.approval_id, { approved: true, decided_by: 'human' });
  let secondRejected = false;
  try { mgr.decide(t.approval_id, { approved: false, decided_by: 'human' }); }
  catch (e) { secondRejected = e instanceof ApprovalNotPendingError; }
  report('P6', 'replay / double decision', secondRejected, `second decide() rejected=${secondRejected} (expected true, ApprovalNotPendingError)`);
}

const passed = results.filter(r => r.pass).length;
console.log(`\n=== SUMMARY ===\n${passed}/${results.length} probes rejected attacks as expected`);
require('fs').writeFileSync('/home/hatch/workspace/ai-factory/test-evidence/v2-round/security-probes.json', JSON.stringify(results, null, 1));
process.exit(passed === results.length ? 0 : 1);
