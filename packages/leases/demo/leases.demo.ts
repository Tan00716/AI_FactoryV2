/**
 * Lease + fencing demo — SPEC v2 §22.3.
 *
 *  run-A holds the workspace lease → run-B takes over (fencing bumps) →
 *  run-A's late write is refused as STALE_OWNER → run-B writes fine.
 *
 * Run after building the package:
 *   npx tsc -p packages/leases/tsconfig.json
 *   node packages/leases/dist/demo/leases.demo.js
 */
import { LeaseManager, StaleOwnerError } from '../src/index';

let t = 1_700_000_000_000;
const mgr = new LeaseManager({ now: () => t });

function write(resource: string, token: number, owner: string, payload: string) {
  try {
    mgr.validate(resource, token);
    console.log(`[WRITE] ${owner}: ${payload}`);
  } catch (err) {
    if (err instanceof StaleOwnerError) {
      console.log(`[REFUSE] ${owner}: ${err.code} — late write rejected`);
    } else {
      throw err;
    }
  }
}

const a = mgr.acquire('ws:project-a', 'run-A', 60_000);
console.log(`run-A acquired lease (generation=${a.generation}, fencing_token=${a.fencing_token})`);
write('ws:project-a', a.fencing_token, 'run-A', 'initial implementation');

console.log('--- run-B takes over (worker recovery) ---');
const b = mgr.reassign('ws:project-a', 'run-B', 60_000);
console.log(`run-B now owns generation=${b.generation}, fencing_token=${b.fencing_token}`);

console.log('--- run-A finishes late and tries to write ---');
write('ws:project-a', a.fencing_token, 'run-A', 'stale completion');

console.log('--- run-B writes with the current token ---');
write('ws:project-a', b.fencing_token, 'run-B', 'continued work');
console.log('done.');
