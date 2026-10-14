/**
 * Requirement routes — SPEC_V2 §16 (lives in @ai-factory/requirements).
 *
 *  POST /api/requirements                        create requirement (VERIFIED_DELIVERY also
 *                                                  requires projectCategory + HUMAN
 *                                                  completionTargetAuthorization, §16 G-03)
 *  GET  /api/requirements/:id                     latest version
 *  GET  /api/requirements/:id/versions/:v        immutable version read
 *  POST /api/requirements/:id/versions           {changeKind, changeNote, patch, humanAuthorization?}
 *                                                  → new version (target/AC-meaning patches need
 *                                                  the HUMAN authorization, §16 G-01/G-02)
 *  POST /api/requirements/:id/links               {version, taskIds?, planIds?, codeRefs?,
 *                                                  testIds?, evidenceIds?, approvalIds?,
 *                                                  releaseIds?} → updated EntityLinks
 *  POST /api/requirements/:id/impact              {fromVersion, toVersion} → impact analysis
 *  POST /api/requirements/:id/ac-refinement       {acId, patch} → refined version
 *  POST /api/requirements/:id/compatibility       {evidenceId, requirementVersion, compatible, basis}
 *  GET  /api/requirements/holds?taskId=           list promotion holds (optionally per task)
 *  POST /api/requirements/holds/:id/release      {by, revalidationNote} → release a hold
 *  POST /api/requirements/promotion-check         {taskId} → 200 {allowed:true} | 409 {allowed:false, holds}
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { RequirementManager } from '@ai-factory/requirements';
import type { EntityLinks, RequirementStore } from '@ai-factory/requirements';
import { needsHuman } from '@ai-factory/autonomy';
import type { NeedsHumanDbRecord } from '@ai-factory/db';
import type { RouteContext } from './context';

let manager = new RequirementManager();

/**
 * Back the shared manager with a durable RequirementStore (§16, F2).
 * Called exactly once from apps/server/src/index.ts at startup, BEFORE
 * the server accepts requests: the default in-memory manager is
 * replaced by one hydrated from the store, so requirement versions,
 * compatibility declarations, promotion holds and entity links
 * survive restarts. Every consumer reads the manager through
 * getRequirementManager() per request, so the swap is safe.
 */
export function initRequirementManager(store: RequirementStore): RequirementManager {
  manager = new RequirementManager({ store });
  return manager;
}

/**
 * The shared process-wide manager — the same instance the routes above
 * write to (including POST /:id/compatibility declarations). Other route
 * modules (v2-transitions) read compatibility declarations from here so
 * there is exactly one declaration store per server process.
 */
export function getRequirementManager(): RequirementManager {
  return manager;
}

export async function handleRequirementRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/requirements')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/requirements'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 0) {
    const body = await ctx.readBody(req);
    try {
      const r = manager.create({
        id: body['id'] as string | undefined,
        businessGoal: body['businessGoal'] as string,
        rationale: body['rationale'] as string | undefined,
        // §16 G-03 (Batch 4): VERIFIED_DELIVERY declarations must carry
        // an eligible projectCategory + a HUMAN completionTargetAuthorization;
        // the manager rejects the create (400) when they are missing.
        projectCategory: body['projectCategory'] as never,
        completionTargetAuthorization: body['completionTargetAuthorization'] as never,
        acceptanceCriteria: body['acceptanceCriteria'] as never,
        exclusions: body['exclusions'] as string[] | undefined,
        constraints: body['constraints'] as string[] | undefined,
        completionTarget: body['completionTarget'] as never,
        environments: body['environments'] as string[] | undefined,
        outcomeMeasurement: body['outcomeMeasurement'] as string | undefined,
        releaseNaAuthorization: body['releaseNaAuthorization'] as never,
        createdBy: (body['createdBy'] as string | undefined) ?? 'api',
      });
      ctx.audit.record('api', 'REQUIREMENT_CREATED', 'requirement', r.id, {});
      ctx.json(res, 201, { requirement: r });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // Promotion-hold routes (§16 G-05) — MUST precede the generic
  // GET /api/requirements/:id handler below, or 'holds' would be read
  // as a requirement id.
  if (method === 'GET' && seg.length === 1 && seg[0] === 'holds') {
    const taskId = url.searchParams.get('taskId') ?? undefined;
    ctx.json(res, 200, { holds: manager.listHolds(taskId) });
    return true;
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'holds' && seg[2] === 'release') {
    const body = await ctx.readBody(req);
    try {
      const hold = manager.releaseHold(
        seg[1],
        (body['by'] as string | undefined) ?? 'api',
        (body['revalidationNote'] as string | undefined) ?? '',
      );
      ctx.audit.record('api', 'PROMOTION_HOLD_RELEASED', 'requirement', hold.requirementId, {
        holdId: hold.id,
        taskId: hold.taskId,
      });
      ctx.json(res, 200, { hold });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'promotion-check') {
    const body = await ctx.readBody(req);
    const taskId = body['taskId'] as string | undefined;
    if (!taskId) {
      ctx.json(res, 400, { error: 'taskId is required' });
      return true;
    }
    // Fail-closed gate: assertPromotionAllowed throws while a hold is
    // active; the 409 body lists the blocking holds.
    try {
      manager.assertPromotionAllowed(taskId);
      ctx.json(res, 200, { allowed: true });
    } catch (err) {
      if (manager.isPromotionHeld(taskId)) {
        ctx.json(res, 409, { allowed: false, holds: manager.activeHolds(taskId) });
      } else {
        ctx.json(res, 500, { error: (err as Error).message });
      }
    }
    return true;
  }

  if (method === 'GET' && seg.length === 1) {
    try {
      ctx.json(res, 200, { requirement: manager.get(seg[0]) });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 3 && seg[1] === 'versions') {
    try {
      ctx.json(res, 200, { version: manager.getVersion(seg[0], Number(seg[2])) });
    } catch (err) {
      ctx.json(res, 404, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'versions') {
    const body = await ctx.readBody(req);
    try {
      const v = manager.newVersion(
        seg[0],
        body['changeKind'] as never,
        (body['changeNote'] as string | undefined) ?? '',
        (body['createdBy'] as string | undefined) ?? 'api',
        (draft) => {
          Object.assign(draft, body['patch'] ?? {});
        },
        // §16 G-01/G-02 (Batch 4): patches that move completion_target
        // or change AC meaning are rejected by the manager unless the
        // request carries a recorded HUMAN authorization — fail-closed.
        { humanAuthorization: body['humanAuthorization'] as never },
      );
      ctx.json(res, 201, { version: v });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // Entity links (§16) — binds tasks/plans/code/tests/evidence/approvals/
  // releases to one requirement version. This is the HTTP entry point that
  // makes impact analysis (and its promotion holds) reachable end-to-end:
  // without it no task could ever be linked, so analyzeImpact() would
  // never suspend anything. Fail-closed: a missing/invalid version or a
  // nonexistent requirement version is a 400, never a silent no-op.
  if (method === 'POST' && seg.length === 2 && seg[1] === 'links') {
    const body = await ctx.readBody(req);
    const version = Number(body['version']);
    if (!Number.isInteger(version) || version < 1) {
      ctx.json(res, 400, { error: 'version (positive integer) is required' });
      return true;
    }
    const LINK_FIELDS = [
      'planIds',
      'taskIds',
      'codeRefs',
      'testIds',
      'evidenceIds',
      'approvalIds',
      'releaseIds',
    ] as const;
    const links: Partial<EntityLinks> = {};
    for (const f of LINK_FIELDS) {
      const v = body[f];
      if (v === undefined) continue;
      if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
        ctx.json(res, 400, { error: `${f} must be an array of strings` });
        return true;
      }
      links[f] = v as string[];
    }
    try {
      manager.linkEntities(seg[0], version, links);
      ctx.audit.record('api', 'REQUIREMENT_ENTITIES_LINKED', 'requirement', seg[0], {
        version,
      });
      ctx.json(res, 200, { links: manager.getLinks(seg[0], version) });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'impact') {
    const body = await ctx.readBody(req);
    try {
      const impact = manager.analyzeImpact(
        seg[0],
        Number(body['fromVersion']),
        Number(body['toVersion']),
        (body['by'] as string | undefined) ?? 'api',
      );
      ctx.json(res, 200, { impact });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'ac-refinement') {
    const requirementId = seg[0]!;
    // §81 'requirement-ambiguity' circuit breaker (Batch 42): while an
    // OPEN upgrade exists for this requirement, further autonomous
    // refinements pause — bounded clarification is exhausted and a human
    // must judge. Human meaning-changes go through newVersion with a
    // recorded HUMAN authorization, never through this endpoint.
    if (isRefinementPaused(ctx, requirementId)) {
      ctx.json(res, 409, {
        error:
          `AC refinement paused for requirement ${requirementId}: an OPEN ` +
          `'requirement-ambiguity' upgrade awaits human review ` +
          `(POST /api/needs-human/:id/resolve to continue).`,
        code: 'REQUIREMENT_REFINEMENT_PAUSED',
      });
      return true;
    }
    const body = await ctx.readBody(req);
    try {
      const v = manager.proposeAcRefinement(
        requirementId,
        body['acId'] as string,
        (body['patch'] as never) ?? {},
        (body['by'] as string | undefined) ?? 'api',
      );
      maybeEmitRequirementAmbiguityUpgrade(ctx, requirementId);
      ctx.json(res, 201, { version: v });
    } catch (err) {
      ctx.json(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (method === 'POST' && seg.length === 2 && seg[1] === 'compatibility') {
    const body = await ctx.readBody(req);
    const rec = manager.checkEvidenceCompatibility(
      body['evidenceId'] as string,
      seg[0],
      Number(body['requirementVersion']),
      body['compatible'] as boolean,
      (body['basis'] as string | undefined) ?? '',
      (body['checkedBy'] as string | undefined) ?? 'api',
    );
    ctx.json(res, 201, { compatibility: rec });
    return true;
  }

  return false;
}

/**
 * §81 'requirement-ambiguity' emission on AC-refinement churn (Batch 42).
 *
 * The deterministic pattern: N consecutive versions with
 * changeKind === 'AC_REFINEMENT' on the same requirement. Each
 * AC_REFINEMENT is the AI using the sanctioned clarification path
 * (proposeAcRefinement); a run of N means the AC set keeps needing
 * clarification without stabilizing. This is a deterministic count of
 * structured, recorded events — not the QA regex heuristic
 * (packages/qa/src/classify.ts AMBIGUITY_RE), which Batch 38-4 rejected
 * as "heuristic masquerading as deterministic".
 *
 * Honest framing (same bar as Batch 41 'policy-violation'): a single
 * refinement is the system working as designed — no emission. The
 * emission fires on the PATTERN, and the record states plainly what was
 * observed (N consecutive refinements), not a proven verdict that the
 * requirement "is ambiguous".
 */
export const REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD = 3;

export function requirementRefinementUpgradeSource(
  requirementId: string,
): string {
  return `requirement-refinement:${requirementId}`;
}

/**
 * Whether autonomous AC refinement is currently paused for the
 * requirement: an OPEN 'requirement-ambiguity' upgrade with the matching
 * source exists. Exported so tests can drive the 409 guard directly.
 */
export function isRefinementPaused(
  ctx: RouteContext,
  requirementId: string,
): boolean {
  const source = requirementRefinementUpgradeSource(requirementId);
  return ctx.fdb.needsHuman
    .list('open')
    .some((r) => r.reason === 'requirement-ambiguity' && r.source === source);
}

/**
 * Build the §81 'requirement-ambiguity' upgrade record for AC-refinement
 * churn. Pure: the caller (maybeEmitRequirementAmbiguityUpgrade) has
 * already decided the threshold is met and no OPEN upgrade exists for
 * this requirement.
 *
 * recipient is null: the server has coarse-grained token RBAC with no
 * named human accounts, so we record the required level instead of
 * inventing a person. 'manager' is a mapping choice (documented here,
 * spec has no AC-churn → rank table): clarifying requirement meaning is
 * a product/business judgment above routine run work, the same level
 * Batch 39 chose for high-risk-deployment. severity 'medium' comes from
 * the @ai-factory/autonomy REASON_SEVERITY mapping for
 * 'requirement-ambiguity' (not chosen here).
 */
export function buildRequirementAmbiguityUpgradeRecord(args: {
  requirementId: string;
  refinementCount: number;
  latestVersion: number;
}): NeedsHumanDbRecord {
  const rec = needsHuman('requirement-ambiguity', {
    detail:
      `requirement ${args.requirementId} has ${args.refinementCount} consecutive ` +
      `AC_REFINEMENT versions (latest v${args.latestVersion}). The sanctioned ` +
      `clarification path (proposeAcRefinement) has been used ` +
      `${args.refinementCount} times in a row without the acceptance-criteria ` +
      `set stabilizing — bounded autonomous clarification is exhausted and ` +
      `the underlying requirement may be ambiguous. Human judgment is ` +
      `required before further autonomous refinement.`,
    context: {
      requirementId: args.requirementId,
      consecutiveRefinements: String(args.refinementCount),
      threshold: String(REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD),
      latestVersion: String(args.latestVersion),
    },
    impactScope:
      `autonomous AC refinement for requirement ${args.requirementId} is ` +
      `paused pending human review; other requirements are unaffected`,
    stoppedActions: [
      `autonomous AC refinement paused for requirement ${args.requirementId} ` +
        `(refinement #${args.refinementCount}); ` +
        `POST /api/requirements/${args.requirementId}/ac-refinement returns 409 ` +
        `while this upgrade is OPEN`,
    ],
    suggestion:
      'Review the recent AC_REFINEMENT versions of the requirement ' +
      '(GET /api/requirements/:id/versions/:v — changeNote "AC <id> refined"). ' +
      'If the acceptance criteria are now clear, mark this upgrade resolved ' +
      'via POST /api/needs-human/:id/resolve and refinement resumes. If the ' +
      'requirement itself is unclear, restate it with POST ' +
      '/api/requirements/:id/versions (TARGET_CHANGE / SCOPE_CHANGE with a ' +
      'recorded HUMAN authorization where §16 requires it).',
  });
  return {
    id: rec.id,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    severity: rec.severity,
    source: requirementRefinementUpgradeSource(args.requirementId),
    recipient: null,
    requiredDeciderLevel: 'manager',
    detailJson: JSON.stringify({
      requirementId: args.requirementId,
      refinementCount: args.refinementCount,
      latestVersion: args.latestVersion,
      threshold: REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD,
      suggestion: rec.suggestion,
    }),
    contextJson: JSON.stringify(rec.context ?? {}),
    raisedAt: Date.now(),
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

/**
 * §81 'requirement-ambiguity' emission check. Called after every
 * successful AC refinement. Emits at most one OPEN upgrade per
 * requirement: when the trailing AC_REFINEMENT streak reaches
 * REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD and no OPEN
 * 'requirement-ambiguity' upgrade with source
 * `requirement-refinement:<id>` exists, a new upgrade is submitted
 * (insert-only). Further refinements while the upgrade is OPEN are
 * 409-paused by the handler above, so they never reach this check;
 * after a human resolves it, the next refinement at/over threshold
 * opens a new episode.
 *
 * Write-through failures are audited NEEDS_HUMAN_PERSIST_FAILED and never
 * thrown — the refinement itself already succeeded and the 201 below must
 * still be returned (same contract as emitRunNeedsHuman; the emission is
 * advisory to the refinement path).
 */
export function maybeEmitRequirementAmbiguityUpgrade(
  ctx: RouteContext,
  requirementId: string,
): void {
  const count = manager.countConsecutiveAcRefinements(requirementId);
  if (count < REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD) return;
  if (isRefinementPaused(ctx, requirementId)) return;
  const record = buildRequirementAmbiguityUpgradeRecord({
    requirementId,
    refinementCount: count,
    latestVersion: manager.latest(requirementId).version,
  });
  emitRequirementAmbiguityNeedsHuman(ctx, record);
}

/**
 * Write-through for §81 'requirement-ambiguity' upgrades: insert-only
 * into fdb.needsHuman, audited NEEDS_HUMAN_RAISED. Same contract as
 * emitRunNeedsHuman (routes/runtime.ts) — duplicated here rather than
 * imported so this module keeps no value-imports of sibling route files
 * (dual-mode: server tests import this file's src directly; see
 * needs-human-policy-violation.test.ts for the precedent).
 */
function emitRequirementAmbiguityNeedsHuman(
  ctx: RouteContext,
  record: NeedsHumanDbRecord,
): void {
  try {
    ctx.fdb.needsHuman.submit(record);
    ctx.audit.record('system', 'NEEDS_HUMAN_RAISED', 'needs-human', record.id, {
      reason: record.reason,
      source: record.source,
      requiredDeciderLevel: record.requiredDeciderLevel,
    });
  } catch (err) {
    ctx.audit.record(
      'system',
      'NEEDS_HUMAN_PERSIST_FAILED',
      'needs-human',
      record.id,
      {
        error: err instanceof Error ? err.message : String(err),
        source: record.source,
      },
    );
  }
}
