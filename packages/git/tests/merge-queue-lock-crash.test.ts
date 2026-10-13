/**
 * Merge Queue drain-lock crash recovery across REAL OS processes (Batch 38).
 *
 * Batch 23 gave the drain lock heartbeat + stale-takeover semantics and
 * pinned them with in-process / two-connection tests. This pins the crash
 * story end to end with two real processes sharing one SQLite file:
 *  - a holder process takes the drain lease and heartbeats it;
 *  - while it is alive, a contender process yields: processNext()
 *    returns null, MERGE_QUEUE_DRAIN_CONTESTED is audited, the entry
 *    stays QUEUED (nothing is double-run, nothing is dropped);
 *  - the holder is SIGKILLed mid-lease (no release — the crash);
 *  - once the heartbeat goes stale, a taker process reclaims the lock
 *    within the timeout: MERGE_LOCK_STALE_RECLAIMED is audited naming
 *    the dead holder, then MERGE_QUEUE_DRAIN_TAKEOVER + recovery, and
 *    the entry is processed exactly once and MERGED;
 *  - the taker releases normally and no lease row is left behind
 *    (normal release is still the only clean path).
 *
 * POSIX-only: SIGKILL has no Windows equivalent — skipped loudly there.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}
const needsPosixGit = { skip: !gitAvailable || process.platform === 'win32' } as const;

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Wait for a stdout line matching re, or throw on timeout/exit. */
function waitForLine(child: ChildProcess, re: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for ${re}`));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      for (const line of lines.slice(0, -1)) {
        if (re.test(line)) {
          clearTimeout(timer);
          resolve(line);
          return;
        }
      }
      buf = lines[lines.length - 1];
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code} before printing ${re}`));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for child exit')), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('merge queue drain-lock crash recovery (real processes)', () => {
  it('SIGKILLed holder -> stale reclaim audited -> takeover drains exactly once', { ...needsPosixGit, timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mq-lock-crash-'));
    try {
      const repo = join(dir, 'repo');
      const dbPath = join(dir, 'factory.db');
      sh(dir, ['init', '-q', '-b', 'main', repo]);
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

      // Absolute dist paths for the children (tests run compiled from dist/tests/).
      const gitDist = join(__dirname, '..', 'src');
      const dbDist = join(__dirname, '..', '..', '..', 'db', 'dist', 'src', 'db.js');

      // Parent sets up: real FactoryDatabase (wires the drain lock) + 1 PR enqueued.
      const { FactoryDatabase } = await import(dbDist);
      const { MergeQueue: MQ } = await import(join(gitDist, 'mergeQueue.js'));
      const fdb = new FactoryDatabase(dbPath);
      const pr = fdb.prStore.create({
        taskId: 't1',
        sourceBranch: 'feat',
        targetBranch: 'main',
        title: 'feat',
        createdBy: 'setup',
      });
      const setupQ = new MQ(repo, { prs: fdb.prStore, persistence: fdb.mergeQueueEntries, audit: () => {} });
      const entry = setupQ.enqueue(pr, 'setup');

      const TTL = 1500;
      const HEARTBEAT_EVERY = Math.floor(TTL / 3);

      // Holder: its own process, takes the drain lease directly and
      // heartbeats it until the parent SIGKILLs it (the crash — no release).
      const holderScript = join(dir, 'holder.mjs');
      writeFileSync(
        holderScript,
        `const [dbDist, dbPath, repoPath, holderId, ttlArg] = process.argv.slice(2);
const ttl = Number(ttlArg);
const { FactoryDatabase } = await import(dbDist);
const fdb = new FactoryDatabase(dbPath);
const lock = fdb.mergeQueueEntries.drainLock;
if (!lock) { console.error('NO_DRAIN_LOCK'); process.exit(2); }
const res = lock.acquireDrain(repoPath, holderId, Date.now(), ttl);
if (res !== 'acquired') { console.error('ACQUIRE_' + res); process.exit(3); }
console.log('HELD ' + holderId);
const every = Math.max(100, Math.floor(ttl / 3));
const iv = setInterval(() => {
  const ok = lock.heartbeatDrain(repoPath, holderId, Date.now());
  if (!ok) { console.error('HEARTBEAT_LOST'); clearInterval(iv); process.exit(4); }
}, every);
await new Promise(() => {});
`,
      );

      // Worker: its own process, runs one processNext() and reports the
      // outcome + every audit event as JSONL. Used both as the live-lock
      // prober (expect: contested, null) and as the post-crash taker
      // (expect: takeover, MERGED).
      const workerScript = join(dir, 'worker.mjs');
      writeFileSync(
        workerScript,
        `const [dbDist, gitDist, dbPath, repoPath, outFile, auditFile, ttlArg] = process.argv.slice(2);
const { appendFileSync, writeFileSync } = await import('node:fs');
const { FactoryDatabase } = await import(dbDist);
const { MergeQueue } = await import(gitDist + '/mergeQueue.js');
const fdb = new FactoryDatabase(dbPath);
const events = [];
const q = new MergeQueue(repoPath, {
  prs: fdb.prStore,
  persistence: fdb.mergeQueueEntries,
  drainLockTtlMs: Number(ttlArg),
  audit: (action, details) => events.push(JSON.stringify({ action, details: details ?? null })),
});
q.hydrate();
let result;
try {
  const processed = await q.processNext();
  result = { processedId: processed?.id ?? null, status: processed?.status ?? null };
} catch (e) {
  result = { error: String((e && e.message) || e) };
}
appendFileSync(auditFile, events.join('\\n') + '\\n');
writeFileSync(outFile, JSON.stringify(result));
`,
      );

      const runWorker = async (outFile: string, auditFile: string) => {
        const code = await waitForExit(
          spawn(process.execPath, [workerScript, dbDist, gitDist, dbPath, repo, outFile, auditFile, String(TTL)], {
            stdio: 'ignore',
          }),
          60_000,
        );
        assert.equal(code, 0, `worker exited ${code}`);
        const result = JSON.parse(readFileSync(outFile, 'utf8'));
        assert.ok(!result.error, `worker error: ${result.error}`);
        const audits = readFileSync(auditFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        return { result, audits };
      };

      // --- Phase 1: holder alive and heartbeating. ---
      const holderId = `holder-${process.pid}`;
      const holder = spawn(process.execPath, [holderScript, dbDist, dbPath, repo, holderId, String(TTL)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForLine(holder, /^HELD /, 15_000);

      // A contender while the lease is live must yield loudly.
      const probe = await runWorker(join(dir, 'probe-out.json'), join(dir, 'probe-audit.jsonl'));
      assert.equal(probe.result.processedId, null, 'live lease: contender processes nothing');
      assert.ok(
        probe.audits.some((a) => a.action === 'MERGE_QUEUE_DRAIN_CONTESTED'),
        'live lease: contention is audited',
      );
      assert.ok(
        !probe.audits.some((a) => a.action === 'MERGE_LOCK_STALE_RECLAIMED'),
        'live lease: no stale reclaim while the holder heartbeats',
      );
      const stillQueued = new FactoryDatabase(dbPath).mergeQueueEntries.load(repo);
      assert.equal(stillQueued[0].status, 'QUEUED', 'entry untouched while a live holder owns the repo');

      // --- Phase 2: the crash. SIGKILL — no release, no cleanup. ---
      const killAt = Date.now();
      holder.kill('SIGKILL');
      await waitForExit(holder, 15_000);

      // Wait until the heartbeat is honestly stale (poll the shared row).
      let staleAt = 0;
      const staleDeadline = Date.now() + 15_000;
      for (;;) {
        const st = new FactoryDatabase(dbPath).mergeQueueEntries.drainLock?.drainState(repo);
        if (st && Date.now() - st.heartbeatAt > TTL) {
          staleAt = Date.now();
          break;
        }
        if (Date.now() > staleDeadline) throw new Error('heartbeat never went stale after SIGKILL');
        await sleep(150);
      }
      assert.ok(
        staleAt - killAt <= TTL + HEARTBEAT_EVERY + 5_000,
        `staleness detected within one TTL of the kill (took ${staleAt - killAt}ms)`,
      );

      // --- Phase 3: the taker reclaims within the timeout and drains. ---
      const take = await runWorker(join(dir, 'take-out.json'), join(dir, 'take-audit.jsonl'));
      const takeDoneAt = Date.now();
      assert.equal(take.result.processedId, entry.id, 'taker reclaims and processes the entry');
      assert.equal(take.result.status, 'MERGED');

      const actions = take.audits.map((a) => a.action);
      const reclaimIx = actions.indexOf('MERGE_LOCK_STALE_RECLAIMED');
      const takeoverIx = actions.indexOf('MERGE_QUEUE_DRAIN_TAKEOVER');
      assert.ok(reclaimIx >= 0, 'stale reclaim is audited as MERGE_LOCK_STALE_RECLAIMED');
      assert.ok(takeoverIx >= 0, 'queue recovery is audited as MERGE_QUEUE_DRAIN_TAKEOVER');
      assert.ok(reclaimIx < takeoverIx, 'reclaim is audited before the takeover recovery runs');
      const reclaim = take.audits[reclaimIx];
      assert.equal(
        reclaim.details?.previousHolderId,
        holderId,
        'the reclaim audit names the dead holder',
      );
      assert.equal(reclaim.details?.newHolderId != null, true, 'the reclaim audit names the new holder');
      const mergedAudits = take.audits.filter(
        (a) => a.action === 'GIT_MERGE_QUEUE_MERGED' && a.details?.entryId === entry.id,
      );
      assert.equal(mergedAudits.length, 1, 'the entry is merged exactly once');

      // Final DB truth: MERGED with a merge commit; no lease left behind
      // (the taker's normal release is the clean path).
      const fdb2 = new FactoryDatabase(dbPath);
      const rows = fdb2.mergeQueueEntries.load(repo);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'MERGED');
      assert.ok(rows[0].mergeCommitSha, 'merge commit recorded');
      assert.equal(fdb2.mergeQueueEntries.drainLock?.drainState(repo), null, 'no lease left behind');

      // The queue was never stuck: kill -> reclaimed+merged inside the timeout.
      assert.ok(
        takeDoneAt - killAt < TTL * 3 + 60_000,
        `crash recovered promptly (kill -> merged in ${takeDoneAt - killAt}ms)`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
