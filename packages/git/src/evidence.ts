/**
 * Evidence payloads for the git engine — spec §42.
 * Commits and PR merges attach machine-readable evidence so workflow gates
 * (§12) can require proof of a code change / merge before advancing.
 */

import { randomUUID } from 'crypto';
import type { EvidenceType } from '@ai-factory/core';

/**
 * The five §36 change-evidence fields that MUST be recorded for a code
 * change: Base SHA, Candidate SHA, Target SHA, Diff Hash, Artifact Digest.
 * Every field is nullable — an unrecordable value is recorded as null,
 * never invented.
 */
export interface ChangeEvidenceFields {
  /** Base SHA — parent / branch point the change is measured against. */
  baseSha: string | null;
  /** Candidate SHA — the commit that carries the change. */
  candidateSha: string | null;
  /** Target SHA — the target branch tip the candidate is aimed at / landed on. */
  targetSha: string | null;
  /** Diff Hash — sha256 hex of the base→candidate diff text. */
  diffHash: string | null;
  /** Artifact Digest — digest of the build artifact for this change, if any. */
  artifactDigest: string | null;
}

/** Normalize a partial/legacy entry's §36 fields: missing → null. */
export function changeEvidenceFields(entry: Partial<ChangeEvidenceFields>): ChangeEvidenceFields {
  return {
    baseSha: entry.baseSha ?? null,
    candidateSha: entry.candidateSha ?? null,
    targetSha: entry.targetSha ?? null,
    diffHash: entry.diffHash ?? null,
    artifactDigest: entry.artifactDigest ?? null,
  };
}

/**
 * Log entry captured at commit time (see GitRepo.commit / log).
 * The five §36 fields are optional so entries persisted before they were
 * recorded still type-check and read back; GitRepo.log() populates them.
 */
export interface CodeChangeLogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
  baseSha?: string | null;
  candidateSha?: string | null;
  targetSha?: string | null;
  diffHash?: string | null;
  artifactDigest?: string | null;
}

/**
 * Payload for EvidenceType 'code_change' (§42).
 * `logEntry` is the {sha,message,author,date} tuple from a fresh commit,
 * plus the five §36 fields (Base/Candidate/Target SHA, Diff Hash,
 * Artifact Digest). Legacy entries without them record nulls, not guesses.
 * artifactDigest is null whenever no build artifact exists for the change;
 * the payload then carries `artifactNote: 'no artifact'` saying so.
 */
export function codeChangeEvidencePayload(logEntry: CodeChangeLogEntry): {
  type: Extract<EvidenceType, 'code_change'>;
  payload: Record<string, unknown>;
} {
  const fields = changeEvidenceFields(logEntry);
  return {
    type: 'code_change',
    payload: {
      sha: logEntry.sha,
      message: logEntry.message,
      author: logEntry.author,
      date: logEntry.date,
      baseSha: fields.baseSha,
      candidateSha: fields.candidateSha,
      targetSha: fields.targetSha,
      diffHash: fields.diffHash,
      artifactDigest: fields.artifactDigest,
      ...(fields.artifactDigest === null ? { artifactNote: 'no artifact' } : {}),
    },
  };
}

export type PrStatus = 'OPEN' | 'MERGED' | 'CLOSED';

/** PR record: the in-repo "pull request" for task branch → target merges. */
export interface PrRecord {
  id: string;
  taskId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  status: PrStatus;
  commits: string[];
  createdBy: string;
  createdAt: string;
  mergedAt: string | null;
}

export interface CreatePrInput {
  taskId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  commits?: string[];
  createdBy: string;
}

/**
 * Structural PR-store contract. PrStore (in-memory) implements it;
 * the durable SqlitePrStore in @ai-factory/db matches it structurally
 * (no dependency edge from db to git), so MergeQueue accepts either.
 */
export interface PrStoreApi {
  create(input: CreatePrInput): PrRecord;
  get(id: string): PrRecord;
  list(): PrRecord[];
  updateStatus(id: string, status: PrStatus): PrRecord;
}

/** In-memory PR store (prototype; a real implementation persists via @ai-factory/db). */
export class PrStore implements PrStoreApi {
  private records = new Map<string, PrRecord>();

  create(input: CreatePrInput): PrRecord {
    const pr: PrRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      title: input.title,
      status: 'OPEN',
      commits: [...(input.commits ?? [])],
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      mergedAt: null,
    };
    this.records.set(pr.id, structuredClone(pr));
    return structuredClone(pr);
  }

  get(id: string): PrRecord {
    const pr = this.records.get(id);
    if (!pr) throw new Error(`PR not found: ${id}`);
    return structuredClone(pr);
  }

  list(): PrRecord[] {
    return [...this.records.values()].map((pr) => structuredClone(pr));
  }

  updateStatus(id: string, status: PrStatus): PrRecord {
    const pr = this.records.get(id);
    if (!pr) throw new Error(`PR not found: ${id}`);
    pr.status = status;
    if (status === 'MERGED') pr.mergedAt = new Date().toISOString();
    this.records.set(id, pr);
    return structuredClone(pr);
  }
}

/** Payload for EvidenceType 'merge' (§42), attached when a PR is merged. */
export function mergeEvidencePayload(pr: PrRecord): {
  type: Extract<EvidenceType, 'merge'>;
  payload: Record<string, unknown>;
} {
  return {
    type: 'merge',
    payload: {
      prId: pr.id,
      taskId: pr.taskId,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      title: pr.title,
      commits: [...pr.commits],
      mergedAt: pr.mergedAt,
    },
  };
}
