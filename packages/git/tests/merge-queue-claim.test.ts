/**
 * Merge-queue cross-process drain claims — SPEC v2 §36 (Batch 23).
 *
 * Two MergeQueue instances sharing one durable backing must not merge
 * the same entry twice. The in-process tail chain only serializes one
 * instance; tryClaim() on the shared backing is the cross-process
 * guard. Pinned here on a real git repo:
 *  - two instances racing processAll(): the entry merges exactly once
 *    (one merge commit; onMerged fires once);
 *  - the loser skips the claimed entry and drains nothing (no error,
 *    no duplicate);
 *  - an entry with an expired claim is stolen and processed (crashed
 *    holder recovery);
 *  - hydrate() does not demote a row a live peer still holds.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MergeQueue,
  PrStore,
  type MergeQueueEntry,
  type MergeQueueEntryPersistence,
  type PrRecord,
} from '../src/index';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** Map-backed persistence WITH atomic claim support (mirrors the SQL). */
class ClaimingMapPersistence implements MergeQueueEntryPersistence {
  readonly rows = new Map<string, MergeQueueEntry>();
  save(e: MergeQueueEntry): void {
    this.rows.set(e.id, structuredClone(e));
  }
  load(repo: string): MergeQueueEntry[] {
    return [...this.rows.values()]
      .filter((r) => r.repo === repo)
      .sort((a, b) => a.position - b.position)
      .map((r) => structuredClone(r));
  }
  tryClaim(id: string, token: string, ttlMs: number): boolean {
    const r = this.rows.get(id);
    if (!r || r.status !== 'QUEUED') return false;
    const cutoff = Date.now() - ttlMs;
    const heldByOther =
      r.claimedBy !== null &&
      r.claimedBy !== token &&
      r.claimedAt !== null &&
      Date.parse(r.claimedAt) >= cutoff;
    if (heldByOther) return false;
    r.claimedBy = token;
    r.claimedAt = new Date().toISOString();
    return true;
  }
  /** Test surgery on the stored row (simulating a crashed process). */
  raw(id: string): MergeQueueEntry {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  }
}

/** main + feature branch with one clean commit; returns dir + PR record. */
function makeRepo(): { dir: string; pr: PrRecord; prs: PrStore } {
  const dir = mkdtempSync(join(tmpdir(), 'merge-queue-claim-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'f.txt'), 'line1\nline2\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-qb', 'feat']);
  writeFileSync(join(dir, 'f.txt'), 'line1-feat\nline2\n');
  git(dir, ['commit', '-qam', 'feat']);
  git(dir, ['checkout', '-q', 'main']);
  // Diverge main so the merge creates a real merge commit (no fast-forward).
  writeFileSync(join(dir, 'g.txt'), 'main-side\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'main-side']);
  const prs = new PrStore();
  const pr = prs.create({
    taskId: 'task-1',
    sourceBranch: 'feat',
    targetBranch: 'main',
    title: 'claim test',
    createdBy: 'human',
  });
  return { dir, pr, prs };
}

function mergeCommitCount(dir: string): number {
  return Number(git(dir, ['rev-list', '--count', '--merges', 'HEAD']));
}

describe('MergeQueue cross-process drain claims', () => {
  it('two instances racing drain the same entry exactly once', async () => {
    const { dir, pr, prs } = makeRepo();
    const persistence = new ClaimingMapPersistence();
    const q1 = new MergeQueue(dir, { prs, persistence });
    const q2 = new MergeQueue(dir, { prs, persistence });
    q1.enqueue(pr, 'human');
    q1.hydrate();
    q2.hydrate();

    let mergedCalls = 0;
    const hooks = {
      onMerged: () => {
        mergedCalls++;
      },
    };
    const [done1, done2] = await Promise.all([q1.processAll(hooks), q2.processAll(hooks)]);

    assert.equal(done1.length + done2.length, 1, 'exactly one instance processed the entry');
    assert.equal(mergedCalls, 1, 'onMerged fired exactly once');
    assert.equal(mergeCommitCount(dir), 1, 'exactly one merge commit landed');
  });

  it('an expired claim is stolen and the entry is processed (crashed holder)', async () => {
    const { dir, pr, prs } = makeRepo();
    const persistence = new ClaimingMapPersistence();
    const q1 = new MergeQueue(dir, { prs, persistence });
    q1.enqueue(pr, 'human');

    // Simulate a crashed holder: claim taken 10 minutes ago, entry left QUEUED.
    const entryId = persistence.load(dir)[0].id;
    const stored = persistence.raw(entryId);
    stored.claimedBy = 'dead-process-token';
    stored.claimedAt = new Date(Date.now() - 10 * 60_000).toISOString();

    const q2 = new MergeQueue(dir, { prs, persistence, claimTtlMs: 60_000 });
    q2.hydrate();
    const done = await q2.processAll();
    assert.equal(done.length, 1, 'stale-claimed entry was stolen and processed');
    assert.equal(done[0].status, 'MERGED');
    assert.equal(mergeCommitCount(dir), 1);
  });

  it('hydrate() does not demote a row a live peer still holds', async () => {
    const { dir, pr, prs } = makeRepo();
    const persistence = new ClaimingMapPersistence();
    const q1 = new MergeQueue(dir, { prs, persistence });
    q1.enqueue(pr, 'human');

    // A live peer holds the row: fresh claim + VERIFYING, as a real
    // mid-drain process would leave it.
    const entryId = persistence.load(dir)[0].id;
    assert.equal(persistence.tryClaim(entryId, 'peer-token', 300_000), true);
    persistence.raw(entryId).status = 'VERIFYING';

    const q2 = new MergeQueue(dir, { prs, persistence });
    q2.hydrate();
    const done = await q2.processAll();
    assert.equal(done.length, 0, 'live-held row was not stolen by hydrate + drain');
    assert.equal(mergeCommitCount(dir), 0, 'nothing landed');
  });

  it('a queue without claim support keeps the old single-process behavior', async () => {
    const { dir, pr, prs } = makeRepo();
    const persistence = new ClaimingMapPersistence();
    // Strip tryClaim: old-style backing.
    const legacy = persistence as unknown as { tryClaim?: unknown };
    delete legacy.tryClaim;
    const q = new MergeQueue(dir, { prs, persistence });
    q.enqueue(pr, 'human');
    const done = await q.processAll();
    assert.equal(done.length, 1);
    assert.equal(done[0].status, 'MERGED');
  });
});
