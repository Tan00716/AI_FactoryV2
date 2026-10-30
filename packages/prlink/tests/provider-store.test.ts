import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureProvider } from '../src/provider';
import { addLocalReview, listLocalReviews, loadLocalReviews } from '../src/store';
import { PrLinkError } from '../src/types';

const FIXTURE = {
  items: [
    {
      kind: 'pull', number: 42, repo: 'owner/repo', title: 'Add login', state: 'open',
      author: 'alice', url: 'https://example.invalid/owner/repo/pull/42', labels: ['feat'],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
      bodyExcerpt: 'Implements login.', headSha: 'abc123',
    },
    {
      kind: 'issue', number: 7, repo: 'owner/repo', title: 'Login broken', state: 'closed',
      author: 'bob', url: 'https://example.invalid/owner/repo/issues/7', labels: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', bodyExcerpt: 'It broke.',
    },
  ],
  reviews: { 'owner/repo#42': [{ author: 'carol', state: 'APPROVED', submittedAt: '2026-01-02T00:00:00Z', bodyExcerpt: 'LGTM' }] },
  checks: { 'owner/repo#42': [{ name: 'ci', status: 'completed', conclusion: 'success', url: 'https://example.invalid/ci' }] },
};

test('fixture provider resolves linked items and detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aif-prlink-fix-'));
  try {
    const file = join(dir, 'fixture.json');
    writeFileSync(file, JSON.stringify(FIXTURE), 'utf8');
    const p = new FixtureProvider(file);
    assert.equal(p.name, 'fixture');
    const items = await p.listLinked('owner/repo', [42, 7, 999]);
    assert.deepEqual(items.map((i) => i.number), [42, 7]);
    const detail = await p.getDetail('owner/repo', 42);
    assert.equal(detail.item.kind, 'pull');
    assert.equal(detail.reviews.length, 1);
    assert.equal(detail.checks[0]?.conclusion, 'success');
    await assert.rejects(() => p.getDetail('owner/repo', 999), PrLinkError);
    await assert.rejects(() => p.postComment('owner/repo', 42, 'hi'), PrLinkError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local review archive round-trips and caps body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aif-prlink-store-'));
  try {
    assert.deepEqual(loadLocalReviews(dir), []);
    const r = addLocalReview(dir, { repo: 'owner/repo', number: 42, file: 'a.ts', line: 10, body: 'nit: rename', author: 'op' });
    assert.equal(r.file, 'a.ts');
    assert.equal(listLocalReviews(dir, 'owner/repo', 42).length, 1);
    assert.equal(listLocalReviews(dir, 'owner/repo', 7).length, 0);
    assert.throws(
      () => addLocalReview(dir, { repo: 'owner/repo', number: 42, body: 'x'.repeat(8001), author: 'op' }),
      (e: unknown) => e instanceof PrLinkError && e.code === 'too-large',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
