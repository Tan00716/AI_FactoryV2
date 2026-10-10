/**
 * Confinement fail-closed demo — SPEC v2 §7.5.
 *
 *  1. UnverifiedBackend → autonomous shell attempt → CONFINEMENT_UNAVAILABLE
 *     refusal (no silent downgrade to host permissions).
 *  2. LocalDevBackend best-effort report printed with honest limitations.
 *  3. Read-only analysis stays allowed even when autonomous shell is closed.
 *
 * Run after building the package:
 *   npx tsc -p packages/security/tsconfig.json
 *   node packages/security/dist/demo/confinement.demo.js
 */
import { tmpdir } from 'os';
import {
  ConfinementUnavailableError,
  LocalDevBackend,
  UnverifiedBackend,
  assertConfinementForAutonomousShell,
  createWorkspaceRecord,
  resolveSafePath,
} from '../src/index';

function attemptAutonomousShell(label: string, backend: { name: string } & Parameters<typeof assertConfinementForAutonomousShell>[0]) {
  try {
    assertConfinementForAutonomousShell(backend);
    console.log(`[ALLOW] ${label}: confinement verified — autonomous shell permitted`);
  } catch (err) {
    if (err instanceof ConfinementUnavailableError) {
      console.log(`[REFUSE] ${label}: ${err.code} — ${err.message}`);
    } else {
      throw err;
    }
  }
}

console.log('--- 1. unverified backend → fail closed ---');
attemptAutonomousShell('unverified host', new UnverifiedBackend());

console.log('\n--- 2. local-dev best-effort report (honest limitations) ---');
const local = new LocalDevBackend({ workspaceRoot: tmpdir() });
const report = local.verifyConfinement();
console.log(`verified: ${report.verified}`);
for (const c of report.checks) console.log(`  check ${c.name}: ${c.passed ? 'pass' : 'FAIL'} — ${c.detail}`);
console.log('  limitations:');
for (const l of report.limitations) console.log(`   - ${l}`);
attemptAutonomousShell('local dev box', local);

console.log('\n--- 3. read-only analysis still allowed while shell is closed ---');
const rec = createWorkspaceRecord({
  id: 'demo-ws',
  authorized_roots: [tmpdir()],
  owner: 'human:tan',
  backend: new UnverifiedBackend(),
});
console.log(`workspace ${rec.id}: backend=${rec.isolation_backend}, verified_at=${rec.confinement_verified_at}`);
const readPath = resolveSafePath(rec.authorized_roots[0], 'README.md');
console.log(`[ALLOW] read-only resolve inside root: ${readPath}`);
console.log('done.');
