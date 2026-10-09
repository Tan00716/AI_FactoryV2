/**
 * Evidence payloads for the git engine — spec §42.
 * Commits and PR merges attach machine-readable evidence so workflow gates
 * (§12) can require proof of a code change / merge before advancing.
 */

import { randomUUID } from 'crypto';
import type { EvidenceType } from '@ai-factory/core';

/** Log entry captured at commit time (see GitRepo.commit / log). */
export interface CodeChangeLogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Payload for EvidenceType 'code_change' (§42).
 * `logEntry` is the {sha,message,author,date} tuple from a fresh commit.
 */
export function codeChangeEvidencePayload(logEntry: CodeChangeLogEntry): {
  type: Extract<EvidenceType, 'code_change'>;
  payload: Record<string, unknown>;
} {
  return {
    type: 'code_change',
    payload: {
      sha: logEntry.sha,
      message: logEntry.message,
      author: logEntry.author,
      date: logEntry.date,
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

/** In-memory PR store (prototype; a real implementation persists via @ai-factory/db). */
export class PrStore {
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
