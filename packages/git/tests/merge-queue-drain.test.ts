/**
 * Merge Queue cross-process drain mutual exclusion — SPEC v2 §36
 * (Batch 23).
 *
 * The per-entry tryClaim (Batch 23, sibling) stops two processes from
 * working the SAME entry, but still lets two processes drain DIFFERENT
 * entries of one repo concurrently — breaking the queue's core §36
 * invariant (entries verified strictly one at a time, each against the
 * tip that already contains every previously queued merge). The
 * repo-level drain lease added here closes that gap: only one drainer
 * per repo at a time.
 *
 * Pinned here:
 *  - two REAL processes draining the same repo+DB file concurrently
 *    process every entry exactly once (the Batch 23-2 repro: before the
 *    fix both processes merged both entries — 4 MERGED audits for 2
 *    entries);
 *  - a contested drain yields loudly: MERGE_QUEUE_DRAIN_CONTESTED is
 *    audited, processAll returns [], the entry stays QUEUED (nothing is
 *    double-run, nothing is dropped);
 *  - a stale lock is taken over honestly: MERGE_QUEUE_DRAIN_TAKEOVER,
 *    the dead holder's VERIFYING rows are demoted (never resurrected
 *    from a terminal state), each entry still processed exactly once;
 *  - hydrate() defers demoting VERIFYING rows while a live drainer
 *    holds the repo (MERGE_QUEUE_REHYDRATED_DEFERRED), instead of
 *    stealing in-flight work.
 *
 * The queue-level tests use a Map-backed drain lock double (deterministic,
 * no timing); the SQLite implementation is pinned separately in
 * @ai-factory/db (merge-queue-drain-lock.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MergeQueue,
  PrStore,
  type DrainAcquireResult,
  type MergeQueueDrainLock,
  type MergeQueueDrainLockState,
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

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Deterministic in-memory drain-lock double. */
class MapDrainLock implements MergeQueueDrainLock {
  readonly rows = new Map<string, MergeQueueDrainLockState>();
  constructor(private readonly clock: { now(): number }) {}
  acquireDrain(repo: string, holderId: string, nowMs: number, ttlMs: number): DrainAcquireResult {
    const cur = this.rows.get(repo);
    if (!cur) {
      this.rows.set(repo, { holderId, claimedAt: nowMs, heartbeatAt: nowMs });
      return 'acquired';
    }
    if (nowMs - cur.heartbeatAt > ttlMs) {
      this.rows.set(repo, { holderId, claimedAt: nowMs, heartbeatAt: nowMs });
      return 'takeover';
    }
    return 'contested';
  }
  heartbeatDrain(repo: string, holderId: string, nowMs: number): boolean {
    const cur = this.rows.get(repo);
    if (!cur || cur.holderId !== holderId) return false;
    cur.heartbeatAt = nowMs;
    return true;
  }
  releaseDrain(repo: string, holderId: string): void {
    if (this.rows.get(repo)?.holderId === holderId) this.rows.delete(repo);
  }
  drainState(repo: string): MergeQueueDrainLockState | null {
    return this.rows.get(repo) ?? null;
  }
}

/** Map-backed persistence with an optional drain lock (mirrors the SQLite seam). */
class MapPersistence implements MergeQueueEntryPersistence {
  readonly rows = new Map<string, MergeQueueEntry>();
  drainLock?: MergeQueueDrainLock;
  save(e: MergeQueueEntry): void {
    this.rows.set(e.id, structuredClone(e));
  }
  load(_repo: string): MergeQueueEntry[] {
    return [...this.rows.values()]
      .filter((e) => e.repo === _repo)
      .sort((a, b) => a.position - b.position)
      .map((e) => structuredClone(e));
  }
}

function makeEntry(over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    repo: '/repo',
    prId: 'pr-1',
    taskId: 't-1',
    sourceBranch: 'feat',
    targetBranch: 'main',
    status: 'QUEUED',
    position: 1,
    enqueuedBy: 'human',
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
    ...over,
  } as MergeQueueEntry;
}

describe('merge queue drain lock', () => {
  it('a contested drain yields loudly: audited, nothing processed, entry stays QUEUED', needsGit, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-drain-contested-'));
    try {
      sh(dir, ['init', '-q', '-b', 'main', 'repo']);
      const repo = join(dir, 'repo');
      sh(repo, ['config', 'user.email', 't@t']);
      sh(repo, ['config', 'user.name', 't']);
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      sh(repo, ['add', '.']);
      sh(repo, ['commit', '-qm', 'base']);
      sh(repo, ['checkout', '-qb', 'feat']);
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      sh(repo, ['add', '.']);
      sh(repo, ['commit', '-qm', 'feat']);
      sh(repo, ['checkout', '-q', 'main']);

      const clock = { now: () => 1_000 };
      const persistence = new MapPersistence();
      persistence.drainLock = new MapDrainLock(clock);
      const prs = new PrStore();
      const pr = prs.create({ taskId: 't1', sourceBranch: 'feat', targetBranch: 'main', title: 'f', createdBy: 'h' });

      // Another "process" holds the repo's drain lease with a fresh heartbeat.
      assert.equal(persistence.drainLock.acquireDrain(repo, 'peer-holder', 1_000, 60_000), 'acquired');

      const audits: Array<{ action: string; details: unknown }> = [];
      const q = new MergeQueue(repo, {
        prs,
        persistence,
        clock,
        audit: (action, details) => audits.push({ action, details }),
      });
      q.hydrate();
      q.enqueue(pr, 'human');

      const done = await q.processAll();
      assert.equal(done.length, 0, 'contested drain processes nothing');
      assert.ok(
        audits.some((a) => a.action === 'MERGE_QUEUE_DRAIN_CONTESTED'),
        'contested drain is audited loudly',
      );
      const rows = persistence.load(repo);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'QUEUED', 'entry is not dropped, still queued for the live drainer');

      // The live drainer releases; this queue can now drain for real.
      persistence.drainLock.releaseDrain(repo, 'peer-holder');
      const done2 = await q.processAll();
      assert.equal(done2.length, 1);
      assert.equal(done2[0].status, 'MERGED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrate defers demoting VERIFYING rows while a live drainer holds the repo', () => {
    const persistence = new MapPersistence();
    const clock = { now: () => 1_000 };
    persistence.drainLock = new MapDrainLock(clock);
    const row = makeEntry({ id: 'e-live', status: 'VERIFYING', claimedBy: 'peer', claimedAt: new Date(900).toISOString() });
    persistence.save(row);
    // Live heartbeat from the peer drainer.
    assert.equal(persistence.drainLock.acquireDrain('/repo', 'peer-holder', 1_000, 60_000), 'acquired');

    const audits: string[] = [];
    const q = new MergeQueue('/repo', {
      persistence,
      clock,
      audit: (action) => audits.push(action),
    });
    q.hydrate();
    const kept = q.get('e-live');
    assert.equal(kept?.status, 'VERIFYING', 'in-flight row is not stolen');
    assert.ok(!audits.includes('MERGE_QUEUE_REHYDRATED'), 'no demotion audit');
    assert.ok(
      audits.includes('MERGE_QUEUE_REHYDRATED_DEFERRED'),
      'deferral is audited',
    );

    // Once the peer is gone (stale lock), a new hydrate demotes honestly.
    persistence.drainLock.releaseDrain('/repo', 'peer-holder');
    const q2 = new MergeQueue('/repo', { persistence, clock, audit: (a) => audits.push(a) });
    q2.hydrate();
    assert.equal(q2.get('e-live')?.status, 'QUEUED');
    assert.ok(audits.includes('MERGE_QUEUE_REHYDRATED'));
  });

  it('stale lock takeover demotes abandoned rows but never resurrects terminal ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-drain-takeover-'));
    try {
      sh(dir, ['init', '-q', '-b', 'main', 'repo']);
      const repo = join(dir, 'repo');
      sh(repo, ['config', 'user.email', 't@t']);
      sh(repo, ['config', 'user.name', 't']);
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      sh(repo, ['add', '.']);
      sh(repo, ['commit', '-qm', 'base']);
      sh(repo, ['checkout', '-qb', 'feat']);
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      sh(repo, ['add', '.']);
      sh(repo, ['commit', '-qm', 'feat']);
      sh(repo, ['checkout', '-q', 'main']);

      // nowMs is controllable: t=1_000 for setup, t=1_000+TTL+1 for the takeover.
      let now = 1_000;
      const clock = { now: () => now };
      const persistence = new MapPersistence();
      const lock = new MapDrainLock(clock);
      persistence.drainLock = lock;
      const prs = new PrStore();
      const pr = prs.create({ taskId: 't1', sourceBranch: 'feat', targetBranch: 'main', title: 'f', createdBy: 'h' });

      // A dead holder left a VERIFYING row and a stale lease behind.
      const dead = makeEntry({ id: 'e-dead', repo, prId: pr.id, status: 'VERIFYING', claimedBy: 'dead', claimedAt: new Date(500).toISOString() });
      persistence.save(dead);
      assert.equal(lock.acquireDrain(repo, 'dead-holder', 1_000, 60_000), 'acquired');

      const audits: string[] = [];
      const q = new MergeQueue(repo, {
        prs,
        persistence,
        clock,
        drainLockTtlMs: 60_000,
        audit: (action) => audits.push(action),
      });
      // hydrate at t=1000: drain lock looks live → defer demotion.
      q.hydrate();
      assert.equal(q.get('e-dead')?.status, 'VERIFYING');

      // t moves past the TTL: the holder is dead; this drain takes over.
      now = 1_000 + 60_001;
      const done = await q.processAll();
      assert.ok(audits.includes('MERGE_QUEUE_DRAIN_TAKEOVER'), 'takeover is audited');
      assert.equal(done.length, 1);
      assert.equal(done[0].status, 'MERGED');
      assert.equal(done[0].id, 'e-dead', 'the abandoned entry is recovered, not duplicated');
      const mergedAudits = audits.filter((a) => a === 'GIT_MERGE_QUEUE_MERGED');
      assert.equal(mergedAudits.length, 1, 'exactly one merge decision');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two real processes draining concurrently process every entry exactly once', { ...needsGit, timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-drain-race-'));
    try {
      const repo = join(dir, 'repo');
      const dbPath = join(dir, 'factory.db');
      sh(dir, ['init', '-q', '-b', 'main', repo]);
      sh(repo, ['config', 'user.email', 't@t']);
      sh(repo, ['config', 'user.name', 't']);
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      sh(repo, ['add', '.']);
      sh(repo, ['commit', '-qm', 'base']);
      for (const [branch, file] of [['feat-a', 'a.txt'], ['feat-b', 'b.txt']] as const) {
        sh(repo, ['checkout', '-qb', branch]);
        writeFileSync(join(repo, file), `${file}\n`);
        sh(repo, ['add', '.']);
        sh(repo, ['commit', '-qm', branch]);
      }
      sh(repo, ['checkout', '-q', 'main']);

      // Absolute dist paths for the children (tests run compiled from dist/tests/).
      const gitDist = join(__dirname, '..', 'src');
      const dbDist = join(__dirname, '..', '..', '..', 'db', 'dist', 'src', 'db.js');

      // Parent sets up: real FactoryDatabase (wires the drain lock) + 2 PRs enqueued.
      const { FactoryDatabase } = await import(dbDist);
      const { MergeQueue: MQ } = await import(join(gitDist, 'mergeQueue.js'));
      const fdb = new FactoryDatabase(dbPath);
      const prs = [];
      for (const branch of ['feat-a', 'feat-b']) {
        prs.push(
          fdb.prStore.create({ taskId: 't1', sourceBranch: branch, targetBranch: 'main', title: branch, createdBy: 'setup' }),
        );
      }
      const setupQ = new MQ(repo, { prs: fdb.prStore, persistence: fdb.mergeQueueEntries, audit: () => {} });
      const entries = prs.map((pr: { id: string }) => setupQ.enqueue(pr, 'setup'));
      assert.equal(entries.length, 2);

      // Child drainer: its own process, its own DB connection, slow
      // verifier to force the overlap window wide open.
      const drainer = join(dir, 'drainer.mjs');
      writeFileSync(
        drainer,
        `import { writeFileSync, appendFileSync } from 'node:fs';
const [dbPath, repoPath, outFile, auditFile] = process.argv.slice(2);
const { FactoryDatabase } = await import(${JSON.stringify(dbDist)});
const { MergeQueue } = await import(${JSON.stringify(join(gitDist, 'mergeQueue.js'))});
const fdb = new FactoryDatabase(dbPath);
const events = [];
const q = new MergeQueue(repoPath, {
  prs: fdb.prStore,
  persistence: fdb.mergeQueueEntries,
  audit: (action, details) => events.push(JSON.stringify({ proc: process.pid, action, entryId: details?.entryId ?? null })),
  verify: async () => { await new Promise((r) => setTimeout(r, 900)); return { ok: true, detail: 'slow ok' }; },
});
q.hydrate();
let result;
try {
  const processed = await q.processAll();
  result = { pid: process.pid, processed: processed.map((e) => ({ id: e.id, status: e.status })) };
} catch (e) {
  result = { pid: process.pid, error: String((e && e.message) || e) };
}
appendFileSync(auditFile, events.join('\\n') + '\\n');
writeFileSync(outFile, JSON.stringify(result));
`,
      );
      const out1 = join(dir, 'out1.json');
      const out2 = join(dir, 'out2.json');
      const auditFile = join(dir, 'audit.jsonl');
      const runChild = (out: string) =>
        new Promise<void>((resolve, reject) => {
          const c = spawn(process.execPath, [drainer, dbPath, repo, out, auditFile], { stdio: 'inherit' });
          c.on('error', reject);
          c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`drainer exited ${code}`))));
        });
      await Promise.all([runChild(out1), runChild(out2)]);

      const r1 = JSON.parse(readFileSync(out1, 'utf8'));
      const r2 = JSON.parse(readFileSync(out2, 'utf8'));
      assert.ok(!r1.error, `child 1 error: ${r1.error}`);
      assert.ok(!r2.error, `child 2 error: ${r2.error}`);
      const mergedEvents = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.action === 'GIT_MERGE_QUEUE_MERGED');
      assert.equal(mergedEvents.length, 2, `each entry merged exactly once, got ${mergedEvents.length} MERGED audits`);
      const byEntry = new Map<string, number>();
      for (const e of mergedEvents) byEntry.set(e.entryId, (byEntry.get(e.entryId) ?? 0) + 1);
      for (const [id, n] of byEntry) assert.equal(n, 1, `entry ${id} merged ${n} times`);

      // Final DB truth: both entries MERGED, each with a merge commit.
      const fdb2 = new FactoryDatabase(dbPath);
      const rows = fdb2.mergeQueueEntries.load(repo);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.status, 'MERGED');
        assert.ok(row.mergeCommitSha, 'merge commit recorded');
      }
      // No drain lease left behind.
      assert.equal(fdb2.mergeQueueEntries.drainLock?.drainState(repo), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
