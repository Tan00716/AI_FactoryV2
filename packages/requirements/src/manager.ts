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
  ImpactAnalysis,
  PromotionHold,
  Requirement,
  RequirementChangeKind,
  RequirementVersion,
} from './types';

export class RequirementError extends Error {}
export class RequirementNotFoundError extends RequirementError {
  constructor(id: string) { super(`Requirement ${id} not found`); }
}
export class AcRefinementRejectedError extends RequirementError {}
export class CompletionTargetChangeRejectedError extends RequirementError {}
export class EvidenceReuseDeniedError extends RequirementError {}

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

  constructor(private opts: ManagerOptions = {}) {}

  private iso(): string {
    return new Date(this.opts.now ? this.opts.now() : Date.now()).toISOString();
  }

  private linkKey(id: string, version: number): string {
    return `${id}@${version}`;
  }

  create(input: CreateRequirementInput): Requirement {
    const id = input.id ?? `REQ-${String(++this.seq).padStart(3, '0')}`;
    if (this.requirements.has(id)) throw new RequirementError(`Requirement ${id} already exists`);

    const seen = new Set<string>();
    for (const ac of input.acceptanceCriteria) {
      if (!ac.id) throw new RequirementError('Every AC must have a stable id');
      if (seen.has(ac.id)) throw new RequirementError(`Duplicate AC id ${ac.id}`);
      seen.add(ac.id);
      if (!ac.expectedEvidence) throw new RequirementError(`AC ${ac.id} must declare expectedEvidence`);
    }

    const target: CompletionTarget = input.completionTarget ?? 'RELEASED_OUTCOME';
    if (target === 'VERIFIED_DELIVERY' && !input.releaseNaAuthorization) {
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
      acceptanceCriteria: input.acceptanceCriteria.map((a) => ({ ...a, version: 1 })),
      exclusions: input.exclusions ?? [],
      constraints: input.constraints ?? [],
      completionTarget: target,
      environments: input.environments ?? [],
      dataSecurityRequirements: input.dataSecurityRequirements ?? [],
      budget: input.budget ?? null,
      riskAuthorization: input.riskAuthorization ?? null,
      outcomeMeasurement: input.outcomeMeasurement ?? '',
      releaseNaAuthorization: input.releaseNaAuthorization ?? null,
    };
    const req: Requirement = { id, versions: [v1], status: 'ACTIVE', createdAt: now };
    this.requirements.set(id, req);
    this.links.set(this.linkKey(id, 1), freshLinks());
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
   */
  newVersion(
    id: string,
    changeKind: RequirementChangeKind,
    changeNote: string,
    createdBy: string,
    mutate: (draft: RequirementVersion) => void,
  ): RequirementVersion {
    const req = this.get(id);
    const prev = this.latest(id);
    const draft: RequirementVersion = JSON.parse(JSON.stringify(prev)) as RequirementVersion;
    mutate(draft);
    if (draft.completionTarget !== prev.completionTarget && changeKind !== 'TARGET_CHANGE') {
      throw new RequirementError(
        'completion_target changed without TARGET_CHANGE — use changeCompletionTarget() with human authorization',
      );
    }
    const next: RequirementVersion = {
      ...draft,
      version: prev.version + 1,
      createdAt: this.iso(),
      createdBy,
      changeKind,
      changeNote,
    };
    req.versions.push(next);
    this.links.set(this.linkKey(id, next.version), freshLinks());
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
    return this.newVersion(id, 'AC_REFINEMENT', `AC ${acId} refined`, by, (draft) => {
      const ac = draft.acceptanceCriteria.find((a) => a.id === acId);
      if (!ac) throw new RequirementError(`AC ${acId} not found in ${id}`);
      if (patch.description !== undefined) ac.description = patch.description;
      if (patch.expectedEvidence !== undefined) ac.expectedEvidence = patch.expectedEvidence;
      if (patch.verificationType !== undefined) ac.verificationType = patch.verificationType;
      ac.version += 1;
    });
  }

  /**
   * completion_target changes require a recorded HUMAN authorization.
   * The AI may not move the endpoint to reach Done faster (§16).
   */
  changeCompletionTarget(
    id: string,
    target: CompletionTarget,
    auth: { authorizedBy: string; isHuman: boolean; reason: string },
    by: string,
  ): RequirementVersion {
    if (!auth.isHuman) {
      throw new CompletionTargetChangeRejectedError(
        'completion_target change requires a recorded HUMAN authorization — AI may not move the endpoint',
      );
    }
    return this.newVersion(id, 'TARGET_CHANGE', `target → ${target}: ${auth.reason}`, by, (draft) => {
      draft.completionTarget = target;
      if (target === 'VERIFIED_DELIVERY') {
        draft.releaseNaAuthorization = {
          authorizedBy: auth.authorizedBy,
          reason: auth.reason,
          at: this.iso(),
        };
      }
    });
  }

  /** Record which entities are bound to a requirement version. */
  linkEntities(id: string, version: number, links: Partial<EntityLinks>): void {
    this.getVersion(id, version); // throws when missing
    const cur = this.links.get(this.linkKey(id, version)) ?? freshLinks();
    for (const [k, v] of Object.entries(links)) {
      if (Array.isArray(v)) (cur[k as keyof EntityLinks] as string[]).push(...(v as string[]));
    }
    this.links.set(this.linkKey(id, version), cur);
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
    const suspendedPromotions: PromotionHold[] = affected.taskIds.map((taskId) => {
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
    return hold;
  }

  listHolds(taskId?: string): PromotionHold[] {
    return taskId ? this.holds.filter((h) => h.taskId === taskId) : [...this.holds];
  }
}
