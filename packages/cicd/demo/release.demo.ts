/**
 * Release Manager demo — spec §40 (Environment Manager), §41 (Production
 * Policy), §77 (Snapshot/Recovery).
 *
 *  1. Create a release (semver validated, changelog draft from commits).
 *  2. Deploy to UAT (ai policy, approval attached) → deployed.
 *  3. Deploy the same release to PROD with no approval → refused (parked).
 *  4. Attach a human approval → PROD deploy succeeds.
 *  5. Next release: deploy to DEV, then simulate a health-check failure →
 *     automatic rollback to the pre-deploy snapshot (§77).
 *
 * Run after building the package:
 *   npm run build -w @ai-factory/cicd
 *   node packages/cicd/dist/demo/release.demo.js
 */
import {
  ApprovalRequiredError,
  ReleaseManager,
  bumpVersion,
  isValidSemver,
  type ManagedEnvironment,
} from '../src/index';

const section = (title: string): void => console.log(`\n=== ${title} ===`);
const step = (n: number, text: string): void => console.log(`\n[step ${n}] ${text}`);

function makeManager(): ReleaseManager {
  return new ReleaseManager({
    audit: (action, detail) =>
      console.log(
        `  📝 audit: ${action} (release ${(detail['releaseId'] as string).slice(0, 8)}, status ${String(detail['status'])})`,
      ),
    deployFn: async (env: ManagedEnvironment) => {
      console.log(`  🚀 ${env.deployMethod} → ${env.name}`);
      return { logs: [`[${env.name}] simulated deploy OK`] };
    },
    healthCheckFn: async (env: ManagedEnvironment) => {
      console.log(
        `  🩺 health check [${env.healthCheck.type}] ${env.healthCheck.target} … OK`,
      );
      return true;
    },
  });
}

async function main(): Promise<void> {
  console.log(
    'Release Manager demo — §40 environments, §41 approval gates, §77 snapshots/rollback',
  );

  const mgr = makeManager();

  section('Environments (§40)');
  for (const env of mgr.listEnvironments()) {
    console.log(
      `  ${env.id}  ${env.name}  policy=${env.approvalPolicy}  secrets=[${env.secretRefs.join(', ') || 'none'}]  health=${env.healthCheck.type}:${env.healthCheck.target}`,
    );
  }
  console.log('  (secretRefs are reference names only — never values)');

  section('Release creation (semver + changelog draft)');
  console.log(`  isValidSemver('1.4.0') → ${isValidSemver('1.4.0')}`);
  console.log(`  bumpVersion('1.4.0','minor') → ${bumpVersion('1.4.0', 'minor')}`);
  const release = mgr.createRelease({
    version: '1.4.0',
    artifacts: ['app-1.4.0.tgz', 'migrations-1.4.0.sql'],
    commits: ['feat: dark mode toggle', 'fix: session race on login'],
    createdBy: 'tan',
  });
  console.log(`  release ${release.id.slice(0, 8)} v${release.version} [${release.status}]`);
  console.log('  changelog draft:');
  for (const line of release.changelog) console.log(`    ${line}`);

  step(1, 'Deploy to UAT (policy: ai — approval attached)');
  const uat = mgr.createRelease({
    version: '1.4.0',
    artifacts: ['app-1.4.0.tgz'],
    environmentId: 'env-uat',
    createdBy: 'tan',
  });
  mgr.addApproval(uat.id, {
    approvalId: 'ai-review-1',
    approver: 'ai-reviewer',
    decision: 'APPROVED',
    decidedAt: new Date().toISOString(),
    level: 'ai',
  });
  const uatOut = await mgr.deployRelease(uat.id);
  console.log(
    `  ✅ UAT deploy → ${uatOut.release.status} (snapshot ${String(uatOut.release.snapshotId).slice(0, 8)})`,
  );

  step(2, 'Deploy to PROD with no approval → refused (policy: human)');
  try {
    await mgr.deployRelease(uat.id, 'env-prod');
    console.log('  ❌ expected an ApprovalRequiredError');
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      console.log(`  ⛔ refused: policy='${err.approvalPolicy}' — ${err.message}`);
      console.log(
        `  release parked at status '${mgr.getRelease(uat.id).status}' (pending_approval)`,
      );
    } else {
      throw err;
    }
  }

  step(3, 'Human approves → PROD deploy succeeds');
  mgr.addApproval(uat.id, {
    approvalId: 'human-approval-1',
    approver: 'tan',
    decision: 'APPROVED',
    decidedAt: new Date().toISOString(),
    level: 'human',
  });
  console.log(`  release status now '${mgr.getRelease(uat.id).status}' (approved)`);
  const prodOut = await mgr.deployRelease(uat.id, 'env-prod');
  console.log(`  ✅ PROD deploy → ${prodOut.release.status}`);

  step(4, 'Health-check failure → automatic rollback (§77)');
  const risky = mgr.createRelease({
    version: bumpVersion('1.4.0', 'patch'),
    artifacts: ['app-1.4.1.tgz'],
    commits: ['fix: null deref in checkout'],
    environmentId: 'env-dev',
    createdBy: 'tan',
  });
  // Inject a failing health check for this one call to exercise auto-rollback.
  const failOut = await mgr.deployRelease(risky.id, undefined, {
    healthCheckFn: async (env: ManagedEnvironment) => {
      console.log(
        `  🩺 health check [${env.healthCheck.type}] ${env.healthCheck.target} … FAILED (500)`,
      );
      return false;
    },
  });
  console.log(`  🔁 deploy → ${failOut.release.status} (${failOut.release.error})`);
  console.log(
    `  pre-deploy snapshot ${String(failOut.release.snapshotId).slice(0, 8)} restored automatically`,
  );

  console.log(
    '\n✅ demo complete: UAT deployed, PROD gated on human approval then deployed, unhealthy deploy rolled back',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
