/**
 * Deterministic model routing — spec §30, honoring §29 (shared ChatGPT plan pool).
 *
 * Rules, applied in order:
 *  1. Hard constraints filter the catalog: privacy=sensitive → local models
 *     only; needsVision → vision-capable only; requiredTools → tool-capable
 *     only; contextNeeded → models with a large enough context window;
 *     availability=offline → never eligible (INV-29); availability=degraded
 *     stays eligible but is deprioritized and named in the reason. When nothing survives,
 *     route() returns unavailable=true with an explicit report instead of
 *     silently degrading to an unsuitable model.
 *  2. If the shared pool is exhausted (currentUsage.usedPct >=
 *     POOL_EXHAUSTED_PCT), non-local models are deprioritized: the primary is
 *     chosen from local models when any survive the hard filters, because the
 *     5h pool is SHARED across agents — the router must not assume per-agent
 *     headroom (§29).
 *  3. Remaining candidates are scored deterministically (stable sort, so ties
 *     break by catalog order): task-type fit, reasoning need, complexity,
 *     latency/cost preferences.
 *  4. fallback = next-best candidate that passes the request's injected
 *     fallback-compatibility checker (§27.2), when one is supplied:
 *     incompatible candidates are skipped in score order, and if none is
 *     compatible the fallback is null with the rejection count in the
 *     reason — never an incompatible silent pick. With no checker
 *     injected the fallback is the next-best candidate unchecked, and
 *     the reason says so. emergency = local-private when eligible, else
 *     fast-classifier, else the last-resort candidate.
 *
 * `reason` records every rule that fired so the decision is auditable.
 */
import { CONTEXT_RANK, MODEL_CATALOG, POOL_EXHAUSTED_PCT } from './catalog';
import type { ContextSize, ModelRef, RouteDecision, RouteRequest, TaskType } from './types';

/** Natural best-fit model per task type (§30 examples). */
const TASK_FIT: Record<TaskType, string> = {
  classification: 'fast-classifier',
  coding: 'code-coder',
  architecture: 'reasoning-architect',
  vision: 'vision-capable',
  testing: 'code-coder',
  review: 'code-coder',
  research: 'reasoning-architect',
};

function satisfiesHardConstraints(m: ModelRef, req: RouteRequest): boolean {
  // INV-29: an offline model is never eligible — not as primary, not as a
  // silent fallback. Unavailability is reported explicitly by route().
  if (m.availability === 'offline') return false;
  if (req.privacy === 'sensitive' && m.provider !== 'local') return false;
  if (req.needsVision && !m.capabilities.vision) return false;
  if (req.requiredTools.length > 0 && !m.capabilities.tools) return false;
  if (CONTEXT_RANK[m.capabilities.maxContext] < CONTEXT_RANK[req.contextNeeded]) return false;
  return true;
}

function scoreModel(m: ModelRef, req: RouteRequest): { score: number; why: string[] } {
  let score = 0;
  const why: string[] = [];
  if (m.availability === 'degraded') {
    // INV-29 reporting: degraded is NOT offline — the model stays eligible
    // (excluding it would fake unavailability), but it is deprioritized
    // behind an equally-fit online model and the state is named in the
    // decision reason instead of being silently treated as healthy.
    score -= 25;
    why.push('availability=degraded → deprioritized, still eligible (INV-29)');
  }
  if (req.privacy === 'sensitive' && m.provider === 'local') {
    score += 1000;
    why.push('privacy=sensitive → local model (§30)');
  }
  if (TASK_FIT[req.taskType] === m.model) {
    score += 120;
    why.push(`taskType=${req.taskType} → ${m.model} (§30)`);
  }
  if (req.needsReasoning && m.capabilities.reasoning) {
    score += 60;
    why.push('needsReasoning → reasoning-capable model');
  }
  if (req.complexity >= 4 && m.capabilities.reasoning) {
    score += 50;
    why.push(`complexity=${req.complexity} → reasoning-capable model`);
  }
  if (req.complexity <= 2 && req.taskType === 'classification' && m.latencyTier === 'low' && m.costTier === 'low') {
    score += 40;
    why.push('simple classification → fast, cheap model (§30)');
  }
  if (req.latencyPref === 'low' && m.latencyTier === 'low') {
    score += 20;
    why.push('latencyPref=low');
  }
  if (req.costPref === 'low' && m.costTier === 'low') {
    score += 20;
    why.push('costPref=low');
  }
  return { score, why };
}

/** Last-resort model: local first, then fast, then whatever survived. */
function pickEmergency(pool: ModelRef[]): ModelRef {
  return (
    pool.find((m) => m.model === 'local-private') ??
    pool.find((m) => m.model === 'fast-classifier') ??
    pool[pool.length - 1]
  );
}

export function route(
  request: RouteRequest,
  catalog: readonly ModelRef[] = MODEL_CATALOG,
): RouteDecision {
  const reasons: string[] = [];
  const poolExhausted = request.currentUsage.usedPct >= POOL_EXHAUSTED_PCT;

  const eligible = catalog.filter((m) => satisfiesHardConstraints(m, request));
  // INV-29: no silent degradation. When nothing is eligible (e.g. every
  // candidate is offline), report unavailability explicitly instead of
  // routing over the full catalog and pretending a model was chosen.
  if (eligible.length === 0) {
    const offlineCount = catalog.filter((m) => m.availability === 'offline').length;
    const why =
      catalog.length > 0 && offlineCount === catalog.length
        ? `all ${catalog.length} catalog models are offline`
        : `no model satisfied all hard constraints (${offlineCount} of ${catalog.length} offline)`;
    return {
      primary: null,
      fallback: null,
      emergency: null,
      unavailable: true,
      reason: `INV-29: no model available — ${why}; refusing to silently degrade`,
    };
  }
  const pool = eligible;

  // §29: the shared 5h pool is one pool across ALL agents. When exhausted,
  // prefer local models for the primary slot whenever one is eligible.
  let primaryPool = pool;
  if (poolExhausted) {
    const localOnly = pool.filter((m) => m.provider === 'local');
    if (localOnly.length > 0) {
      primaryPool = localOnly;
      reasons.push(
        `shared ChatGPT plan pool exhausted at ${request.currentUsage.usedPct}% — ` +
          'preferring local model for primary (§29); the 5h allowance is shared across agents, not per-agent',
      );
    } else {
      reasons.push(
        `shared ChatGPT plan pool exhausted at ${request.currentUsage.usedPct}% — ` +
          'no eligible local model, using shared-pool model anyway',
      );
    }
  }

  const scored = primaryPool.map((m) => ({ m, ...scoreModel(m, request) }));
  // Stable sort: equal scores keep catalog order → deterministic.
  scored.sort((a, b) => b.score - a.score);

  const primary = scored[0].m;

  // §27.2 — fallback selection. Fail-closed: with a checker injected, an
  // incompatible candidate is never picked silently; candidates are tried
  // in score order and each rejection is named. If every candidate is
  // rejected the fallback is null (better no fallback than a fallback
  // that cannot legally serve: wrong capabilities, wrong data class).
  const rest = scored.slice(1);
  let fallback: ModelRef | null;
  if (!request.fallbackChecker) {
    fallback = rest[0]?.m ?? primary;
    reasons.push('fallback compatibility not checked (no checker injected)');
  } else if (rest.length === 0) {
    fallback = primary;
    reasons.push('fallback=primary (no other eligible candidate to check)');
  } else {
    let checked = 0;
    let rejected = 0;
    const rejectedNotes: string[] = [];
    let picked: ModelRef | null = null;
    for (const s of rest) {
      checked += 1;
      const verdict = request.fallbackChecker(primary, s.m, request);
      if (verdict.compatible) {
        picked = s.m;
        break;
      }
      rejected += 1;
      rejectedNotes.push(`${s.m.model}: ${verdict.reasons.join('; ') || 'incompatible'}`);
    }
    if (picked) {
      fallback = picked;
      reasons.push(
        rejected > 0
          ? `fallback compatibility: skipped ${rejected} incompatible candidate(s) [${rejectedNotes.join(' | ')}] (§27.2)`
          : 'fallback compatibility: checked, compatible (§27.2)',
      );
    } else {
      fallback = null;
      reasons.push(
        `fallback: none compatible (checked ${checked}, rejected ${rejected}) [${rejectedNotes.join(' | ')}] (§27.2)`,
      );
    }
  }
  const emergency = pickEmergency(pool);

  reasons.unshift(
    `primary=${primary.model} [${scored[0].why.join(', ') || 'best available'}]`,
    `fallback=${fallback?.model ?? 'none'}`,
    `emergency=${emergency.model}`,
  );

  // INV-29: surface degraded selections in ANY slot, not just primary —
  // a degraded fallback/emergency must not pass as silently healthy.
  const degradedPicks = [primary, fallback, emergency]
    .filter((m): m is ModelRef => m !== null)
    .filter((m, i, arr) => m.availability === 'degraded' && arr.indexOf(m) === i);
  if (degradedPicks.length > 0) {
    reasons.push(
      `availability notice: ${degradedPicks.map((m) => m.model).join(', ')} degraded (INV-29)`,
    );
  }

  return { primary, fallback, emergency, reason: reasons.join(' | '), unavailable: false };
}

export { POOL_EXHAUSTED_PCT };
