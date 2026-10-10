/**
 * Incidents demo — SPEC v2 §42 end to end.
 *
 *  1. Monitor detects a P0 (error-rate spike) → incident DETECTED.
 *  2. Triage → investigate → mitigate via a PRE-AUTHORIZED runbook
 *     (auto-mitigation allowed); a non-preauthorized runbook is refused.
 *  3. Recovery evidence attached → RESOLVED.
 *  4. Attempt to "resolve" by raising the alert threshold → refused.
 *  5. Postmortem (root cause + follow-ups) → POSTMORTEM → CLOSED.
 *  6. Emergency-stop-by-untrusted-tool → isolated recovery path required.
 *
 * Run: npm run build -w @ai-factory/incidents && node packages/incidents/dist/demo/incidents.demo.js
 */
import {
  IncidentManager,
  Runbook,
  ThresholdGamingRefusedError,
} from '../src/index';

const now = Date.now();
const mgr = new IncidentManager({ now: () => now });

const RESTART_WEB: Runbook = {
  id: 'rb-restart-web',
  name: 'restart-web-service',
  trigger: 'error_rate > 5% for 2m',
  falsePositiveChecks: ['deploy in progress?', 'canary stage active?'],
  allowedEnvs: ['PROD'],
  allowedTools: ['deploy-broker'],
  allowedActions: ['restart-service'],
  maxBlastRadius: 'single service',
  budgetUnits: 10,
  approvalConditions: [],
  recoveryStopPoints: ['service healthy for 5m'],
  verification: ['smoke test green'],
  notifications: ['#incidents'],
  preauthorized: true,
  version: 3,
};

const DB_FAILOVER: Runbook = {
  id: 'rb-db-failover',
  name: 'db-failover',
  trigger: 'primary db unreachable',
  falsePositiveChecks: ['network partition?'],
  allowedEnvs: ['PROD'],
  allowedTools: ['db-broker'],
  allowedActions: ['promote-replica'],
  maxBlastRadius: 'database cluster',
  budgetUnits: 50,
  approvalConditions: ['human DBA ack'],
  recoveryStopPoints: ['replica lag < 1s'],
  verification: ['write probe'],
  notifications: ['#incidents', '#data'],
  preauthorized: false,
  version: 1,
};

mgr.registerRunbook(RESTART_WEB);
mgr.registerRunbook(DB_FAILOVER);

// 1. detection
const inc = mgr.create({ title: 'PROD error-rate spike (web)', severity: 'P0', detectedBy: 'monitor' });
console.log('1. detected:', inc.id, inc.status);

// 2. triage → investigate → mitigate (pre-authorized runbook → auto-mitigation OK)
for (const s of ['TRIAGED', 'INVESTIGATING', 'MITIGATING'] as const) mgr.transition(inc.id, s, 'responder');
console.log('2. auto-mitigate with pre-authorized runbook:', mgr.canAutoMitigate('rb-restart-web', true));
console.log('   non-preauthorized runbook auto-mitigate:', mgr.canAutoMitigate('rb-db-failover', true));

// 3. recovering → recovery evidence → resolved
mgr.transition(inc.id, 'RECOVERING', 'responder');
mgr.addRecoveryEvidence(inc.id, 'ev:smoke-green-after-restart', 'responder');
mgr.transition(inc.id, 'RESOLVED', 'responder');
console.log('3. resolved with recovery evidence');

// 4. threshold gaming refused
try {
  mgr.setResolutionBasis(inc.id, 'raised alert threshold from 5% to 50%', 'responder');
  console.log('4. ERROR: threshold gaming was allowed!');
} catch (err) {
  console.log('4. threshold gaming refused:', err instanceof ThresholdGamingRefusedError);
}

// 5. postmortem → closed
mgr.setPostmortem(inc.id, { rootCause: 'bad config push', followUp: ['config canary', 'alert on config drift'] }, 'responder');
mgr.transition(inc.id, 'POSTMORTEM', 'responder');
mgr.transition(inc.id, 'CLOSED', 'responder');
console.log('5. closed:', mgr.get(inc.id).status);

// 6. untrusted-tool emergency stop → isolated recovery
const plan = mgr.planRecovery({ incidentId: inc.id, triggeredByUntrustedTool: true });
console.log('6. isolated recovery path required:', plan.isolatedPathRequired);
console.log('demo complete');
