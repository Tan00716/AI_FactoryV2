/**
 * RequirementManager — SPEC_V2 §16.
 *
 * - Immutable versions: newVersion() appends; old records are never mutated.
 * - AI PM may propose AC refinements but may NOT change business meaning:
 *   refinements keep the AC id and may only clarify description / expected
 *   evidence / verification type. Anything adding new product behavior is
 *   rejected and must go through the Proposal flow (§17.3).
 * - completion_target changes require a recorded HUMAN authorization —
 *   the AI may not move the endpoint to reach Done faster.
 * - These rules are enforced AT THE DATA LAYER (create()/newVersion()
 *   themselves), not only in convenience wrappers: calling newVersion()
 *   directly with a mutate that moves completion_target or changes AC
 *   business meaning (add/remove an AC, edit an AC's semantic fields)
 *   is rejected without a recorded HUMAN authorization, and create()
 *   rejects VERIFIED_DELIVERY unless the project category is eligible
 *   (§16: documentation / research / dev tool / no production env) AND
 *   a HUMAN authorized the declaration. The convenience methods
 *   (changeCompletionTarget, proposeAcRefinement) route through the
 *   same checks — there is no side door around them.
 * - analyzeImpact() computes affected Plan/Task/Code/Test/Evidence/Approval/
 *   Release, suspends affected promotions, marks old approvals STALE, and
 *   requires EXPLICIT compatibility checks before old evidence is reused
 *   (no silent v1 PASS on v2 work).
 */

import { randomUUID } from 'crypto';
import {
  AcceptanceCriterion,
  CompletionTarget,
  CreateRequirementInput,
  EntityLinks,
  EvidenceCompatibility,
  HumanAuthorization,
  ImpactAnalysis,
  ProjectCategory,
  PromotionHold,
  Requirement,
  RequirementChangeKind,
  RequirementVersion,
  VERIFIED_DELIVERY_PROJECT_CATEGORIES,
} from './types';
import type { RequirementStore } from './store';

export class RequirementError extends Error {}
export class RequirementNotFoundError extends RequirementError {
  constructor(id: string) { super(`Requirement ${id} not found`); }
}
export class AcRefinementRejectedError extends RequirementError {}
export class CompletionTargetChangeRejectedError extends RequirementError {}
export class EvidenceReuseDeniedError extends RequirementError {}

/**
 * Thrown at the data layer when a version mutation changes AC business
 * meaning (adds/removes an AC or edits an AC's semantic fields) without
 * a recorded HUMAN authorization (§16 G-02). Clarifications belong in
 * proposeAcRefinement(); meaning changes belong to a human.
 */
export class AcMeaningChangeRejectedError extends RequirementError {}

/**
 * Thrown when VERIFIED_DELIVERY is declared for an ineligible project
 * category or without a recorded HUMAN authorization (§16 G-03).
 */
export class VerifiedDeliveryRejectedError extends RequirementError {}

/**
 * Thrown by assertPromotionAllowed() when a task still has an active
 * (unreleased) PromotionHold (§16 G-05): the hold is a hard gate, not a
 * record nobody reads. Carries the blocking holds for callers that need
 * to report them (e.g. the promotion-check route's 409 body).
 */
export class PromotionHeldError extends RequirementError {
  readonly taskId: string;
  readonly holds: PromotionHold[];
  constructor(taskId: string, holds: PromotionHold[]) {
    const first = holds[0]!;
    super(
      `Promotion held for task ${taskId}: hold ${first.id} ` +
        `(requirement ${first.requirementId}@${first.requirementVersion}: ${first.reason})` +
        (holds.length > 1 ? `; +${holds.length - 1} more active hold(s)` : ''),
    );
    this.taskId = taskId;
    this.holds = holds;
  }
}

export interface AcRefinementPatch {
  description?: string;
  expectedEvidence?: string;
  verificationType?: AcceptanceCriterion['verificationType'];
  /**
   * Set true when the "refinement" would add new product behavior.
   * New behavior must enter the Proposal/authorization flow (§17.3) —
   * it is rejected here.
   */
  addsNewBehavior?: boolean;
}

export interface ManagerOptions {
  now?: () => number;
  /**
   * Persistence seam (F2): when given, the manager hydrates its full
   * state (requirements + versions, links, holds, compatibility
   * declarations, auto-id sequence) from the store at construction and
   * writes every mutation through to it. Without a store the manager
   * is process memory only — the pre-seam behavior, unchanged.
   */
  store?: RequirementStore;
}

export interface NewVersionOptions {
  /**
   * Recorded HUMAN authorization (§16). REQUIRED at the data layer
   * whenever the mutation (a) changes completion_target, or (b) changes
   * AC business meaning — adds/removes an AC or edits an existing AC's
   * semantic fields. Without it such mutations are rejected no matter
   * which changeKind the caller claims.
   */
  humanAuthorization?: HumanAuthorization;
}

/** AC fields that carry business meaning (everything except `version`). */
const AC_SEMANTIC_FIELDS = [
  'description',
  'verificationType',
  'verifiedBy',
  'expectedEvidence',
  'applicableEnvironments',
] as const;

function acSemanticValue(ac: AcceptanceCriterion, field: (typeof AC_SEMANTIC_FIELDS)[number]): string {
  const v = ac[field];
  // Environment lists compare order-insensitively: reordering is not a
  // meaning change, adding/removing an environment is.
  return Array.isArray(v) ? [...v].sort().join('') : String(v);
}

interface AcMeaningDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Diff AC business meaning between two versions (AC `version` bumps alone are not meaning changes). */
function diffAcMeaning(prev: RequirementVersion, next: RequirementVersion): AcMeaningDiff {
  const prevById = new Map(prev.acceptanceCriteria.map((a) => [a.id, a]));
  const nextById = new Map(next.acceptanceCriteria.map((a) => [a.id, a]));
  const added = [...nextById.keys()].filter((id) => !prevById.has(id));
  const removed = [...prevById.keys()].filter((id) => !nextById.has(id));
  const changed = [...nextById.keys()].filter((id) => {
    const a = prevById.get(id);
    const b = nextById.get(id)!;
    return a !== undefined && AC_SEMANTIC_FIELDS.some((f) => acSemanticValue(a, f) !== acSemanticValue(b, f));
  });
  return { added, removed, changed };
}

function describeAcDiff(diff: AcMeaningDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`added AC(s): ${diff.added.join(', ')}`);
  if (diff.removed.length > 0) parts.push(`removed AC(s): ${diff.removed.join(', ')}`);
  if (diff.changed.length > 0) parts.push(`changed AC meaning: ${diff.changed.join(', ')}`);
  return parts.join('; ');
}

function freshLinks(): EntityLinks {
  return {
    planIds: [], taskIds: [], codeRefs: [], testIds: [],
    evidenceIds: [], approvalIds: [], releaseIds: [],
  };
}

export class RequirementManager {
  private requirements = new Map<string, Requirement>();
  private links = new Map<string, EntityLinks>(); // `${id}@${version}` -> links
  private holds: PromotionHold[] = [];
  private compatibility: EvidenceCompatibility[] = [];
  private seq = 0;
  private readonly store: RequirementStore | undefined;

  constructor(private opts: ManagerOptions = {}) {
    this.store = opts.store;
    if (this.store) {
      // Hydrate the full state the previous process left behind, so a
      // restarted manager answers getVersion / canReuseEvidence /
      // activeHolds exactly as the one that wrote the records did.
      for (const req of this.store.listRequirements()) {
        this.requirements.set(req.id, req);
      }
      for (const rec of this.store.listLinks()) {
        this.links.set(this.linkKey(rec.requirementId, rec.version), rec.links);
      }
      this.holds = this.store.listHolds();
      this.compatibility = this.store.listCompatibility();
      this.seq = this.store.getSeq();
    }
  }

  private iso(): string {
    return new Date(this.opts.now ? this.opts.now() : Date.now()).toISOString();
  }

  private linkKey(id: string, version: number): string {
    return `${id}@${version}`;
  }

  create(input: CreateRequirementInput): Requirement {
    const autoId = input.id === undefined;
    const id = input.id ?? `REQ-${String(++this.seq).padStart(3, '0')}`;
    // Persist the sequence at the exact point the in-memory counter is
    // consumed (before any validation below can throw), so a restarted
    // manager hands out the same next id this one would have.
    if (autoId) this.store?.setSeq(this.seq);
    if (this.requirements.has(id)) throw new RequirementError(`Requirement ${id} already exists`);

    const seen = new Set<string>();
    for (const ac of input.acceptanceCriteria) {
      if (!ac.id) throw new RequirementError('Every AC must have a stable id');
      if (seen.has(ac.id)) throw new RequirementError(`Duplicate AC id ${ac.id}`);
      seen.add(ac.id);
      if (!ac.expectedEvidence) throw new RequirementError(`AC ${ac.id} must declare expectedEvidence`);
    }

    const target: CompletionTarget = input.completionTarget ?? 'RELEASED_OUTCOME';

    // §16 G-03 — VERIFIED_DELIVERY is enforced HERE, at create(), not by
    // caller convention: the project category must be eligible
    // (documentation / research / dev tool / no production environment)
    // AND a HUMAN must have authorized declaring release NOT_APPLICABLE.
    // Merely recording a free-text basis is not an authorization.
    let releaseNaAuthorization: RequirementVersion['releaseNaAuthorization'] =
      input.releaseNaAuthorization ?? null;
    if (target === 'VERIFIED_DELIVERY') {
      const category = input.projectCategory;
      if (!category || !VERIFIED_DELIVERY_PROJECT_CATEGORIES.includes(category)) {
        throw new VerifiedDeliveryRejectedError(
          `VERIFIED_DELIVERY requires an eligible projectCategory (one of ` +
            `${VERIFIED_DELIVERY_PROJECT_CATEGORIES.join(', ')} — documentation, research, ` +
            `dev tool, or no production environment per §16); got ${category ?? '<none declared>'}`,
        );
      }
      const auth = input.completionTargetAuthorization;
      if (!auth || !auth.isHuman) {
        throw new VerifiedDeliveryRejectedError(
          'VERIFIED_DELIVERY requires a recorded HUMAN authorization ' +
            '(completionTargetAuthorization with isHuman=true) — an AI may not declare release NOT_APPLICABLE',
        );
      }
      releaseNaAuthorization = releaseNaAuthorization ?? {
        authorizedBy: auth.authorizedBy,
        reason: auth.reason,
        at: this.iso(),
      };
    }
    if (target === 'VERIFIED_DELIVERY' && !releaseNaAuthorization) {
      throw new RequirementError(
        'VERIFIED_DELIVERY requires releaseNaAuthorization: release is NOT_APPLICABLE only with a recorded basis',
      );
    }

    const now = this.iso();
    const v1: RequirementVersion = {
      version: 1,
      createdAt: now,
      createdBy: input.createdBy,
      changeKind: 'INITIAL',
      changeNote: 'initial version',
      businessGoal: input.businessGoal,
      rationale: input.rationale ?? '',
      projectCategory: input.projectCategory,
      acceptanceCriteria: input.acceptanceCriteria.map((a) => ({ ...a, version: 1 })),
      exclusions: input.exclusions ?? [],
      constraints: input.constraints ?? [],
      completionTarget: target,
      environments: input.environments ?? [],
      dataSecurityRequirements: input.dataSecurityRequirements ?? [],
      budget: input.budget ?? null,
      riskAuthorization: input.riskAuthorization ?? null,
      outcomeMeasurement: input.outcomeMeasurement ?? '',
      releaseNaAuthorization,
    };
    const req: Requirement = { id, versions: [v1], status: 'ACTIVE', createdAt: now };
    this.requirements.set(id, req);
    const links = freshLinks();
    this.links.set(this.linkKey(id, 1), links);
    this.store?.putRequirement(req);
    this.store?.putLinks(id, 1, links);
    return req;
  }

  get(id: string): Requirement {
    const r = this.requirements.get(id);
    if (!r) throw new RequirementNotFoundError(id);
    return r;
  }

  /** Latest version. */
  latest(id: string): RequirementVersion {
    const r = this.get(id);
    return r.versions[r.versions.length - 1];
  }

  /** Immutable read of a specific version — old records are never mutated. */
  getVersion(id: string, version: number): RequirementVersion {
    const v = this.get(id).versions.find((x) => x.version === version);
    if (!v) throw new RequirementError(`Requirement ${id}@${version} not found`);
    return v;
  }

  /**
   * Append a new immutable version. `mutate` receives a deep copy of the
   * latest version and returns the modified draft (version/by/at are set here).
   *
   * DATA-LAYER GATES (§16 G-01/G-02) — enforced here, for every caller,
   * whatever changeKind is claimed:
   *  1. A mutation that changes completion_target requires changeKind
   *     TARGET_CHANGE *and* a recorded HUMAN authorization
   *     (opts.humanAuthorization with isHuman=true). Previously any
   *     caller could pass TARGET_CHANGE and move the endpoint directly,
   *     bypassing changeCompletionTarget()'s HUMAN check.
   *  2. A mutation that changes AC business meaning — the AC diff adds
   *     or removes an AC, or edits an existing AC's semantic fields
   *     (description / verificationType / verifiedBy / expectedEvidence /
   *     applicableEnvironments) — likewise requires a recorded HUMAN
   *     authorization. Previously an arbitrary mutate could add
   *     new-behavior ACs, bypassing proposeAcRefinement()'s
   *     addsNewBehavior rejection.
   * Mutations touching neither (goal text, exclusions, budget, …) are
   * not gated. proposeAcRefinement() does NOT come through here: it is
   * the one sanctioned non-human clarification path and appends via
   * appendVersion() directly (see its comment).
   */
  newVersion(
    id: string,
    changeKind: RequirementChangeKind,
    changeNote: string,
    createdBy: string,
    mutate: (draft: RequirementVersion) => void,
    opts: NewVersionOptions = {},
  ): RequirementVersion {
    const prev = this.latest(id);
    const draft: RequirementVersion = JSON.parse(JSON.stringify(prev)) as RequirementVersion;
    mutate(draft);

    // Gate 1 — completion_target (§16 G-01): same HUMAN check as
    // changeCompletionTarget(), applied to the raw mutation.
    if (draft.completionTarget !== prev.completionTarget) {
      if (changeKind !== 'TARGET_CHANGE') {
        throw new RequirementError(
          'completion_target changed without TARGET_CHANGE — use changeCompletionTarget() with human authorization',
        );
      }
      const auth = opts.humanAuthorization;
      if (!auth || !auth.isHuman) {
        throw new CompletionTargetChangeRejectedError(
          'completion_target change requires a recorded HUMAN authorization — ' +
            'AI may not move the endpoint; pass NewVersionOptions.humanAuthorization (isHuman=true) or use changeCompletionTarget()',
        );
      }
      if (draft.completionTarget === 'VERIFIED_DELIVERY') {
        // Same eligibility rule as create() (§16 G-03), applied whenever
        // the project category is known.
        const category = draft.projectCategory;
        if (category && !VERIFIED_DELIVERY_PROJECT_CATEGORIES.includes(category)) {
          throw new VerifiedDeliveryRejectedError(
            `VERIFIED_DELIVERY is not eligible for projectCategory ${category} (§16: ` +
              `documentation, research, dev tool, or no production environment only)`,
          );
        }
        if (!draft.releaseNaAuthorization) {
          draft.releaseNaAuthorization = {
            authorizedBy: auth.authorizedBy,
            reason: auth.reason,
            at: this.iso(),
          };
        }
      }
    }

    // Gate 2 — AC business meaning (§16 G-02): decidable by diffing the
    // AC set before/after the mutation.
    const acDiff = diffAcMeaning(prev, draft);
    if (acDiff.added.length > 0 || acDiff.removed.length > 0 || acDiff.changed.length > 0) {
      if (!opts.humanAuthorization || !opts.humanAuthorization.isHuman) {
        throw new AcMeaningChangeRejectedError(
          `version mutation changes AC business meaning (${describeAcDiff(acDiff)}) without a ` +
            'recorded HUMAN authorization — clarifications must go through proposeAcRefinement() ' +
            'with addsNewBehavior=false; meaning changes require a HUMAN authorization ' +
            '(NewVersionOptions.humanAuthorization) or the Proposal flow (§17.3)',
        );
      }
    }

    return this.appendVersion(id, draft, changeKind, changeNote, createdBy);
  }

  /**
   * Raw append of an already-gated draft. Callers: newVersion() (after
   * its data-layer gates) and proposeAcRefinement() (structurally
   * bounded: one existing AC, clarification fields only — it cannot add
   * or remove ACs, and addsNewBehavior is rejected before this point).
   * Nothing else may append a version.
   */
  private appendVersion(
    id: string,
    draft: RequirementVersion,
    changeKind: RequirementChangeKind,
    changeNote: string,
    createdBy: string,
  ): RequirementVersion {
    const req = this.get(id);
    const prev = this.latest(id);
    const next: RequirementVersion = {
      ...draft,
      version: prev.version + 1,
      createdAt: this.iso(),
      createdBy,
      changeKind,
      changeNote,
    };
    req.versions.push(next);
    const links = freshLinks();
    this.links.set(this.linkKey(id, next.version), links);
    this.store?.putRequirement(req);
    this.store?.putLinks(id, next.version, links);
    return next;
  }

  /**
   * AI PM AC refinement (§16): keeps the AC id, may clarify description /
   * expected evidence / verification type, bumps the AC version. Changing
   * business meaning (new behavior) is rejected.
   */
  proposeAcRefinement(
    id: string,
    acId: string,
    patch: AcRefinementPatch,
    by: string,
  ): RequirementVersion {
    if (patch.addsNewBehavior) {
      throw new AcRefinementRejectedError(
        `AC ${acId}: refinement adds new product behavior — route through the Proposal/authorization flow (§17.3), not AC refinement`,
      );
    }
    // This method appends via appendVersion(), NOT the public
    // newVersion(): it is the one sanctioned non-human path that may
    // touch an AC's description, and it is structurally bounded — it
    // can only patch description / expectedEvidence / verificationType
    // of ONE existing AC (no adds, no removals, no other fields), with
    // addsNewBehavior rejected above. Raw newVersion() callers get no
    // such trust: the data layer cannot distinguish a "clarification"
    // from a meaning change in free text, so their AC edits require a
    // recorded HUMAN authorization (newVersion gate 2, §16 G-02).
    const prev = this.latest(id);
    const draft: RequirementVersion = JSON.parse(JSON.stringify(prev)) as RequirementVersion;
    const ac = draft.acceptanceCriteria.find((a) => a.id === acId);
    if (!ac) throw new RequirementError(`AC ${acId} not found in ${id}`);
    if (patch.description !== undefined) ac.description = patch.description;
    if (patch.expectedEvidence !== undefined) ac.expectedEvidence = patch.expectedEvidence;
    if (patch.verificationType !== undefined) ac.verificationType = patch.verificationType;
    ac.version += 1;
    return this.appendVersion(id, draft, 'AC_REFINEMENT', `AC ${acId} refined`, by);
  }

  /**
   * completion_target changes require a recorded HUMAN authorization.
   * The AI may not move the endpoint to reach Done faster (§16).
   */
  changeCompletionTarget(
    id: string,
    target: CompletionTarget,
    auth: HumanAuthorization,
    by: string,
  ): RequirementVersion {
    if (!auth.isHuman) {
      throw new CompletionTargetChangeRejectedError(
        'completion_target change requires a recorded HUMAN authorization — AI may not move the endpoint',
      );
    }
    // Delegates to newVersion() with the same authorization, so the
    // convenience path and the raw path pass through ONE data-layer
    // gate (§16 G-01) — including the VERIFIED_DELIVERY category check.
    return this.newVersion(id, 'TARGET_CHANGE', `target → ${target}: ${auth.reason}`, by, (draft) => {
      draft.completionTarget = target;
      if (target === 'VERIFIED_DELIVERY') {
        draft.releaseNaAuthorization = {
          authorizedBy: auth.authorizedBy,
          reason: auth.reason,
          at: this.iso(),
        };
      }
    }, { humanAuthorization: auth });
  }

  /** Record which entities are bound to a requirement version. */
  linkEntities(id: string, version: number, links: Partial<EntityLinks>): void {
    this.getVersion(id, version); // throws when missing
    const cur = this.links.get(this.linkKey(id, version)) ?? freshLinks();
    for (const [k, v] of Object.entries(links)) {
      if (Array.isArray(v)) (cur[k as keyof EntityLinks] as string[]).push(...(v as string[]));
    }
    this.links.set(this.linkKey(id, version), cur);
    this.store?.putLinks(id, version, cur);
  }

  getLinks(id: string, version: number): EntityLinks {
    return this.links.get(this.linkKey(id, version)) ?? freshLinks();
  }

  /**
   * §16 impact analysis for REQ@from → REQ@to: diff ACs, collect affected
   * entities, mark old-version approvals STALE, suspend affected promotions,
   * and split evidence into explicitly-reusable vs must-not-silently-reuse.
   */
  analyzeImpact(id: string, fromVersion: number, toVersion: number, by: string): ImpactAnalysis {
    const from = this.getVersion(id, fromVersion);
    const to = this.getVersion(id, toVersion);
    const fromAcs = new Map(from.acceptanceCriteria.map((a) => [a.id, a]));
    const toAcs = new Map(to.acceptanceCriteria.map((a) => [a.id, a]));

    const acAdded = [...toAcs.keys()].filter((k) => !fromAcs.has(k));
    const acRemoved = [...fromAcs.keys()].filter((k) => !toAcs.has(k));
    const acChanged = [...toAcs.keys()].filter((k) => {
      const a = fromAcs.get(k);
      const b = toAcs.get(k)!;
      return a !== undefined && (a.version !== b.version || a.description !== b.description);
    });

    const affected = this.getLinks(id, fromVersion);
    const now = this.iso();

    // Suspend promotions of affected tasks until re-planning / re-authorization.
    // Dedup (§16 G-05): re-running impact analysis for the same
    // taskId + requirementId + toVersion must not stack a second active
    // hold — the already-active hold is the suspension, reuse it. A hold
    // that was released does NOT block creating a fresh one.
    const suspendedPromotions: PromotionHold[] = affected.taskIds.map((taskId) => {
      const existing = this.holds.find(
        (h) =>
          h.taskId === taskId &&
          h.requirementId === id &&
          h.requirementVersion === toVersion &&
          h.releasedAt === null,
      );
      if (existing) return existing;
      const hold: PromotionHold = {
        id: randomUUID(),
        taskId,
        requirementId: id,
        requirementVersion: toVersion,
        reason: `Requirement ${id}@${fromVersion} → @${toVersion}: re-plan/re-authorize required`,
        createdAt: now,
        releasedAt: null,
        releasedBy: null,
        revalidationNote: null,
      };
      this.holds.push(hold);
      this.store?.putHold(hold);
      return hold;
    });

    const evidenceReusable = affected.evidenceIds.filter((eid) =>
      this.canReuseEvidence(eid, id, toVersion),
    );
    const evidenceStale = affected.evidenceIds.filter((eid) => !evidenceReusable.includes(eid));

    return {
      requirementId: id,
      fromVersion,
      toVersion,
      acAdded,
      acRemoved,
      acChanged,
      affected,
      staleApprovals: [...affected.approvalIds],
      staleGates: affected.taskIds.map((t) => `gate:${t}`),
      suspendedPromotions,
      evidenceReusable,
      evidenceStale,
      analyzedAt: now,
      analyzedBy: by,
    };
  }

  /** Explicit compatibility check — the only legal way to reuse old evidence. */
  checkEvidenceCompatibility(
    evidenceId: string,
    requirementId: string,
    requirementVersion: number,
    compatible: boolean,
    basis: string,
    checkedBy: string,
  ): EvidenceCompatibility {
    const rec: EvidenceCompatibility = {
      evidenceId, requirementId, requirementVersion,
      compatible, checkedBy, at: this.iso(), basis,
    };
    this.compatibility.push(rec);
    this.store?.addCompatibility(rec);
    return rec;
  }

  /** Old evidence is reusable ONLY with an explicit compatible check. No silent reuse. */
  canReuseEvidence(evidenceId: string, requirementId: string, requirementVersion: number): boolean {
    return this.compatibility.some(
      (c) =>
        c.evidenceId === evidenceId &&
        c.requirementId === requirementId &&
        c.requirementVersion === requirementVersion &&
        c.compatible,
    );
  }

  /** Release a promotion hold — requires a revalidation note. */
  releaseHold(holdId: string, by: string, revalidationNote: string): PromotionHold {
    const hold = this.holds.find((h) => h.id === holdId);
    if (!hold) throw new RequirementError(`Promotion hold ${holdId} not found`);
    if (hold.releasedAt !== null) throw new RequirementError(`Hold ${holdId} already released`);
    if (!revalidationNote) throw new RequirementError('Releasing a hold requires a revalidation note');
    hold.releasedAt = this.iso();
    hold.releasedBy = by;
    hold.revalidationNote = revalidationNote;
    this.store?.putHold(hold);
    return hold;
  }

  listHolds(taskId?: string): PromotionHold[] {
    return taskId ? this.holds.filter((h) => h.taskId === taskId) : [...this.holds];
  }

  /** Active (unreleased) promotion holds for a task — the gate's input. */
  activeHolds(taskId: string): PromotionHold[] {
    return this.holds.filter((h) => h.taskId === taskId && h.releasedAt === null);
  }

  /** True while any active PromotionHold blocks this task's promotion. */
  isPromotionHeld(taskId: string): boolean {
    return this.activeHolds(taskId).length > 0;
  }

  /**
   * The §16 promotion gate (G-05): fail-closed. Throws PromotionHeldError
   * (naming the hold id, requirementId@version and reason) while an active
   * hold exists; returns normally once every hold has been released via
   * releaseHold() with a revalidation note. Promotion paths MUST call this
   * (or isPromotionHeld) before promoting — holds are enforced here, not
   * merely recorded by analyzeImpact().
   */
  assertPromotionAllowed(taskId: string): void {
    const active = this.activeHolds(taskId);
    if (active.length > 0) throw new PromotionHeldError(taskId, active);
  }
}
