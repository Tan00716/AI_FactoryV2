/**
 * Shared policy types — spec §43 (Policy Engine) 7-layer hierarchy.
 *
 * Global Policy → Organization → Project → Department → Agent → Task → Tool
 *
 * Higher-level policies cannot be silently overridden by lower-level AI
 * instructions: every key set by an upper layer is inherited downward, and
 * a lower layer that attempts to set the same key to a different value is
 * recorded as an override attempt. Locked upper-layer keys win outright
 * (overrideDenied); unlocked ones may be overridden but the attempt is
 * still recorded (overrideAllowed) — nothing is ever silent.
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

/** A single policy rule: the value plus whether lower layers may override it. */
export interface PolicyRule {
  value: unknown;
  /** Default true: upper-level keys win over lower-layer attempts. */
  locked: boolean;
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
  /** Final merged key → value map (upper layers won every conflict). */
  policy: Record<string, unknown>;
  /** Denied override attempts (locked upper keys) — never silent. */
  denials: OverrideAttempt[];
  /** All override attempts, denied and allowed. */
  attempts: OverrideAttempt[];
  scope: PolicyScope;
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
