/**
 * @ai-factory/knowledge — promotion policy (spec §53).
 *
 * A new technique must NOT automatically rewrite all agents. It must first
 * pass evaluation. Publication NEVER mutates agent state directly:
 *
 *   publish()      → { proposal, notice }   (pure data, no side effects)
 *   approveProposal() → recorded approval decision (external)
 *   applyProposal()   → invokes an EXTERNAL applier supplied by the caller;
 *                       the package itself has no way to touch agents.
 *
 * Becoming ACTIVE requires evidence that a proposal went through this
 * publish → approve → apply chain (see lifecycle.ts gate).
 */
import { randomUUID } from 'node:crypto';
import type { Clock, KnowledgeItem } from './types';
import { systemClock } from './types';

export type SkillProposalKind = 'create' | 'update';

/**
 * A proposal to create or update a skill from a knowledge item.
 * Carries everything an external approver needs — and nothing that can
 * silently rewrite an agent.
 */
export interface SkillProposal {
  id: string;
  kind: SkillProposalKind;
  itemId: string;
  itemTitle: string;
  /** Target skill identifier (external registry). */
  skillId: string;
  summary: string;
  proposedBy: string;
  proposedAt: number;
  /** Proposal status — the package never applies without approval. */
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decidedBy?: string;
  decidedAt?: number;
}

/** Human-readable notice emitted alongside a proposal. */
export interface PublishNotice {
  id: string;
  proposalId: string;
  itemId: string;
  itemTitle: string;
  state: string;
  publishedAt: number;
  publishedBy: string;
  message: string;
}

export interface PublishOptions {
  actor: string;
  skillId: string;
  kind?: SkillProposalKind;
  summary?: string;
  clock?: Clock;
}

/**
 * Publish a knowledge item for promotion. Returns proposal + notice.
 * PURE: does not touch any agent, skill registry, or external state.
 * The item must already be APPROVED.
 */
export function publish(
  item: KnowledgeItem,
  opts: PublishOptions,
): { proposal: SkillProposal; notice: PublishNotice } {
  if (item.state !== 'APPROVED') {
    throw new Error(
      `Cannot publish knowledge item ${item.id}: state is ${item.state}, must be APPROVED. ` +
        'New knowledge must pass evaluation and approval before publication.',
    );
  }
  const clock = opts.clock ?? systemClock;
  const now = clock.now();
  const proposal: SkillProposal = {
    id: `prop_${randomUUID()}`,
    kind: opts.kind ?? 'create',
    itemId: item.id,
    itemTitle: item.title,
    skillId: opts.skillId,
    summary:
      opts.summary ??
      `Promote knowledge "${item.title}" (source: ${item.source.type}) into skill ${opts.skillId}.`,
    proposedBy: opts.actor,
    proposedAt: now,
    status: 'PENDING',
  };
  const notice: PublishNotice = {
    id: `notice_${randomUUID()}`,
    proposalId: proposal.id,
    itemId: item.id,
    itemTitle: item.title,
    state: item.state,
    publishedAt: now,
    publishedBy: opts.actor,
    message:
      `Knowledge "${item.title}" proposed for skill ${opts.skillId}. ` +
      'Awaiting external approval — no agent was modified by this publication.',
  };
  return { proposal, notice };
}

/** Record an external approval decision on a proposal (immutable update). */
export function decideProposal(
  proposal: SkillProposal,
  decision: 'APPROVED' | 'REJECTED',
  decidedBy: string,
  clock: Clock = systemClock,
): SkillProposal {
  if (proposal.status !== 'PENDING') {
    throw new Error(
      `Proposal ${proposal.id} already decided (${proposal.status}); cannot decide again.`,
    );
  }
  return {
    ...proposal,
    status: decision,
    decidedBy,
    decidedAt: clock.now(),
  };
}

/** The external applier: only the CALLER can mutate agents/skills. */
export type ExternalApplier = (proposal: SkillProposal) => void;

export interface AppliedRecord {
  proposalId: string;
  itemId: string;
  appliedAt: number;
  appliedBy: string;
}

/**
 * Apply an approved proposal through an external applier provided by the
 * caller. The package itself never mutates agent state — the applier does,
 * and it lives outside this package.
 */
export function applyProposal(
  proposal: SkillProposal,
  applier: ExternalApplier,
  appliedBy: string,
  clock: Clock = systemClock,
): AppliedRecord {
  if (proposal.status !== 'APPROVED') {
    throw new Error(
      `Cannot apply proposal ${proposal.id}: status is ${proposal.status}, must be APPROVED. ` +
        'Unapproved knowledge must never be applied to agents.',
    );
  }
  applier(proposal);
  return {
    proposalId: proposal.id,
    itemId: proposal.itemId,
    appliedAt: clock.now(),
    appliedBy,
  };
}
