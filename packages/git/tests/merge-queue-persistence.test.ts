/**
 * Merge Queue durability — SPEC v2 §36 (Batch 20).
 *
 * The queue's operational state stays in memory, but every mutation is
 * written through a MergeQueueEntryPersistence the moment it happens.
 * These tests pin the crash-honesty contract with a Map-backed seam
 * (two queue instances over one seam = the two processes around a
 * restart; the SQLite mapping + its partial unique index are pinned
 * separately in @ai-factory/db):
 *  - hydrate() demotes a VERIFYING row left by a crash back to QUEUED
 *    and audits MERGE_QUEUE_REHYDRATED — a verification that died
 *    mid-flight is never trusted;
 *  - the stored verification snapshot is display-only: a re-run
 *    re-assembles the candidate against the CURRENT target tip, so a
 *    stale PASS cannot land a merge that now conflicts;
 *  - MERGED / FAILED rows are history: hydrate lists them, processAll
 *    never reprocesses them, and positions continue past them;
 *  - the same PR cannot hold two ACTIVE entries, in-memory or across
 *    instances (the seam enforces the partial-unique rule the real
 *    index enforces);
 *  - decisionAuditRef round-trips through setDecisionAuditRef;
 *  - without persistence the Batch 16 behavior stands (hydrate is a
 *    no-op, state is process-local).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MergeQueue,
  PrStore,
  type MergeQueueEntry,
  type MergeQueueEntryPersistence,
} from '../src/index';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}
const needsGit = { skip: !gitAvailable } as const;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Map-backed MergeQueueEntryPersistence enforcing the same rule as the
 * SQLite partial unique index: at most one ACTIVE (QUEUED/VERIFYING)
 * row per PR. A duplicate active save throws a UNIQUE constraint
 * error, which is exactly what the queue maps to its domain error.
 */
class MapPersistence implements MergeQueueEntryPersistence {
  readonly rows = new Map<string, MergeQueueEntry>();
  saved = 0;
  save(e: MergeQueueEntry): void {
    const active = (s: string) => s === 'QUEUED' || s === 'VERIFYING';
    for (const r of this.rows.values()) {
      if (r.id !== e.id && r.prId === e.prId && active(r.status) && active(e.status)) {
        throw new Error(
          'UNIQUE constraint failed: merge_queue_entries.pr_id',
        );
      }
    }
    this.rows.set(e.id, structuredClone(e));
    this.saved++;
  }
  load(repo: string): MergeQueueEntry[] {
    return [...this.rows.values()]
      .filter((r) => r.repo === repo)
      .sort((a, b) => a.position - b.position)
      .map((r) => structuredClone(r));
  }
  /** Test surgery on the stored row (simulating a crashed process). */
  raw(id: string): MergeQueueEntry {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  }
}

/** main: f.txt = "line1\nline2"; featA/featB rewrite line1 (mutually
 *  conflicting); featC adds g.txt (unrelated). */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'merge-queue-persist-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'f.txt'), 'line1\nline2\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-qb', 'featA']);
  writeFileSync(join(dir, 'f.txt'), 'line1-A\nline2\n');
  git(dir, ['commit', '-qam', 'A']);
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['checkout', '-qb', 'featB']);
  writeFileSync(join(dir, 'f.txt'), 'line1-B\nline2\n');
  git(dir, ['commit', '-qam', 'B']);
  git(dir, ['checkout', '-q', 'main']);
  git(dir, ['checkout', '-qb', 'featC']);
  writeFileSync(join(dir, 'g.txt'), 'unrelated\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'C']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

function makePrs() {
  const prs = new PrStore();
  const a = prs.create({
    taskId: 'task-a', sourceBranch: 'featA', targetBranch: 'main',
    title: 'A', createdBy: 'human',
  });
  const b = prs.create({
    taskId: 'task-b', sourceBranch: 'featB', targetBranch: 'main',
    title: 'B', createdBy: 'human',
  });
  const c = prs.create({
    taskId: 'task-c', sourceBranch: 'featC', targetBranch: 'main',
    title: 'C', createdBy: 'human',
  });
  return { prs, a, b, c };
}

async function waitFor(
  cond: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('merge queue persistence (Batch 20)', needsGit, () => {
  it('hydrate demotes a crashed VERIFYING row to QUEUED and audits it', async () => {
    const dir = makeFixture();
    const { prs, a } = makePrs();
    const seam = new MapPersistence();
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];

    let release!: (v: { ok: boolean; detail: string }) => void;
    const gate = new Promise<{ ok: boolean; detail: string }>((r) => {
      release = r;
    });
    // Process 1: freezes mid-verification (the "crash").
    const q1 = new MergeQueue(dir, {
      prs,
      persistence: seam,
      verify: () => gate,
    });
    const enqueued = q1.enqueue(a, 'human');
    const processing = q1.processNext();
    await waitFor(
      () => seam.raw(enqueued.id).status === 'VERIFYING',
      'row to reach VERIFYING',
    );

    // Process 2 (after the "restart"): rebuilds from the seam.
    const q2 = new MergeQueue(dir, {
      prs,
      persistence: seam,
      audit: (action, details) => audits.push({ action, details }),
    });
    q2.hydrate();
    const rebuilt = q2.get(enqueued.id);
    assert.ok(rebuilt);
    assert.equal(rebuilt.status, 'QUEUED');
    // The crash is on the record: one honest event, not a silent flip.
    const rehydrated = audits.filter((x) => x.action === 'MERGE_QUEUE_REHYDRATED');
    assert.equal(rehydrated.length, 1);
    assert.equal(rehydrated[0].details['entryId'], enqueued.id);
    assert.equal(rehydrated[0].details['fromStatus'], 'VERIFYING');
    assert.equal(rehydrated[0].details['toStatus'], 'QUEUED');
    // The stored row was demoted too.
    assert.equal(seam.raw(enqueued.id).status, 'QUEUED');
    // Hydrate is idempotent: no duplicates, no second event.
    q2.hydrate();
    assert.equal(q2.list().length, 1);
    assert.equal(audits.filter((x) => x.action === 'MERGE_QUEUE_REHYDRATED').length, 1);

    // Let process 1 finish so nothing dangles.
    release({ ok: false, detail: 'late verdict' });
    const done = await processing;
    assert.equal(done?.status, 'FAILED');
    assert.equal(seam.raw(enqueued.id).status, 'FAILED');
  });

  it('a re-run re-assembles the candidate: a stale PASS is display-only', async () => {
    const dir = makeFixture();
    const { prs, a } = makePrs();
    const seam = new MapPersistence();
    const q1 = new MergeQueue(dir, { prs, persistence: seam });
    const enqueued = q1.enqueue(a, 'human');

    // Simulate the crash: a VERIFYING row whose stored verification
    // claims the candidate passed at an old base.
    const row = seam.raw(enqueued.id);
    row.status = 'VERIFYING';
    row.baseSha = '0'.repeat(40);
    row.verification = {
      checks: [{ name: 'conflict', status: 'PASS', detail: 'stale claim' }],
      conflicts: [],
      verifiedAt: '2000-01-01T00:00:00.000Z',
    };

    // The target moved while the process was down: main now rewrites
    // the same line featA touches — the candidate genuinely conflicts.
    git(dir, ['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'f.txt'), 'line1-main\nline2\n');
    git(dir, ['commit', '-qam', 'main moves']);

    const q2 = new MergeQueue(dir, { prs, persistence: seam });
    q2.hydrate();
    const rebuilt = q2.get(enqueued.id);
    assert.ok(rebuilt);
    assert.equal(rebuilt.status, 'QUEUED');
    // The stale snapshot is still there for display — until the re-run.
    assert.equal(
      rebuilt.verification?.verifiedAt,
      '2000-01-01T00:00:00.000Z',
    );

    const [processed] = await q2.processAll();
    assert.equal(processed.status, 'FAILED');
    assert.ok(
      processed.failureReason?.includes('conflicts'),
      `expected a conflict failure, got: ${processed.failureReason}`,
    );
    // The verification on the entry is the FRESH one, not the stale PASS.
    assert.notEqual(processed.verification?.verifiedAt, '2000-01-01T00:00:00.000Z');
    assert.equal(processed.verification?.checks[0]?.status, 'FAIL');
    assert.ok((processed.verification?.conflicts.length ?? 0) > 0);
    // Nothing landed: main is still the moved tip, not a merge.
    const log = git(dir, ['log', '--oneline', '-1', 'main']);
    assert.ok(log.includes('main moves'));
  });

  it('MERGED/FAILED rows are history: listed, never reprocessed, positions continue', async () => {
    const dir = makeFixture();
    const { prs, a, b, c } = makePrs();
    const seam = new MapPersistence();
    const q1 = new MergeQueue(dir, { prs, persistence: seam });
    q1.enqueue(a, 'human');
    q1.enqueue(b, 'human');
    const done = await q1.processAll();
    assert.deepEqual(
      done.map((e) => e.status),
      ['MERGED', 'FAILED'],
    );

    const q2 = new MergeQueue(dir, { prs, persistence: seam });
    q2.hydrate();
    assert.deepEqual(
      q2.list().map((e) => e.status),
      ['MERGED', 'FAILED'],
    );
    // Nothing to do: history is not reprocessed.
    assert.deepEqual(await q2.processAll(), []);
    // Positions continue past the restored rows.
    const third = q2.enqueue(c, 'human');
    assert.equal(third.position, 3);
    assert.equal(seam.raw(third.id).position, 3);
  });

  it('the same PR cannot hold two ACTIVE entries, in-memory or across instances', () => {
    const dir = makeFixture();
    const { prs, a } = makePrs();
    const seam = new MapPersistence();
    const q1 = new MergeQueue(dir, { prs, persistence: seam });
    q1.enqueue(a, 'human');
    // Same process: the in-memory check fires.
    assert.throws(() => q1.enqueue(a, 'human'), /already in the merge queue/);
    // A second instance (= another process) racing past the memory
    // check hits the backing's uniqueness rule, mapped to the same
    // domain error.
    const q2 = new MergeQueue(dir, { prs, persistence: seam });
    assert.throws(() => q2.enqueue(a, 'human'), /already in the merge queue/);
  });

  it('setDecisionAuditRef round-trips the decision audit reference', async () => {
    const dir = makeFixture();
    const { prs, a } = makePrs();
    const seam = new MapPersistence();
    const q = new MergeQueue(dir, { prs, persistence: seam });
    const enqueued = q.enqueue(a, 'human');
    assert.equal(q.get(enqueued.id)?.decisionAuditRef, null);
    q.setDecisionAuditRef(enqueued.id, 'audit-42');
    assert.equal(q.get(enqueued.id)?.decisionAuditRef, 'audit-42');
    assert.equal(seam.raw(enqueued.id).decisionAuditRef, 'audit-42');
    assert.throws(() => q.setDecisionAuditRef('nope', 'x'), /not found/);
  });

  it('without persistence the Batch 16 behavior stands: hydrate is a no-op', async () => {
    const dir = makeFixture();
    const { prs, a } = makePrs();
    const q = new MergeQueue(dir, { prs });
    q.enqueue(a, 'human');
    q.hydrate(); // no persistence: nothing to rebuild, nothing lost in memory
    const [processed] = await q.processAll();
    assert.equal(processed.status, 'MERGED');
  });
});
