/**
 * Local review archive (round-7 task R7-#6) — the v1 answer to "PR diff
 * read-only review (comments archived locally)".
 *
 * Local comments are stored under <data>/prlink/reviews.json (atomic
 * write, fail-closed on corrupt content). They are never sent to any
 * remote: the only remote write in this feature is the separately
 * gated POST /api/prlink/write/comment.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrLinkError, type LocalReview } from './types';
import { validateNumber, validateRepoSlug } from './refs';

const MAX_REVIEWS = 500;
const MAX_BODY_CHARS = 8000;

interface StoreFile {
  version: 1;
  reviews: LocalReview[];
}

function storePath(dataDir: string): string {
  return join(dataDir, 'prlink', 'reviews.json');
}

export function loadLocalReviews(dataDir: string): LocalReview[] {
  const p = storePath(dataDir);
  if (!existsSync(p)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as StoreFile).version !== 1 ||
      !Array.isArray((parsed as StoreFile).reviews)
    ) {
      throw new Error('unexpected shape');
    }
    return (parsed as StoreFile).reviews;
  } catch (e) {
    throw new PrLinkError('corrupt-store', `prlink review store is corrupt, refusing to overwrite: ${(e as Error).message}`);
  }
}

function saveLocalReviews(dataDir: string, reviews: LocalReview[]): void {
  const dir = join(dataDir, 'prlink');
  mkdirSync(dir, { recursive: true });
  const p = storePath(dataDir);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, reviews }, null, 2), 'utf8');
  renameSync(tmp, p);
}

export function addLocalReview(
  dataDir: string,
  input: { repo: string; number: number; file?: string; line?: number; body: string; author: string },
): LocalReview {
  validateRepoSlug(input.repo);
  validateNumber(input.number);
  const body = input.body.trim();
  if (!body) throw new PrLinkError('bad-reference', 'review body is required');
  if (body.length > MAX_BODY_CHARS) throw new PrLinkError('too-large', `review body exceeds ${MAX_BODY_CHARS} chars`);
  if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) {
    throw new PrLinkError('bad-reference', 'review line must be a positive integer');
  }
  const reviews = loadLocalReviews(dataDir);
  if (reviews.length >= MAX_REVIEWS) throw new PrLinkError('too-many', `local review archive is full (${MAX_REVIEWS})`);
  const review: LocalReview = {
    id: randomUUID(),
    repo: input.repo,
    number: input.number,
    ...(input.file ? { file: input.file } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    body,
    author: input.author || 'operator',
    createdAt: Date.now(),
  };
  reviews.push(review);
  saveLocalReviews(dataDir, reviews);
  return review;
}

export function listLocalReviews(dataDir: string, repo: string, number: number): LocalReview[] {
  validateRepoSlug(repo);
  validateNumber(number);
  return loadLocalReviews(dataDir).filter((r) => r.repo === repo && r.number === number);
}
