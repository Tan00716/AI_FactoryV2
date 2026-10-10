/**
 * @ai-factory/knowledge — AI Knowledge Scout pipeline (spec §52).
 *
 * Stage machine:
 *   discover → collect → verify → normalize → compare → evaluate →
 *   store → skill_proposal → publish
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
import type { SkillProposal } from './promotion';
import type { KnowledgeStore } from './store';

export const SCOUT_STAGES = [
  'discover',
  'collect',
  'verify',
  'normalize',
  'compare',
  'evaluate',
  'store',
  'skill_proposal',
  'publish',
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

/** Artifact accumulated as the scout walks the pipeline. */
export interface ScoutArtifact {
  candidate: ScoutCandidate;
  discoveredAt?: number;
  collectedAt?: number;
  payload?: string;
  normalized?: { title: string; content: string; tags: string[] };
  duplicates: string[];
  evaluation?: { score: number; passed: boolean; evaluatedAt: number; by: string };
  storedItem?: KnowledgeItem;
  proposal?: SkillProposal;
  published?: boolean;
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
  skillId?: string;
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
  skillId?: string;
}

export interface ScoutRunResult {
  artifact: ScoutArtifact;
  records: StageRecord[];
}

/* ------------------------------------------------------------------ */
/* Default (offline, deterministic) stage handlers                     */
/* ------------------------------------------------------------------ */

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export const defaultHandlers: Record<ScoutStage, StageHandler> = {
  discover: (artifact, ctx) => {
    const c = artifact.candidate;
    if (!c.title.trim()) throw new Error('discover: candidate title is empty');
    if (!c.rawContent.trim()) throw new Error('discover: candidate content is empty');
    if (!c.topic.trim()) throw new Error('discover: candidate topic is empty');
    return { ...artifact, discoveredAt: ctx.clock.now() };
  },

  collect: (artifact, ctx) => ({
    ...artifact,
    collectedAt: ctx.clock.now(),
    payload: normalizeText(artifact.candidate.rawContent),
  }),

  verify: (artifact, ctx) => {
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
    const title = (artifact.normalized?.title ?? artifact.candidate.title).toLowerCase();
    const duplicates = ctx.store
      ? ctx.store.all().filter((i) => i.title.toLowerCase() === title).map((i) => i.id)
      : [];
    return { ...artifact, duplicates };
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

  store: (artifact, ctx) => {
    if (!ctx.store) return artifact;
    const c = artifact.candidate;
    const n = artifact.normalized;
    const item = ctx.store.add({
      title: n?.title ?? c.title,
      content: n?.content ?? c.rawContent,
      tags: n?.tags ?? c.tags ?? [],
      scope: c.scope,
      source: c.source,
    });
    return { ...artifact, storedItem: item };
  },

  skill_proposal: (artifact) => {
    const item = artifact.storedItem;
    if (!item) return artifact;
    const proposal: SkillProposal = {
      id: `scout_${item.id}`,
      kind: 'create',
      itemId: item.id,
      itemTitle: item.title,
      skillId: 'pending',
      summary: `Scout draft: promote "${item.title}" after lifecycle approval.`,
      proposedBy: 'knowledge-scout',
      proposedAt: Date.now(),
      status: 'PENDING',
    };
    return { ...artifact, proposal };
  },

  publish: (artifact) => ({ ...artifact, published: true }),
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
    const ctx: StageContext = { clock, store: opts.store, skillId: opts.skillId };

    let artifact: ScoutArtifact = { candidate, duplicates: [] };
    const records: StageRecord[] = [];

    for (const stage of SCOUT_STAGES) {
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

    return { artifact, records };
  }
}
