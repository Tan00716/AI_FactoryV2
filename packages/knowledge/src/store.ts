/**
 * @ai-factory/knowledge — in-memory knowledge store (spec §50–§53).
 *
 * Combines hierarchical fallback queries (§50), the lifecycle state machine
 * (§53), and the publish pipeline (§53): items are added as DISCOVERED and
 * can only reach ACTIVE through the gated transitions. Publication returns
 * proposal/notice objects and never mutates agents.
 */
import { randomUUID } from 'node:crypto';
import { matchScope, queryKnowledge, type QueryOptions } from './hierarchy';
import {
  transitionItem,
  type TransitionEvidence,
  type TransitionOptions,
} from './lifecycle';
import { decideProposal, publish, type AppliedRecord, type PublishNotice, type SkillProposal } from './promotion';
import type {
  Clock,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSource,
  LifecycleState,
  LifecycleTransition,
  QueryContext,
  QueryHit,
} from './types';
import { systemClock } from './types';

export interface NewKnowledgeInput {
  title: string;
  content: string;
  tags?: string[];
  scope: KnowledgeScope;
  source: KnowledgeSource;
  /** Initial state; must be DISCOVERED or UNVERIFIED. Default DISCOVERED. */
  initialState?: 'DISCOVERED' | 'UNVERIFIED';
}

export class KnowledgeStore {
  private readonly clock: Clock;
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly transitions = new Map<string, LifecycleTransition[]>();

  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  /** Add a candidate item as DISCOVERED (or UNVERIFIED). */
  add(input: NewKnowledgeInput): KnowledgeItem {
    const now = this.clock.now();
    const item: KnowledgeItem = {
      id: `know_${randomUUID()}`,
      title: input.title,
      content: input.content,
      tags: [...(input.tags ?? [])],
      scope: { ...input.scope },
      source: { ...input.source },
      state: input.initialState ?? 'DISCOVERED',
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.items.set(item.id, item);
    this.transitions.set(item.id, []);
    return item;
  }

  get(id: string): KnowledgeItem | undefined {
    return this.items.get(id);
  }

  all(): KnowledgeItem[] {
    return [...this.items.values()];
  }

  /** Full transition history for an item, oldest first. */
  history(id: string): LifecycleTransition[] {
    return [...(this.transitions.get(id) ?? [])];
  }

  /**
   * Advance an item's lifecycle. Illegal transitions throw LifecycleError
   * with the reason; every success is logged with timestamp + actor.
   */
  transition(
    id: string,
    to: LifecycleState,
    opts: Omit<TransitionOptions, 'clock'>,
  ): { item: KnowledgeItem; transition: LifecycleTransition } {
    const item = this.items.get(id);
    if (!item) throw new Error(`Knowledge item not found: ${id}`);
    const result = transitionItem(item, to, { ...opts, clock: this.clock });
    this.items.set(id, result.item);
    this.transitions.get(id)?.push(result.transition);
    return result;
  }

  /** Hierarchical query with scope fallback [§50]. */
  query(ctx: QueryContext, opts: QueryOptions = {}): QueryHit[] {
    return queryKnowledge(this.all(), ctx, opts);
  }

  /** Does this item match the caller's scope chain? */
  matches(id: string, ctx: QueryContext): boolean {
    const item = this.items.get(id);
    return item ? matchScope(item, ctx) !== null : false;
  }

  /**
   * Publish an APPROVED item: returns { proposal, notice } only.
   * Does NOT modify any agent or skill — application is external.
   */
  publishForPromotion(
    id: string,
    opts: { actor: string; skillId: string; summary?: string },
  ): { proposal: SkillProposal; notice: PublishNotice } {
    const item = this.items.get(id);
    if (!item) throw new Error(`Knowledge item not found: ${id}`);
    return publish(item, { ...opts, clock: this.clock });
  }

  /** Record an external approval decision on a proposal. */
  decideProposal(
    proposal: SkillProposal,
    decision: 'APPROVED' | 'REJECTED',
    decidedBy: string,
  ): SkillProposal {
    return decideProposal(proposal, decision, decidedBy, this.clock);
  }

  /**
   * Drive an item all the way to ACTIVE through the full gated chain.
   * Convenience for tests/demo; each gate is still enforced.
   */
  promoteToActive(
    id: string,
    actor: string,
    evidence: TransitionEvidence,
    applier: (proposal: SkillProposal) => AppliedRecord,
    skillId = 'external-skill-registry',
  ): { item: KnowledgeItem; applied: AppliedRecord; notice: PublishNotice } {
    let item = this.get(id);
    if (!item) throw new Error(`Knowledge item not found: ${id}`);

    if (item.state === 'DISCOVERED') {
      item = this.transition(id, 'UNVERIFIED', { actor, note: 'scout intake' }).item;
    }
    this.transition(id, 'VALIDATED', { actor, evidence });
    this.transition(id, 'EVALUATED', { actor, evidence });
    this.transition(id, 'APPROVED', { actor, evidence });
    const { proposal, notice } = this.publishForPromotion(id, { actor, skillId });
    const decided = this.decideProposal(proposal, 'APPROVED', evidence.approval?.by ?? actor);
    const applied = applier(decided);
    const final = this.transition(id, 'ACTIVE', {
      actor,
      evidence: { appliedProposalId: applied.proposalId },
      note: 'published via externally approved proposal',
    });
    return { item: final.item, applied, notice };
  }
}
