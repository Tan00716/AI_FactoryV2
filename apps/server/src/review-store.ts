/**
 * PR review store (W-F) — line comments + review decisions on PR records.
 *
 * PR records themselves live in the durable ctx.fdb.prStore; this store
 * keeps the *review* layer: inline comments and APPROVE / REQUEST_CHANGES
 * / COMMENT decisions per PR.
 *
 * Persistence: JSON file under AI_FACTORY_DATA_DIR (same convention as
 * session-store.ts / plan-store.ts). Atomic temp+rename writes; corrupt
 * file → fail-closed (refuses writes, serves empty).
 *
 * Comment bodies are untrusted external content: callers must pass them
 * through sanitizeUntrusted() before storing (routes/git.ts does this).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ReviewDecision = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  'APPROVE',
  'REQUEST_CHANGES',
  'COMMENT',
];

export interface PrComment {
  id: string;
  prId: string;
  /** File path within the diff; null = PR-level comment. */
  file: string | null;
  /** 1-based new-file line number; null = file/PR-level. */
  line: number | null;
  /** 'new' | 'old' — which side the line refers to (default 'new'). */
  side: 'new' | 'old';
  body: string;
  author: string;
  createdAt: string;
}

export interface PrReview {
  id: string;
  prId: string;
  decision: ReviewDecision;
  summary: string;
  reviewer: string;
  createdAt: string;
}

export class ReviewStoreError extends Error {}

export function reviewStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_REVIEW_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'pr-reviews.json');
}

interface StoreShape {
  comments: PrComment[];
  reviews: PrReview[];
}

function atomicWrite(path: string, payload: StoreShape): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

export class ReviewStore {
  private corrupt = false;
  private comments: PrComment[] = [];
  private reviews: PrReview[] = [];
  private readonly path: string;

  constructor(path: string = reviewStorePath()) {
    this.path = path;
    this.load();
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      if (!Array.isArray(parsed.comments) || !Array.isArray(parsed.reviews)) {
        throw new Error('unexpected shape');
      }
      this.comments = parsed.comments;
      this.reviews = parsed.reviews;
    } catch {
      this.corrupt = true;
      this.comments = [];
      this.reviews = [];
    }
  }

  private save(): void {
    if (this.corrupt) {
      throw new ReviewStoreError('review store is corrupt; refusing writes');
    }
    atomicWrite(this.path, { comments: this.comments, reviews: this.reviews });
  }

  addComment(input: {
    prId: string;
    file?: string | null;
    line?: number | null;
    side?: 'new' | 'old';
    body: string;
    author: string;
  }): PrComment {
    if (!input.prId) throw new ReviewStoreError('prId is required');
    if (!input.body.trim()) throw new ReviewStoreError('comment body must not be empty');
    if (input.body.length > 20_000) throw new ReviewStoreError('comment body too long (20k max)');
    if (input.line !== undefined && input.line !== null) {
      if (!Number.isInteger(input.line) || input.line < 1) {
        throw new ReviewStoreError('line must be a positive integer');
      }
    }
    const comment: PrComment = {
      id: randomUUID(),
      prId: input.prId,
      file: input.file ?? null,
      line: input.line ?? null,
      side: input.side === 'old' ? 'old' : 'new',
      body: input.body,
      author: input.author,
      createdAt: new Date().toISOString(),
    };
    this.comments.push(comment);
    this.save();
    return { ...comment };
  }

  addReview(input: {
    prId: string;
    decision: ReviewDecision;
    summary?: string;
    reviewer: string;
  }): PrReview {
    if (!input.prId) throw new ReviewStoreError('prId is required');
    if (!REVIEW_DECISIONS.includes(input.decision)) {
      throw new ReviewStoreError(`decision must be one of ${REVIEW_DECISIONS.join(', ')}`);
    }
    const review: PrReview = {
      id: randomUUID(),
      prId: input.prId,
      decision: input.decision,
      summary: input.summary ?? '',
      reviewer: input.reviewer,
      createdAt: new Date().toISOString(),
    };
    this.reviews.push(review);
    this.save();
    return { ...review };
  }

  commentsFor(prId: string): PrComment[] {
    return this.comments.filter((c) => c.prId === prId).map((c) => ({ ...c }));
  }

  reviewsFor(prId: string): PrReview[] {
    return this.reviews.filter((r) => r.prId === prId).map((r) => ({ ...r }));
  }

  /** Latest decision per reviewer — the PR's effective review state. */
  reviewState(prId: string): { decision: ReviewDecision; reviewer: string; at: string }[] {
    const latest = new Map<string, PrReview>();
    for (const r of this.reviewsFor(prId)) {
      const prev = latest.get(r.reviewer);
      if (!prev || prev.createdAt <= r.createdAt) latest.set(r.reviewer, r);
    }
    return [...latest.values()].map((r) => ({
      decision: r.decision,
      reviewer: r.reviewer,
      at: r.createdAt,
    }));
  }
}
