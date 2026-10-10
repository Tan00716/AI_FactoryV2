/**
 * Memory engine v2 demo — SPEC §43 end to end.
 *
 *  1. §43.2 schema: entries carry ACL (accessScope), data classification,
 *     cross-project reuse conditions, confidence kind, and
 *     supersedes/contradicts refs.
 *  2. §43.3 ACL-first retrieve: a requestor without the project's scope
 *     gets NOTHING back (not "hidden in the UI" — never returned).
 *  3. §43.3 contradiction: a contradicting write marks the old ACTIVE
 *     entry CONTRADICTED, lands as PROPOSED, and is resolved by source
 *     authority (human beats manager-claim, not newest/highest score).
 *  4. §43.4 prohibitions: a raw secret write is refused with
 *     SECRET_DETECTED and never lands.
 *  5. §43.3 purge: project deletion synchronously cleans index/cache/
 *     backup references; the registry report proves it.
 *
 * Uses injectable clock + registry so everything is deterministic.
 * Run after building the package:
 *   npx tsc -p packages/memory/tsconfig.json
 *   node packages/memory/dist/demo/memory.demo.js
 */
import {
  MemoryEntry,
  MemoryError,
  MemoryRefRegistry,
  MemoryStore,
  RequestorIdentity,
} from '../src/index';

let now = Date.now();
const registry = new MemoryRefRegistry();
const store = new MemoryStore({ now: () => now, registry });

function show(e: MemoryEntry): string {
  return `  [${e.scope}/${e.scopeId}] ${e.type} "${e.title}" conf=${e.confidence} status=${e.status} acl=[${e.accessScope.join(',')}] class=${e.dataClassification}`;
}

const acme: RequestorIdentity = { id: 'backend-01', scopes: ['project:acme'], clearance: 'internal' };
const beta: RequestorIdentity = { id: 'fe-02', scopes: ['project:beta'], clearance: 'internal' };

console.log('— 1. writes with §43.2 schema fields —');
const sauce = store.write({
  scope: 'project', scopeId: 'acme', type: 'Lesson',
  title: 'Retry payment webhooks with idempotency keys',
  content: 'Duplicate deliveries must not double-charge.',
  source: 'evaluation:task-7', confidence: 0.85, createdBy: 'backend-01',
  evidenceIds: ['ev-7'], dataClassification: 'confidential',
});
console.log(show(sauce));
console.log(`  refs tracked for ${sauce.id}:`, JSON.stringify(registry.refsFor(sauce.id)));

console.log('— 2. §43.3 ACL-first retrieve: unauthorized requestor gets nothing —');
const leaked = store.retrieve({ scope: 'project', scopeId: 'acme' }, beta);
console.log(`  beta requestor sees ${leaked.length} entries (expected 0 — not hidden, never returned)`);
const own = store.retrieve({ scope: 'project' }, acme);
console.log(`  acme requestor (internal clearance) sees ${own.length} entries (expected 0: entry is confidential)`);
const cleared: RequestorIdentity = { ...acme, clearance: 'confidential' };
console.log(`  acme requestor (confidential clearance) sees ${store.retrieve({ scope: 'project' }, cleared).length} entries (expected 1)`);

console.log('— 3. §43.3 contradiction: old → CONTRADICTED, new → PROPOSED, resolve by authority —');
const oldClaim = store.write({
  scope: 'project', scopeId: 'acme', type: 'Decision',
  title: 'Deploy freeze every Friday',
  content: 'No production deploys on Fridays, per the CTO.',
  source: 'human:cto', confidence: 0.9, createdBy: 'human',
});
const newClaim = store.write({
  scope: 'project', scopeId: 'acme', type: 'Decision',
  title: 'Friday deploys allowed with canary',
  content: 'Canary analysis makes Friday deploys safe.',
  source: 'spec', confidence: 0.75, createdBy: 'human',
  contradicts: [oldClaim.id],
});
console.log(`  old: status=${store.get(oldClaim.id)?.status} (expected CONTRADICTED)`);
console.log(`  new: status=${newClaim.status} (expected PROPOSED)`);
const { winnerId } = store.resolveBySourceAuthority([oldClaim.id, newClaim.id], 'human');
console.log(`  authority resolution winner: ${winnerId === oldClaim.id ? 'human:cto (old claim)' : 'spec (new claim)'} — authority beats recency`);

console.log('— 4. §43.4 prohibition: raw secret write refused —');
try {
  store.write({
    scope: 'project', scopeId: 'acme', type: 'Fact',
    title: 'Stripe key for debugging',
    content: 'Use sk_live_abc123XYZ4567890 for the repro.',
    source: 'human', confidence: 0.5, createdBy: 'human',
  });
  console.log('  ERROR: secret write was accepted!');
} catch (err) {
  console.log(`  refused as expected: ${(err as MemoryError).code} (store size still ${store.size()})`);
}

console.log('— 5. §43.3 purge: project deletion cleans index/cache/backup —');
const report = store.purge('acme');
console.log(`  removed=${report.removedCount} cleaned=${JSON.stringify(report.cleanedRefs)} registryClean=${report.registryClean}`);
console.log(`  store size=${store.size()}, registry total refs=${registry.totalRefs()}`);
console.log('done.');
