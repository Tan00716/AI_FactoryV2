/**
 * Model router domain types — spec §30 (Model Router), §28 (Codex integration
 * profiles) and §29 (ChatGPT plan usage: one shared 5h pool, not per-agent).
 */

/** Relative context-window bucket; ordering is small < medium < large. */
export type ContextSize = 'small' | 'medium' | 'large';

/** What a model can do — the routing-relevant capability surface. */
export interface ModelCapabilities {
  reasoning: boolean;
  vision: boolean;
  tools: boolean;
  maxContext: ContextSize;
}

/**
 * Provider-independent model reference. `provider` is a logical label
 * ('local' for on-device/private models, otherwise a shared-pool provider);
 * no vendor SDKs are referenced here — see the runtime adapters (spec §27).
 */
export interface ModelRef {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  costTier: 'low' | 'high';
  latencyTier: 'low' | 'high';
  /**
   * §90 — operational availability for the Model Registry UI.
   * Optional so existing catalog literals keep compiling.
   */
  availability?: 'online' | 'degraded' | 'offline';
  /**
   * §90 — fallback model reference for this model, e.g. 'local:local-private'.
   * Optional; the router's own primary/fallback/emergency decision (§30) is
   * independent of this display hint.
   */
  fallback?: string;
}

/** §30 — task types the router distinguishes. */
export type TaskType =
  | 'classification'
  | 'coding'
  | 'architecture'
  | 'vision'
  | 'testing'
  | 'review'
  | 'research';

/** §30 — routing inputs. */
export interface RouteRequest {
  taskType: TaskType;
  complexity: 1 | 2 | 3 | 4 | 5;
  requiredTools: string[];
  /** 'low' = prefer low latency; 'high' = latency is not a concern. */
  latencyPref: 'low' | 'high';
  /** 'low' = prefer cheap; 'high' = cost is not a concern. */
  costPref: 'low' | 'high';
  privacy: 'public' | 'internal' | 'sensitive';
  needsReasoning: boolean;
  contextNeeded: ContextSize;
  needsVision: boolean;
  /**
   * §29 — current usage of the shared ChatGPT plan pool as a percentage.
   * The pool is SHARED across agents (single 5h window), so the router must
   * prefer local/fallback models as this approaches/exceeds 100.
   */
  currentUsage: { usedPct: number };
}

/** §30 — every agent gets a primary, a fallback, and an emergency model. */
export interface RouteDecision {
  primary: ModelRef;
  fallback: ModelRef;
  emergency: ModelRef;
  /** Human-readable trace of which rules fired, in order. */
  reason: string;
}

/** §28 — authentication/runtime profiles; never force everything onto an API key. */
export type ProviderKind = 'chatgpt-oauth' | 'api-key' | 'local' | 'other';

export interface ProviderProfile {
  kind: ProviderKind;
  /** Connected account identifier, e.g. the ChatGPT account email. */
  account?: string;
  /** Plan label, e.g. 'ChatGPT Plus'. */
  plan?: string;
  usageNote?: string;
}

/** §29 — what the UI must display: connected account, plan, usage, auth status. */
export interface AccountStatus {
  profile: ProviderProfile;
  usage: {
    /** Percentage of the shared 5h pool consumed. */
    usedPct: number;
    /** Human-readable reset/window information. */
    resetInfo: string;
    authenticated: boolean;
  };
}
