/**
 * @ai-factory/knowledge — AI Knowledge Scout pipeline (spec §44).
 *
 * Stage machine:
 *   collect → normalize → compare → verify → evaluate → proposal
 *
 * IRON RULES (hardened v2):
 *  1. The scout NEVER mutates running employee/skill/policy objects. It
 *     only reads them (compare stage) and emits PROPOSAL CANDIDATES.
 *     Handlers receive immutable snapshots; the artifact is built by
 *     copying, never by mutating the candidate. A test snapshots live
 *     objects byte-for-byte before/after a run and asserts zero drift.
 *  2. The scout has an INDEPENDENT budget (spec: "Scout 有独立预算，
 *     P4 调度，不挤占 P0 和用户任务"). Collection consumes budget; when
 *     the budget is exhausted the scout STOPS COLLECTING and aborts the
 *     run with SCOUT_BUDGET_EXHAUSTED instead of dipping into other
 *     pools.
 *
 * Each stage is a handler that can be INJECTED (real fetchers/verifiers are
 * wired in later by the caller); defaults are deterministic and offline.
 * Hooks fire around every stage (onStageStart / onStageComplete / onStageError).
 * A failed stage can be retried (`retry` counts) or skipped (`skip` list);
 * every attempt is recorded in the run log.
 */
import type { Clock, KnowledgeItem, KnowledgeScope, KnowledgeSource } from './types';
import { systemClock } from './types';
import { ScoutError } from './types';
import { verificationThreshold } from './sources';
import type { KnowledgeStore } from './store';

/** The §44 scout pipeline, in spec order. */
export const SCOUT_STAGES = [
  'collect',
  'normalize',
  'compare',
  'verify',
  'evaluate',
  'proposal',
] as const;

export type ScoutStage = (typeof SCOUT_STAGES)[number];

/** Input candidate knowledge for the scout. */
export interface ScoutCandidate {
  title: string;
  rawContent: string;
  topic: string;
  tags?: string[];
  source: KnowledgeSource;
  scope: KnowledgeScope;
  /** Independent verifications gathered (real verifier injects these). */
  verifications?: VerificationEvidence[];
}

export interface VerificationEvidence {
  method: string;
  verifiedAt: number;
  by: string;
  notes?: string;
}

/** A proposal CANDIDATE the scout produced — data only, never an action. */
export interface ScoutProposal {
  id: string;
  kind: 'knowledge_intake' | 'skill_creation' | 'policy_notice';
  /** Title of the candidate knowledge that motivated this proposal. */
  title: string;
  summary: string;
  /** Snapshot of the normalized candidate content. */
  content: string;
  tags: string[];
  scope: KnowledgeScope;
  /** Snapshot of the source metadata at proposal time. */
  source: KnowledgeSource;
  evaluationScore: number;
  evaluationPassed: boolean;
  duplicateOf: string[];
  proposedBy: 'knowledge-scout';
  proposedAt: number;
  status: 'PROPOSED';
}

/** Artifact accumulated as the scout walks the pipeline. */
export interface ScoutArtifact {
  candidate: ScoutCandidate;
  collectedAt?: number;
  payload?: string;
  normalized?: { title: string; content: string; tags: string[] };
  duplicates: string[];
  evaluation?: { score: number; passed: boolean; evaluatedAt: number; by: string };
  proposal?: ScoutProposal;
}

export type StageStatus = 'ok' | 'failed' | 'skipped';

export interface StageRecord {
  stage: ScoutStage;
  status: StageStatus;
  attempts: number;
  startedAt: number;
  finishedAt: number;
  error?: string;
}

export interface ScoutHooks {
  onStageStart?: (stage: ScoutStage) => void;
  onStageComplete?: (stage: ScoutStage, artifact: ScoutArtifact) => void;
  onStageError?: (stage: ScoutStage, error: Error, attempt: number) => void;
}

export type StageHandler = (
  artifact: ScoutArtifact,
  ctx: StageContext,
) => ScoutArtifact | Promise<ScoutArtifact>;

export interface StageContext {
  clock: Clock;
  store?: KnowledgeStore;
}

/**
 * Independent scout budget [§44]. Collection is the billable step:
 * each collect consumes `costPerCollect` units. The scout stops collecting
 * when the remaining budget cannot cover one more collect — it never
 * borrows from other pools.
 */
export interface ScoutBudget {
  total: number;
  costPerCollect?: number;
}

export interface ScoutRunOptions {
  /** Stage handlers to override (real fetchers plug in here). */
  handlers?: Partial<Record<ScoutStage, StageHandler>>;
  hooks?: ScoutHooks;
  /** Retry counts per stage on failure. */
  retry?: Partial<Record<ScoutStage, number>>;
  /** Stages to skip when they fail (recorded, pipeline continues). */
  skip?: readonly ScoutStage[];
  clock?: Clock;
  store?: KnowledgeStore;
  /** Independent scout budget; defaults to a sane offline allowance. */
  budget?: ScoutBudget;
}

export interface ScoutRunResult {
  artifact: ScoutArtifact;
  records: StageRecord[];
  budget: { total: number; spent: number; exhausted: boolean };
}

/* ------------------------------------------------------------------ */
/* Default (offline, deterministic) stage handlers                     */
/* ------------------------------------------------------------------ */

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

const DEFAULT_COST_PER_COLLECT = 1;

export const defaultHandlers: Record<ScoutStage, StageHandler> = {
  collect: (artifact, ctx) => {
    const c = artifact.candidate;
    if (!c.title.trim()) throw new Error('collect: candidate title is empty');
    if (!c.rawContent.trim()) throw new Error('collect: candidate content is empty');
    if (!c.topic.trim()) throw new Error('collect: candidate topic is empty');
    // Return a COPY — handlers never mutate the candidate in place.
    return {
      ...artifact,
      collectedAt: ctx.clock.now(),
      payload: normalizeText(c.rawContent),
    };
  },

  normalize: (artifact) => {
    const c = artifact.candidate;
    const tags = [...new Set((c.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    return {
      ...artifact,
      normalized: {
        title: normalizeText(c.title),
        content: normalizeText(artifact.payload ?? c.rawContent),
        tags,
      },
    };
  },

  compare: (artifact, ctx) => {
    // Read-only: may READ running items for duplicate detection, never write.
    const title = (artifact.normalized?.title ?? artifact.candidate.title).toLowerCase();
    const duplicates = ctx.store
      ? ctx.store.all().filter((i) => i.title.toLowerCase() === title).map((i) => i.id)
      : [];
    return { ...artifact, duplicates };
  },

  verify: (artifact) => {
    const need = verificationThreshold(artifact.candidate.source.type);
    const have = artifact.candidate.verifications?.length ?? 0;
    if (have < need) {
      throw new Error(
        `verify: source '${artifact.candidate.source.type}' requires ${need} ` +
          `independent verification(s), only ${have} attached.`,
      );
    }
    return artifact;
  },

  evaluate: (artifact, ctx) => {
    // Default rubric: verified + substantive content passes.
    const content = artifact.normalized?.content ?? '';
    const score = Math.min(100, 50 + Math.min(50, Math.floor(content.length / 20)));
    return {
      ...artifact,
      evaluation: { score, passed: score >= 60, evaluatedAt: ctx.clock.now(), by: 'scout-default-rubric' },
    };
  },

  proposal: (artifact, ctx) => {
    // Produces a proposal CANDIDATE only. No mutation of agents/skills/policies.
    const c = artifact.candidate;
    const n = artifact.normalized;
    const ev = artifact.evaluation;
    const proposal: ScoutProposal = {
      id: `scoutprop_${ctx.clock.now()}`,
      kind: artifact.duplicates.length > 0 ? 'knowledge_intake' : 'skill_creation',
      title: n?.title ?? c.title,
      summary: `Scout proposal: candidate "${n?.title ?? c.title}" passed verify+evaluate; ` +
        `awaits lifecycle approval before anything is applied.`,
      content: n?.content ?? c.rawContent,
      tags: [...(n?.tags ?? c.tags ?? [])],
      scope: { ...c.scope },
      source: { ...c.source },
      evaluationScore: ev?.score ?? 0,
      evaluationPassed: ev?.passed ?? false,
      duplicateOf: [...artifact.duplicates],
      proposedBy: 'knowledge-scout',
      proposedAt: ctx.clock.now(),
      status: 'PROPOSED',
    };
    return { ...artifact, proposal };
  },
};

/* ------------------------------------------------------------------ */
/* The scout runner                                                    */
/* ------------------------------------------------------------------ */

export class KnowledgeScout {
  private readonly clock: Clock;

  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  async run(candidate: ScoutCandidate, opts: ScoutRunOptions = {}): Promise<ScoutRunResult> {
    const clock = opts.clock ?? this.clock;
    const hooks = opts.hooks ?? {};
    const ctx: StageContext = { clock, store: opts.store };

    const budgetTotal = opts.budget?.total ?? 1000;
    const costPerCollect = opts.budget?.costPerCollect ?? DEFAULT_COST_PER_COLLECT;
    let spent = 0;

    let artifact: ScoutArtifact = {
      // Deep-copy the candidate at intake so the scout can never mutate the caller's object.
      candidate: {
        ...candidate,
        tags: [...(candidate.tags ?? [])],
        source: { ...candidate.source },
        scope: { ...candidate.scope },
        verifications: candidate.verifications?.map((v) => ({ ...v })),
      },
      duplicates: [],
    };
    const records: StageRecord[] = [];

    for (const stage of SCOUT_STAGES) {
      // Budget gate: collect is billable. Exhausted budget stops collection.
      if (stage === 'collect') {
        if (spent + costPerCollect > budgetTotal) {
          const record: StageRecord = {
            stage,
            status: 'failed',
            attempts: 0,
            startedAt: clock.now(),
            finishedAt: clock.now(),
            error:
              `scout budget exhausted: total=${budgetTotal} spent=${spent} ` +
              `costPerCollect=${costPerCollect} — stopping collection instead of ` +
              'borrowing from other pools.',
          };
          records.push(record);
          throw new ScoutError(
            record.error!,
            stage,
            records,
            'SCOUT_BUDGET_EXHAUSTED',
          );
        }
        spent += costPerCollect;
      }

      const handler = opts.handlers?.[stage] ?? defaultHandlers[stage];
      const maxRetries = opts.retry?.[stage] ?? 0;
      const record: StageRecord = {
        stage,
        status: 'failed',
        attempts: 0,
        startedAt: clock.now(),
        finishedAt: 0,
      };

      hooks.onStageStart?.(stage);
      let succeeded = false;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        record.attempts = attempt + 1;
        try {
          artifact = await handler(artifact, ctx);
          succeeded = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          hooks.onStageError?.(stage, lastError, attempt + 1);
        }
      }

      record.finishedAt = clock.now();
      if (succeeded) {
        record.status = 'ok';
        hooks.onStageComplete?.(stage, artifact);
      } else if (opts.skip?.includes(stage)) {
        record.status = 'skipped';
        record.error = lastError?.message;
        hooks.onStageComplete?.(stage, artifact);
      } else {
        record.error = lastError?.message;
        records.push(record);
        throw new ScoutError(
          `Scout stage '${stage}' failed after ${record.attempts} attempt(s): ${lastError?.message}. ` +
            'Retry with { retry: { [stage]: n } } or skip with { skip: [stage] }.',
          stage,
          records,
        );
      }
      records.push(record);
    }

    return {
      artifact,
      records,
      budget: { total: budgetTotal, spent, exhausted: spent >= budgetTotal },
    };
  }
}
