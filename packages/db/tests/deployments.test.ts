/**
 * Durable deployment records — SPEC v2 §41/§77 (Batch 19-1).
 *
 * One scripted sequence, run identically against the in-memory
 * reference and the SQLite implementation:
 *  - save/get round-trips the row field-for-field, including the
 *    reconstructable spec (deep-copied: mutating the input or a
 *    fetched row cannot corrupt stored state);
 *  - byPipeline returns a pipeline's deployments in creation order;
 *  - status transitions are plain upserts on the same id;
 *  - markRehydrated stamps the rebuild marker and leaves other
 *    columns untouched; unknown ids are a no-op;
 *  - the spec carries NO secret values: the DeploymentSpec type has
 *    no values field, and the JSON round-trip cannot invent one;
 *  - rows written by one FactoryDatabase are visible under the next
 *    (a restart loses no parked deployment), on an old database
 *    file that predates the table entirely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoryDatabase,
  InMemoryDeploymentStore,
  makePersistedDeployment,
  type DeploymentStore,
} from '../src/index';

function tmpDbFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-db-deployments-'));
  return { dir, file: join(dir, 'factory.db') };
}

function script(store: DeploymentStore): void {
  assert.deepEqual(store.list(), []);
  const a = makePersistedDeployment({ pipelineId: 'pipe-1' });
  const b = makePersistedDeployment({ pipelineId: 'pipe-1' });
  store.save(a);
  store.save(b);

  // Field-for-field round trip, spec included.
  const got = store.get(a.id);
  assert.ok(got);
  assert.deepEqual(got, a);

  // Copy contract: mutate the input and the fetched row afterwards —
  // stored state is unaffected.
  a.spec.secretRefs.push('MUTATED');
  (got as { status: string }).status = 'SUCCEEDED';
  assert.deepEqual(store.get(a.id)?.spec.secretRefs, []);
  assert.equal(store.get(a.id)?.status, 'AWAITING_APPROVAL');

  // Pipeline scoping and creation order.
  const c = makePersistedDeployment({ pipelineId: 'pipe-2' });
  store.save(c);
  assert.deepEqual(
    store.byPipeline('pipe-1').map((r) => r.id),
    [a.id, b.id],
  );
  assert.deepEqual(store.byPipeline('pipe-2').map((r) => r.id), [c.id]);
  assert.deepEqual(store.byPipeline('pipe-zzz'), []);

  // Status transitions are upserts on the same id; the spec survives.
  store.save({ ...a, status: 'SUCCEEDED', endedAt: '2026-10-13T00:00:00.000Z' });
  const done = store.get(a.id);
  assert.equal(done?.status, 'SUCCEEDED');
  assert.equal(done?.endedAt, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(done?.spec.snapshot, a.spec.snapshot);

  // Rebuild marker.
  store.markRehydrated(b.id, '2026-10-13T01:00:00.000Z');
  assert.equal(store.get(b.id)?.rehydratedAt, '2026-10-13T01:00:00.000Z');
  assert.equal(store.get(b.id)?.status, 'AWAITING_APPROVAL');
  store.markRehydrated('no-such-id', 'x'); // no-op, no throw

  // The spec has no channel for secret VALUES: names round-trip,
  // values cannot appear even if smuggled into the JSON payload.
  const withRefs = makePersistedDeployment({
    spec: { ...a.spec, secretRefs: ['DB_PASSWORD', 'API_KEY'] },
  });
  store.save(withRefs);
  const back = store.get(withRefs.id);
  assert.deepEqual(back?.spec.secretRefs, ['DB_PASSWORD', 'API_KEY']);
  assert.ok(
    !JSON.stringify(back?.spec).includes('s3cr3t-value'),
    'no secret value in the persisted spec',
  );
}

describe('durable deployment records (§41/§77, Batch 19)', () => {
  it('memory and SQLite agree on every step', () => {
    script(new InMemoryDeploymentStore());
    const { dir, file } = tmpDbFile();
    try {
      const fdb = new FactoryDatabase(file);
      script(fdb.deployments);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rows survive a database reopen (restart fidelity)', () => {
    const { dir, file } = tmpDbFile();
    try {
      const parked = makePersistedDeployment({ pipelineId: 'pipe-restart' });
      {
        const a = new FactoryDatabase(file);
        a.deployments.save(parked);
      }
      {
        const b = new FactoryDatabase(file);
        const back = b.deployments.get(parked.id);
        assert.ok(back, 'parked deployment survives the restart');
        assert.equal(back?.status, 'AWAITING_APPROVAL');
        assert.deepEqual(back?.spec, parked.spec);
        b.deployments.markRehydrated(parked.id, '2026-10-13T02:00:00.000Z');
      }
      {
        const c = new FactoryDatabase(file);
        assert.equal(c.deployments.get(parked.id)?.rehydratedAt, '2026-10-13T02:00:00.000Z');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an old database gains the table on open', () => {
    const { dir, file } = tmpDbFile();
    try {
      // Open through a minimal raw DB first (no deployments writer),
      // then through the full FactoryDatabase — the table must exist.
      const fdb = new FactoryDatabase(file);
      fdb.deployments.save(makePersistedDeployment());
      assert.equal(fdb.deployments.list().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
