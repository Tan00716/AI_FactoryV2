/**
 * Model router domain types — spec §30 (Model Router), §28 (Codex integration
 * profiles) and §29 (ChatGPT plan usage: one shared 5h pool, not per-agent).
 */

/** Relative context-window bucket; ordering is small < medium < large. */
export type ContextSize = 'small' | 'medium' | 'large';

/**
 * Data classification tiers, most → least sensitive (§26.1 允许数据分类 /
 * Privacy; §26.3: routing checks capability + privacy before optimizing,
 * and a fallback must never cross a data classification). Same vocabulary
 * as RouteRequest.privacy.
 */
export type DataClass = 'public' | 'internal' | 'sensitive';

/** What a model can do — the routing-relevant capability surface (§26.1). */
export interface ModelCapabilities {
  /** §26.1 Reasoning 设置. A boolean on purpose: the spec forbids treating
   *  provider reasoning strings/levels as cross-provider equivalents. */
  reasoning: boolean;
  /** §26.1 Vision. */
  vision: boolean;
  /** §26.1 工具调用 (tool calling). */
  tools: boolean;
  /** §26.1 Context (window bucket, not a token count). */
  maxContext: ContextSize;
  /**
   * §26.1 结构化输出 (structured output). Optional at the type level so
   * ModelRef literals elsewhere in the repo keep compiling; an undeclared
   * field is treated conservatively by the router as NOT capable.
   */
  structuredOutput?: boolean;
  /** §26.1 Streaming. Undeclared → treated as not capable. */
  streaming?: boolean;
  /** §26.1 Cancellation (an in-flight turn can be cancelled). Undeclared → not capable. */
  cancellation?: boolean;
  /** §26.1 Resume/Session (a session can be resumed/continued). Undeclared → not capable. */
  resume?: boolean;
  /**
   * §26.1 允许数据分类 / Privacy — the data classes this model is cleared
   * to see. Undeclared → the router falls back to the legacy provider rule
   * (local models cleared for every tier; shared-pool providers not
   * cleared for 'sensitive'), matching the §30 behavior that predates
   * this field.
   */
  dataClasses?: readonly DataClass[];
  /**
   * §26.1 Quota Bucket — the limit bucket this model draws from
   * (cf. §27.1: quota is recorded per Provider Account / Workspace /
   * Limit Bucket). Undeclared → unknown; never invent a bucket.
   */
  quotaBucket?: string;
  /**
   * §26.1 Supported Host — deployment hosts the model can run on
   * (e.g. 'local', 'shared-pool'). Undeclared → unknown (empty in views).
   */
  supportedHosts?: readonly string[];
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
  privacy: DataClass;
  needsReasoning: boolean;
  contextNeeded: ContextSize;
  needsVision: boolean;
  /**
   * §26.1 — optional capability requirements. Absent/false = not
   * required (pre-§26.1 request shapes behave exactly as before). When
   * set, candidates lacking the capability are hard-filtered and the
   * exclusion is named in the decision reason.
   */
  needsStructuredOutput?: boolean;
  /** §26.1 — the primary must be able to stream its output. */
  needsStreaming?: boolean;
  /** §26.1 — the primary's in-flight turns must be cancellable. */
  needsCancellation?: boolean;
  /** §26.1 — the primary must support resume/session continuation. */
  needsResume?: boolean;
  /**
   * §29 — current usage of the shared ChatGPT plan pool as a percentage.
   * The pool is SHARED across agents (single 5h window), so the router must
   * prefer local/fallback models as this approaches/exceeds 100.
   */
  currentUsage: { usedPct: number };
  /**
   * §27.2 — optional fallback-compatibility gate, INJECTED by the caller.
   * The router owns no quota/budget/data-class state (that lives in
   * @ai-factory/quota and its callers), so — exactly like the live
   * account-status injection in profile.ts — the check is supplied, never
   * imported. A one-line adapter over quota's
   * checkFallbackCompatibility(required, candidate) satisfies this type.
   * Absent → the fallback is the next-best candidate UNCHECKED, and the
   * decision reason says so ('fallback compatibility not checked').
   */
  fallbackChecker?: FallbackCompatibilityChecker;
}

/** §27.2 — verdict of an injected fallback-compatibility check. */
export interface FallbackCompatibilityVerdict {
  compatible: boolean;
  /** Why the candidate was rejected; empty when compatible. */
  reasons: string[];
}

/**
 * §27.2 — decides whether `candidate` may serve as fallback for
 * `primary` under `request`: capability, privacy/data-class, budget and
 * permission compatibility (the dimensions of quota's FallbackCheck).
 * The capability dimension is read off the candidate's full ModelRef,
 * which since Batch 8 carries the complete §26.1 metadata (structured
 * output, streaming, cancellation, resume, data classes, quota bucket,
 * supported hosts) — checker implementations may consult all of it.
 * Returning compatible=false must carry the reasons — a rejected fallback
 * is named in the decision reason, never silently skipped.
 */
export type FallbackCompatibilityChecker = (
  primary: ModelRef,
  candidate: ModelRef,
  request: RouteRequest,
) => FallbackCompatibilityVerdict;

/** §30 — every agent gets a primary, a fallback, and an emergency model. */
export interface RouteDecision {
  /**
   * Null when unavailable === true. INV-29: an unavailable provider is
   * reported explicitly — never silently replaced by a "success".
   */
  primary: ModelRef | null;
  fallback: ModelRef | null;
  emergency: ModelRef | null;
  /** Human-readable trace of which rules fired, in order. */
  reason: string;
  /**
   * INV-29 — true when no catalog model satisfied the hard constraints
   * (e.g. every candidate is offline). Callers MUST check this before
   * using primary/fallback/emergency.
   */
  unavailable: boolean;
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
