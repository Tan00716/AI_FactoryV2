/**
 * Shared policy types — SPEC v2 §23.1 (Policy Engine) 7-layer hierarchy.
 *
 * Global Policy → Organization → Project → Department → Agent → Task → Tool
 *
 * Cross-scope merge computes a *restrictive intersection*, not a simple
 * override file:
 *  - locked rules cannot be overridden by lower layers (deny is recorded);
 *  - deny wins: a deny value at any layer beats allows for that key;
 *  - numeric ceilings resolve to the strictest value (min for upper bounds,
 *    max for lower bounds) across all layers;
 *  - only rules explicitly marked overridable (locked: false) may be changed
 *    by an authorized lower layer — and the attempt is still recorded.
 * Nothing is ever silent: every conflict is recorded as an override attempt.
 */

/** §43 — the 7 policy layers, ordered from highest to lowest authority. */
export const POLICY_LAYERS = [
  'global',
  'organization',
  'project',
  'department',
  'agent',
  'task',
  'tool',
] as const;

export type PolicyLayer = (typeof POLICY_LAYERS)[number];

/**
 * Merge strategy for a single rule key across layers (§23.1 restrictive
 * intersection).
 *  - 'upper-wins': highest layer wins; lower-layer differences are recorded
 *    as override attempts (denied when the upper rule is locked). Default.
 *  - 'deny-wins': any layer holding the denyValue wins (deny prioritized).
 *  - 'strictest-min': numeric ceiling — the smallest value across layers wins.
 *  - 'strictest-max': numeric floor — the largest value across layers wins.
 */
export type PolicyMergeStrategy =
  | 'deny-wins'
  | 'strictest-min'
  | 'strictest-max'
  | 'upper-wins';

/** A single policy rule: the value plus merge metadata. */
export interface PolicyRule {
  value: unknown;
  /** Default true: upper-level keys win over lower-layer attempts. */
  locked: boolean;
  /**
   * Merge strategy for this key. Declared where the rule is set; the
   * highest layer declaring a non-default strategy wins the declaration.
   * Defaults to 'upper-wins'.
   */
  merge?: PolicyMergeStrategy;
  /**
   * The value that counts as "deny" for 'deny-wins' (e.g. 'denied' or false).
   * Required when merge is 'deny-wins'.
   */
  denyValue?: unknown;
}

/** The set of rules attached to one layer/scope. */
export interface LayerPolicy {
  rules: Record<string, PolicyRule>;
}

/**
 * Which scope an effective policy is resolved for. `layer` is the lowest
 * layer included; the id fields select the policy document at each layer.
 */
export interface PolicyScope {
  layer: PolicyLayer;
  organization?: string;
  project?: string;
  department?: string;
  agent?: string;
  task?: string;
  tool?: string;
}

/** Where an override attempt came from / what won. */
export interface OverrideEndpoint {
  layer: PolicyLayer;
  scopeId: string;
  value: unknown;
}

/**
 * One recorded override attempt: a lower layer tried to set a key that an
 * upper layer already defined. `allowed=false` → the upper-layer (locked)
 * value wins and the attempt lands in `denials`.
 */
export interface OverrideAttempt {
  key: string;
  attempted: OverrideEndpoint;
  winner: OverrideEndpoint;
  winnerLocked: boolean;
  /** false → recorded as an overrideDenied event (upper wins). */
  allowed: boolean;
  ts: string;
}

/** Result of resolveEffectivePolicy. */
export interface ResolvedPolicy {
  /** Final merged key → value map (restrictive intersection, §23.1). */
  policy: Record<string, unknown>;
  /**
   * §23.1 policy_hash: sha256 over the canonical evaluation inputs +
   * resolved policy, so a resolution can be pinned and re-verified.
   */
  policy_hash: string;
  /** §23.1 evaluation inputs: which documents were considered. */
  inputs: PolicyEvaluationInputs;
  /** §23.1 rule-hit detail per key: strategy, winner, contributing layers. */
  hits: Record<string, PolicyRuleHit>;
  /** Denied override attempts (locked upper keys) — never silent. */
  denials: OverrideAttempt[];
  /** All override attempts, denied and allowed. */
  attempts: OverrideAttempt[];
  scope: PolicyScope;
}

/** §23.1 — the evaluation inputs behind a resolution. */
export interface PolicyEvaluationInputs {
  scope: PolicyScope;
  /** Every layer document consulted, top-down. */
  documents: Array<{ layer: PolicyLayer; scopeId: string; keys: string[] }>;
}

/** §23.1 — which rules produced the winning value for one key. */
export interface PolicyRuleHit {
  key: string;
  strategy: PolicyMergeStrategy;
  winner: OverrideEndpoint;
  winnerLocked: boolean;
  /** All layers that set this key (top-down), win or lose. */
  contributing: OverrideEndpoint[];
}

/** Store-level events; 'overrideDenied' must never be dropped silently. */
export type PolicyEventKind = 'overrideDenied' | 'overrideAllowed';

export interface PolicyEvent {
  kind: PolicyEventKind;
  attempt: OverrideAttempt;
}

/** Input form accepted by PolicyStore.set: rule or bare value (locked). */
export type PolicyPatch = Record<string, unknown | PolicyRule>;

/** Scope id used for the single global-layer document. */
export const GLOBAL_SCOPE_ID = '__global__';
