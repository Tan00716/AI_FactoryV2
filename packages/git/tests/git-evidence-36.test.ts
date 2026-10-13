/**
 * Batch 21-3 — §36 git evidence five-field integrity (re-audit).
 *
 * SPEC_V2.md §36: "Base SHA、Candidate SHA、Target SHA、Diff Hash、
 * Artifact Digest 必须记录。" This pins, against a REAL temp repo, that
 * the values recorded are genuine (not placeholders):
 *  - baseSha / candidateSha / targetSha are the actual 40-hex commit SHAs
 *    (verified against independent `git rev-parse` calls),
 *  - diffHash is the sha256 of the actual landed `git diff` text
 *    (verified by recomputing it independently),
 *  - artifactDigest is null with an honest 'no artifact' note —
 *    a merge/commit produces no build artifact, and the value is
 *    recorded as missing, never invented,
 *  - the merge evidence payload attached to a task now carries all five
 *    fields (the gap the re-audit found), while the legacy no-fields
 *    call still yields nulls (old records are not backfilled).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitRepo,
  PrStore,
  codeChangeEvidencePayload,
  mergeEvidencePayload,
  changeEvidenceFields,
} from '../src/index';

let gitAvailable = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}
const needsGit = { skip: !gitAvailable } as const;

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-evidence-36-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.name', 'audit']);
  git(dir, ['config', 'user.email', 'audit@example.com']);
  writeFileSync(join(dir, 'a.txt'), 'line1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'root']);
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'second']);
  git(dir, ['checkout', '-qb', 'task/feat-x']);
  writeFileSync(join(dir, 'b.txt'), 'feature\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feat']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

describe('§36 five-field evidence — GitRepo.merge (Batch 21-3 re-audit)', needsGit, () => {
  it('merge evidence fields are genuine SHAs and the real diff hash', async () => {
    const dir = makeRepo();
    try {
      const baseBefore = git(dir, ['rev-parse', 'HEAD']);
      const candidate = git(dir, ['rev-parse', 'task/feat-x']);
      const g = new GitRepo(dir);
      const result = await g.merge('task/feat-x');
      assert.equal(result.ok, true);
      const ev = result.evidence;
      assert.ok(ev, 'merge must carry §36 evidence');
      // Base = target tip before the merge, candidate = merged branch tip.
      assert.match(ev!.baseSha ?? '', SHA40);
      assert.equal(ev!.baseSha, baseBefore);
      assert.match(ev!.candidateSha ?? '', SHA40);
      assert.equal(ev!.candidateSha, candidate);
      // Target = the new merge commit on the target branch.
      const headAfter = git(dir, ['rev-parse', 'HEAD']);
      assert.match(ev!.targetSha ?? '', SHA40);
      assert.equal(ev!.targetSha, headAfter);
      // Diff hash = sha256 of the actual landed diff, not a placeholder:
      // recompute it independently and demand equality. NOTE: the diff
      // text must NOT be trimmed — GitRepo hashes the raw stdout, and a
      // trimmed recomputation would hash different bytes (caught once).
      const diffText = execFileSync('git', ['-C', dir, 'diff', baseBefore, headAfter], {
        encoding: 'utf8',
      });
      const expected = createHash('sha256').update(diffText).digest('hex');
      assert.match(ev!.diffHash ?? '', SHA64);
      assert.equal(ev!.diffHash, expected);
      // A merge produces no build artifact: recorded missing, not invented.
      assert.equal(ev!.artifactDigest, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mergeEvidencePayload carries the five fields when given', () => {
    const store = new PrStore();
    const pr = store.create({
      taskId: 't1',
      sourceBranch: 'task/feat-x',
      targetBranch: 'main',
      title: 'X',
      commits: ['c1'],
      createdBy: 'agent',
    });
    const fields = {
      baseSha: 'a'.repeat(40),
      candidateSha: 'b'.repeat(40),
      targetSha: 'c'.repeat(40),
      diffHash: 'd'.repeat(64),
      artifactDigest: null,
    };
    const r = mergeEvidencePayload(pr, fields);
    assert.equal(r.type, 'merge');
    assert.equal(r.payload.baseSha, 'a'.repeat(40));
    assert.equal(r.payload.candidateSha, 'b'.repeat(40));
    assert.equal(r.payload.targetSha, 'c'.repeat(40));
    assert.equal(r.payload.diffHash, 'd'.repeat(64));
    assert.equal(r.payload.artifactDigest, null);
    assert.equal(r.payload.artifactNote, 'no artifact');
  });

  it('mergeEvidencePayload without fields yields nulls — legacy, not backfilled', () => {
    const store = new PrStore();
    const pr = store.create({
      taskId: 't1',
      sourceBranch: 'task/feat-x',
      targetBranch: 'main',
      title: 'X',
      commits: ['c1'],
      createdBy: 'agent',
    });
    const r = mergeEvidencePayload(pr);
    assert.deepEqual(
      {
        baseSha: r.payload.baseSha,
        candidateSha: r.payload.candidateSha,
        targetSha: r.payload.targetSha,
        diffHash: r.payload.diffHash,
        artifactDigest: r.payload.artifactDigest,
      },
      changeEvidenceFields({}),
      'old merge evidence stays honestly incomplete, not invented',
    );
  });
});

describe('§36 five-field evidence — commit / code_change (Batch 21-3 re-audit)', needsGit, () => {
  it('log() populates all five fields; root commit has null baseSha', async () => {
    const dir = makeRepo();
    try {
      const g = new GitRepo(dir);
      const entries = await g.log(10);
      assert.ok(entries.length >= 2, `main should have ≥2 commits, got ${entries.length}`);
      for (const e of entries) {
        const p = codeChangeEvidencePayload(e);
        assert.match(String(p.payload.candidateSha), SHA40, 'candidate = the commit itself');
        assert.match(String(p.payload.targetSha), SHA40, 'target = current HEAD');
        assert.match(String(p.payload.diffHash), SHA64, 'diffHash = sha256 of the diff');
        assert.equal(p.payload.artifactDigest, null);
        assert.equal(p.payload.artifactNote, 'no artifact');
      }
      const root = entries[entries.length - 1];
      assert.equal(root.baseSha, null, 'root commit has no parent to diff against');
      const tip = entries[0];
      assert.match(String(tip.baseSha), SHA40, 'non-root commit has a real base');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
