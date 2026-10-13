/**
 * Batch 26 — merge queue enqueue position: cross-process allocation.
 *
 * Background: enqueue() computed the next position from an in-memory
 * counter, so two processes hydrating the same DB both picked the same
 * position (reproduced for real: two entries landed at position 2).
 * The (repo_path, position) unique index is now the arbiter: on
 * collision enqueue() re-reads the true max via maxPosition() and
 * retries with a fresh position. No entry is ever dropped and the
 * order stays deterministic.
 *
 * Tests run compiled from dist/tests/ (see package.json "test").
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MergeQueue,
  PrStore,
  type MergeQueueEntry,
  type PrRecord,
} from '../src/index';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** Minimal real git repo (enqueue only needs the path to exist). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'merge-queue-position-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function makePr(prs: PrStore, n: number): PrRecord {
  return prs.create({
    taskId: `task-${n}`,
    sourceBranch: `feat-${n}`,
    targetBranch: 'main',
    title: `pr ${n}`,
    createdBy: 'human',
  });
}

async function factoryDb(dbPath: string): Promise<any> {
  // Dynamic absolute import: tsc must not try to resolve the sibling
  // package at typecheck time (same trick as merge-queue-drain.test.ts).
  const dbIndex = join(__dirname, '..', '..', '..', 'db', 'dist', 'src', 'index.js');
  const { FactoryDatabase } = await import(dbIndex);
  return new FactoryDatabase(dbPath);
}

describe('MergeQueue cross-process enqueue positions (Batch 26)', () => {
  it('two queues racing enqueue get distinct ordered positions, none lost', async () => {
    const dir = makeRepo();
    const dbPath = join(dir, 'factory.db');
    const prs = new PrStore();
    const prA = makePr(prs, 1);
    const prB = makePr(prs, 2);

    // Two "processes": independent FactoryDatabase connections on the
    // same file, each with its own MergeQueue hydrated from it.
    const fdbA = await factoryDb(dbPath);
    const fdbB = await factoryDb(dbPath);
    const events: string[] = [];
    const qA = new MergeQueue(dir, {
      prs,
      persistence: fdbA.mergeQueueEntries,
      audit: (action, d) => events.push(`${action}:${d?.['attempt'] ?? ''}`),
    });
    const qB = new MergeQueue(dir, {
      prs,
      persistence: fdbB.mergeQueueEntries,
      audit: (action, d) => events.push(`${action}:${d?.['attempt'] ?? ''}`),
    });
    qA.hydrate();
    qB.hydrate();

    const eA = qA.enqueue(prA, 'opA');
    const eB = qB.enqueue(prB, 'opB');

    // Distinct positions, deterministic order, nothing dropped.
    assert.notEqual(eA.position, eB.position);
    const ordered = [eA.position, eB.position].sort((x, y) => x - y);
    assert.deepEqual(ordered, [1, 2]);

    // The loser retried exactly once and audited it.
    assert.ok(
      events.some((e) => e.startsWith('GIT_MERGE_QUEUE_POSITION_RETRY:1')),
      `expected a position retry audit, got: ${JSON.stringify(events)}`,
    );

    // The DB agrees: two rows, distinct positions.
    const rows = (
      fdbA.mergeQueueEntries.load(dir) as { prId: string; position: number }[]
    )
      .map((r) => r.position)
      .sort((x, y) => x - y);
    assert.deepEqual(rows, [1, 2]);

    fdbA.close();
    fdbB.close();
  });

  it('a cross-process PR duplicate still surfaces the domain error (not a retry)', async () => {
    const dir = makeRepo();
    const dbPath = join(dir, 'factory.db');
    const prs = new PrStore();
    const pr = makePr(prs, 1);

    const fdbA = await factoryDb(dbPath);
    const fdbB = await factoryDb(dbPath);
    const qA = new MergeQueue(dir, { prs, persistence: fdbA.mergeQueueEntries });
    const qB = new MergeQueue(dir, { prs, persistence: fdbB.mergeQueueEntries });
    qA.hydrate();
    qB.hydrate();

    qA.enqueue(pr, 'opA');
    // qB's in-memory check cannot see qA's row; the backing's partial
    // unique index must still answer "already in the queue".
    assert.throws(() => qB.enqueue(pr, 'opB'), /already in the merge queue/);

    fdbA.close();
    fdbB.close();
  });

  it('a stale counter is repaired from the backing maxPosition', async () => {
    const dir = makeRepo();
    const dbPath = join(dir, 'factory.db');
    const prs = new PrStore();

    const fdb = await factoryDb(dbPath);
    const q = new MergeQueue(dir, { prs, persistence: fdb.mergeQueueEntries });
    q.hydrate();

    // Simulate a row another process wrote at the position this queue
    // is about to use (its nextPosition is 1).
    const foreign: MergeQueueEntry = {
      id: 'foreign-row',
      repo: dir,
      prId: 'pr-foreign',
      taskId: 't-x',
      sourceBranch: 'feat-x',
      targetBranch: 'main',
      status: 'QUEUED',
      position: 1,
      enqueuedBy: 'other',
      enqueuedAt: new Date().toISOString(),
      processedAt: null,
      baseSha: null,
      candidateSha: null,
      candidateTreeOid: null,
      targetSha: null,
      diffHash: null,
      artifactDigest: null,
      verification: null,
      failureReason: null,
      mergeCommitSha: null,
      decisionAuditRef: null,
      claimedBy: null,
      claimedAt: null,
    };
    fdb.mergeQueueEntries.save(foreign);

    const e = q.enqueue(makePr(prs, 9), 'op');
    assert.equal(e.position, 2);

    fdb.close();
  });
});
