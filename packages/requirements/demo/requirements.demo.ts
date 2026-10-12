/**
 * Requirements demo — SPEC_V2 §16.
 *
 *  1. Create REQ-001@1 with stable ACs (id/version/verification/evidence).
 *  2. Link plans/tasks/code/tests/evidence/approvals/releases to v1.
 *  3. REQ-001@2 changes an AC → analyzeImpact():
 *     affected entities, STALE approvals, suspended promotions.
 *  4. Old evidence is NOT silently reusable; an explicit compatibility
 *     check reuses one record, the other stays stale.
 *  5. AI PM refines an AC (allowed); adding new behavior is rejected.
 *
 * Run after building the package:
 *   npx tsc -p packages/requirements/tsconfig.json
 *   node packages/requirements/dist/demo/requirements.demo.js
 */
import { RequirementManager } from '../src/index';

function main(): void {
  const m = new RequirementManager();

  const req = m.create({
    id: 'REQ-001',
    businessGoal: 'One-click deploy to UAT',
    rationale: 'Manual deploys cause 40% of UAT delays',
    acceptanceCriteria: [
      {
        id: 'AC-001', description: 'Deploy completes without manual steps',
        verificationType: 'AUTOMATED_TEST', verifiedBy: 'INDEPENDENT_QA',
        expectedEvidence: 'ci_result with verdict PASS', applicableEnvironments: ['uat'],
      },
      {
        id: 'AC-002', description: 'Rollback available within 5 minutes',
        verificationType: 'MANUAL_VERIFICATION', verifiedBy: 'HUMAN_OWNER',
        expectedEvidence: 'rollback drill record', applicableEnvironments: ['uat'],
      },
    ],
    exclusions: ['production deploy'],
    outcomeMeasurement: 'UAT deploy lead time < 10 min',
    createdBy: 'human-1',
  });
  console.log(`created ${req.id}@1, target=${req.versions[0].completionTarget}`);
  console.log(`ACs: ${req.versions[0].acceptanceCriteria.map((a) => `${a.id}@v${a.version}`).join(', ')}`);

  m.linkEntities('REQ-001', 1, {
    planIds: ['plan-7'], taskIds: ['task-7', 'task-8'],
    codeRefs: ['sha256:deadbeef'], testIds: ['test-deploy'],
    evidenceIds: ['ev-ci-1', 'ev-drill-1'], approvalIds: ['appr-7'], releaseIds: [],
  });

  // v2: a HUMAN-authorized scope change edits AC-002's meaning. Since
  // Batch 4 (§16 G-02) the data layer requires the recorded HUMAN
  // authorization for AC-meaning changes — an AI caller doing the same
  // mutation without it would be rejected.
  m.newVersion('REQ-001', 'SCOPE_CHANGE', 'AC-002: drill must cover DB rollback', 'human-1', (d) => {
    d.acceptanceCriteria.find((a) => a.id === 'AC-002')!.description =
      'Rollback incl. DB available within 5 minutes';
  }, {
    humanAuthorization: { authorizedBy: 'human-1', isHuman: true, reason: 'owner-approved scope change' },
  });
  console.log('\nREQ-001@2 created; @1 record untouched:',
    m.getVersion('REQ-001', 1).acceptanceCriteria[1].description);

  const impact = m.analyzeImpact('REQ-001', 1, 2, 'ai-pm-1');
  console.log('\n--- impact analysis REQ-001@1 → @2 ---');
  console.log('acChanged:', impact.acChanged.join(', '));
  console.log('affected tasks:', impact.affected.taskIds.join(', '));
  console.log('staleApprovals:', impact.staleApprovals.join(', '));
  console.log('suspendedPromotions:', impact.suspendedPromotions.length, '(promotion held until re-validation)');
  console.log('evidenceStale (must NOT be silently reused):', impact.evidenceStale.join(', '));

  // Explicit compatibility: ev-ci-1 unaffected by the AC-002 change → reusable.
  m.checkEvidenceCompatibility('ev-ci-1', 'REQ-001', 2, true,
    'AC-001 unchanged between v1 and v2', 'qa-lead');
  console.log('\nev-ci-1 reusable after explicit check:', m.canReuseEvidence('ev-ci-1', 'REQ-001', 2));
  console.log('ev-drill-1 reusable without check:', m.canReuseEvidence('ev-drill-1', 'REQ-001', 2));

  // Release one hold with a revalidation note.
  m.releaseHold(impact.suspendedPromotions[0].id, 'human-1', 're-planned against REQ-001@2');
  console.log('hold released with revalidation note:',
    m.listHolds('task-7')[0].releasedBy);

  // AI PM refinement: clarification allowed…
  const v3 = m.proposeAcRefinement('REQ-001', 'AC-001',
    { description: 'Deploy completes with zero manual steps (incl. secrets)' }, 'ai-pm-1');
  console.log('\nAC-001 refined → requirement v' + v3.version + ', AC version now',
    v3.acceptanceCriteria[0].version);

  // …but new product behavior is rejected.
  try {
    m.proposeAcRefinement('REQ-001', 'AC-001', { addsNewBehavior: true }, 'ai-pm-1');
    console.log('ERROR: should have been rejected');
  } catch (err) {
    console.log('new-behavior "refinement" rejected:', (err as Error).message.slice(0, 80) + '…');
  }

  console.log('\ndemo complete.');
}

main();
