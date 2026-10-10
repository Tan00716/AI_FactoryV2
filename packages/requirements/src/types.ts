/**
 * Requirement as a first-class artifact — SPEC_V2 §16.
 *
 * A Requirement has a persistent id (REQ-001) and IMMUTABLE versions
 * (REQ-001@1 → REQ-001@2 never overwrites the old record). Every AC has a
 * stable id, version, verification type, verification responsibility,
 * expected evidence and applicable environments.
 */

export type CompletionTarget =
  | 'IMPLEMENTATION'
  | 'VERIFIED_DELIVERY'
  | 'RELEASED_OUTCOME';

export type VerificationType =
  | 'AUTOMATED_TEST'
  | 'HUMAN_REVIEW'
  | 'SECURITY_SCAN'
  | 'PERFORMANCE_TEST'
  | 'UAT'
  | 'STATIC_ANALYSIS'
  | 'MANUAL_VERIFICATION';

export type VerificationResponsibility =
  | 'INDEPENDENT_QA'
  | 'REVIEWER'
  | 'SECURITY'
  | 'HUMAN_OWNER'
  | 'CI'
  | 'AI_PM';

export interface AcceptanceCriterion {
  /** Stable id, e.g. 'AC-001' — never reused for a different criterion. */
  id: string;
  /** AC-local version, bumped on refinement. */
  version: number;
  description: string;
  verificationType: VerificationType;
  verifiedBy: VerificationResponsibility;
  /** What evidence must exist, e.g. 'qa_result with verdict PASS'. */
  expectedEvidence: string;
  applicableEnvironments: string[];
}

export type RequirementChangeKind =
  | 'INITIAL'
  | 'AC_REFINEMENT'
  | 'SCOPE_CHANGE'
  | 'TARGET_CHANGE'
  | 'CORRECTION';

export interface RequirementVersion {
  /** Immutable version number: 1, 2, 3… */
  version: number;
  createdAt: string;
  createdBy: string;
  changeKind: RequirementChangeKind;
  changeNote: string;
  businessGoal: string;
  rationale: string;
  acceptanceCriteria: AcceptanceCriterion[];
  exclusions: string[];
  constraints: string[];
  completionTarget: CompletionTarget;
  environments: string[];
  dataSecurityRequirements: string[];
  budget: { amount: number; currency: string } | null;
  riskAuthorization: string | null;
  outcomeMeasurement: string;
  /**
   * Required when completionTarget is VERIFIED_DELIVERY: release is marked
   * NOT_APPLICABLE and the authorization basis is recorded (§16).
   */
  releaseNaAuthorization: {
    authorizedBy: string;
    reason: string;
    at: string;
  } | null;
}

export interface Requirement {
  id: string;
  /** Append-only. Index 0 is always version 1. */
  versions: RequirementVersion[];
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
}

export interface CreateRequirementInput {
  id?: string;
  businessGoal: string;
  rationale?: string;
  acceptanceCriteria: Array<Omit<AcceptanceCriterion, 'version'>>;
  exclusions?: string[];
  constraints?: string[];
  completionTarget?: CompletionTarget;
  environments?: string[];
  dataSecurityRequirements?: string[];
  budget?: { amount: number; currency: string } | null;
  riskAuthorization?: string | null;
  outcomeMeasurement?: string;
  releaseNaAuthorization?: RequirementVersion['releaseNaAuthorization'];
  createdBy: string;
}

/** Entity refs bound to one requirement version (for impact analysis). */
export interface EntityLinks {
  planIds: string[];
  taskIds: string[];
  codeRefs: string[];
  testIds: string[];
  evidenceIds: string[];
  approvalIds: string[];
  releaseIds: string[];
}

export interface PromotionHold {
  id: string;
  taskId: string;
  requirementId: string;
  requirementVersion: number;
  reason: string;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  revalidationNote: string | null;
}

export interface EvidenceCompatibility {
  evidenceId: string;
  requirementId: string;
  requirementVersion: number;
  compatible: boolean;
  checkedBy: string;
  at: string;
  basis: string;
}

export interface ImpactAnalysis {
  requirementId: string;
  fromVersion: number;
  toVersion: number;
  acAdded: string[];
  acRemoved: string[];
  acChanged: string[];
  affected: EntityLinks;
  /** Approvals bound to the old version → must be re-approved (STALE). */
  staleApprovals: string[];
  /** Gate refs that must be re-evaluated (derived from affected tasks). */
  staleGates: string[];
  /** Promotions suspended until re-planning / re-authorization. */
  suspendedPromotions: PromotionHold[];
  /** Evidence explicitly compatibility-checked for the new version. */
  evidenceReusable: string[];
  /** Evidence that must NOT be silently reused (no v1 PASS on v2 tasks). */
  evidenceStale: string[];
  analyzedAt: string;
  analyzedBy: string;
}
