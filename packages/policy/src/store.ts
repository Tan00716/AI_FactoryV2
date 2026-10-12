/**
 * PolicyStore — SPEC v2 §23.1 (Policy Engine).
 *
 * Holds one policy document per (layer, scopeId) and resolves the effective
 * policy for a scope by computing a *restrictive intersection* across layers
 * (Global → Tool), not a simple override file:
 *
 *  - locked rules: a lower layer cannot override an upper locked rule —
 *    the attempt is denied and recorded (overrideDenied), never silent;
 *  - deny wins: for keys merged with 'deny-wins', a deny value at any layer
 *    beats allows;
 *  - numeric ceilings: 'strictest-min' / 'strictest-max' resolve to the most
 *    restrictive value across all layers;
 *  - only rules explicitly marked overridable ({ locked: false }) may be
 *    changed by an authorized lower layer — the attempt is still recorded
 *    (overrideAllowed).
 *  - write gate: set() itself is guarded — replacing a document may not
 *    rewrite, delete or unlock an existing locked rule unless the caller
 *    carries authority at that layer or higher (PolicySetDeniedError).
 *
 * Resolution returns policy_hash (sha256 over canonical inputs + result),
 * the evaluation inputs, and per-key rule-hit detail (§23.1).
 */
import { createHash } from 'node:crypto';
import {
  GLOBAL_SCOPE_ID,
  LayerPolicy,
  OverrideAttempt,
  OverrideEndpoint,
  POLICY_LAYERS,
  PolicyEvaluationInputs,
  PolicyEvent,
  PolicyEventKind,
  PolicyLayer,
  PolicyMergeStrategy,
  PolicyPatch,
  PolicyRule,
  PolicyRuleHit,
  PolicyScope,
  PolicySetCaller,
  PolicySetOptions,
  ResolvedPolicy,
} from './types';

/**
 * Thrown by PolicyStore.set() when the patch would rewrite, delete or
 * unlock an existing locked rule without a caller of sufficient authority
 * (§23.1). The store is left completely unchanged (atomic rejection) and
 * every protected key has already been recorded as an overrideDenied
 * event on the store.
 */
export class PolicySetDeniedError extends Error {
  readonly layer: PolicyLayer;
  readonly scopeId: string;
  /** Keys whose existing rules are locked and were protected. */
  readonly protectedKeys: string[];
  readonly caller?: PolicySetCaller;

  constructor(layer: PolicyLayer, scopeId: string, protectedKeys: string[], caller?: PolicySetCaller) {
    super(
      `policy set denied at ${layer}/${scopeId}: locked rule(s) [${protectedKeys.join(', ')}] ` +
        `may only be changed by a caller with ${layer}-layer or higher authority` +
        (caller ? ` (got actor '${caller.actor}' at layer '${caller.layer}')` : ' (no caller given)'),
    );
    this.name = 'PolicySetDeniedError';
    this.layer = layer;
    this.scopeId = scopeId;
    this.protectedKeys = protectedKeys;
    this.caller = caller;
  }
}

function isRule(v: unknown): v is PolicyRule {
  return (
    typeof v === 'object' &&
    v !== null &&
    'value' in v &&
    'locked' in v &&
    typeof (v as PolicyRule).locked === 'boolean'
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function scopeIdFor(layer: PolicyLayer, scope: PolicyScope): string {
  switch (layer) {
    case 'global':
      return GLOBAL_SCOPE_ID;
    case 'organization':
      return scope.organization ?? GLOBAL_SCOPE_ID;
    case 'project':
      return scope.project ?? GLOBAL_SCOPE_ID;
    case 'department':
      return scope.department ?? GLOBAL_SCOPE_ID;
    case 'agent':
      return scope.agent ?? GLOBAL_SCOPE_ID;
    case 'task':
      return scope.task ?? GLOBAL_SCOPE_ID;
    case 'tool':
      return scope.tool ?? GLOBAL_SCOPE_ID;
  }
}

/** Canonical JSON: sorted keys, stable for hashing. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

interface Candidate {
  layer: PolicyLayer;
  scopeId: string;
  rule: PolicyRule;
}

export class PolicyStore {
  private layers = new Map<PolicyLayer, Map<string, LayerPolicy>>();
  private listeners = new Map<PolicyEventKind, Array<(e: PolicyEvent) => void>>();

  /** All recorded events (overrideDenied / overrideAllowed), in order. */
  readonly events: PolicyEvent[] = [];

  /** Subscribe to override events (denies and allowed overrides alike). */
  on(kind: PolicyEventKind, fn: (e: PolicyEvent) => void): void {
    const arr = this.listeners.get(kind) ?? [];
    arr.push(fn);
    this.listeners.set(kind, arr);
  }

  private emit(kind: PolicyEventKind, attempt: OverrideAttempt): void {
    const event: PolicyEvent = { kind, attempt };
    this.events.push(event);
    for (const fn of this.listeners.get(kind) ?? []) fn(event);
  }

  /**
   * Set (or replace) the policy document for a layer/scope. Bare values are
   * stored as locked rules; pass `{ value, locked, merge?, denyValue? }` for
   * finer control, or set the store-wide `locked` option for the whole patch.
   *
   * §23.1 write gate: because set() replaces the whole document, it must
   * not silently rewrite a locked rule. If the existing document holds a
   * locked rule that this patch would change (different value/merge/
   * denyValue), unlock, or drop, the set requires `opts.caller` /
   * `opts.authorizedBy` with authority at this layer or higher — see
   * PolicySetCaller. Without sufficient authority the set is rejected
   * atomically (PolicySetDeniedError, store untouched) and each protected
   * key is recorded as an overrideDenied event; an authorized change is
   * recorded as overrideAllowed. Sets that touch no existing locked rule
   * (first configuration, unlocked rules, additions, tightening a rule to
   * locked) behave exactly as before and need no caller.
   */
  set(layer: PolicyLayer, scopeId: string, patch: PolicyPatch, opts?: PolicySetOptions): void {
    const defaultLocked = opts?.locked ?? true;
    const rules: Record<string, PolicyRule> = {};
    for (const [key, v] of Object.entries(patch)) {
      if (isRule(v)) {
        const rule: PolicyRule = { value: v.value, locked: v.locked };
        if (v.merge !== undefined) rule.merge = v.merge;
        if (v.denyValue !== undefined) rule.denyValue = v.denyValue;
        rules[key] = rule;
      } else {
        rules[key] = { value: v, locked: defaultLocked };
      }
    }
    this.guardLockedRules(layer, scopeId, rules, opts?.caller ?? opts?.authorizedBy);
    let byScope = this.layers.get(layer);
    if (!byScope) {
      byScope = new Map();
      this.layers.set(layer, byScope);
    }
    byScope.set(scopeId, { rules });
  }

  /**
   * §23.1 write gate for set(): find existing locked rules of the target
   * document that the new document would change, unlock or drop, and
   * require sufficient caller authority for them. Runs entirely before
   * any mutation, so a denial leaves the store byte-identical.
   */
  private guardLockedRules(
    layer: PolicyLayer,
    scopeId: string,
    nextRules: Record<string, PolicyRule>,
    caller: PolicySetCaller | undefined,
  ): void {
    const existing = this.layers.get(layer)?.get(scopeId);
    if (!existing) return;
    const protectedKeys = Object.keys(existing.rules).filter((key) => {
      const old = existing.rules[key];
      if (!old.locked) return false;
      const next = nextRules[key];
      // Dropping the key, or any change to value/locked/merge/denyValue.
      return next === undefined || canonicalJson(next) !== canonicalJson(old);
    });
    if (protectedKeys.length === 0) return;

    const authorized = this.isSetAuthorized(layer, scopeId, caller);
    const ts = new Date().toISOString();
    for (const key of protectedKeys) {
      const old = existing.rules[key];
      const next = nextRules[key];
      this.emit(authorized ? 'overrideAllowed' : 'overrideDenied', {
        key,
        attempted: { layer, scopeId, value: next?.value },
        winner: authorized
          ? { layer, scopeId, value: next?.value }
          : { layer, scopeId, value: old.value },
        winnerLocked: authorized ? (next?.locked ?? false) : true,
        allowed: authorized,
        actor: caller?.actor ?? 'anonymous',
        ts,
      });
    }
    if (!authorized) throw new PolicySetDeniedError(layer, scopeId, protectedKeys, caller);
  }

  /**
   * §23.1 authority mapping: POLICY_LAYERS is ordered highest-first, so a
   * caller may rewrite locked rules of `layer` only when its own layer
   * index is ≤ the target layer's index (same layer or above). A caller
   * acting at the *same* layer and naming a scopeId is confined to that
   * scope — a peer scope cannot rewrite another scope's locked rules.
   */
  private isSetAuthorized(
    layer: PolicyLayer,
    scopeId: string,
    caller: PolicySetCaller | undefined,
  ): boolean {
    if (!caller) return false;
    const callerIdx = POLICY_LAYERS.indexOf(caller.layer);
    const targetIdx = POLICY_LAYERS.indexOf(layer);
    if (callerIdx < 0 || callerIdx > targetIdx) return false;
    if (caller.layer === layer && caller.scopeId !== undefined && caller.scopeId !== scopeId) {
      return false;
    }
    return true;
  }

  /** Get the raw policy document for a layer/scope (undefined when absent). */
  get(layer: PolicyLayer, scopeId: string): LayerPolicy | undefined {
    return this.layers.get(layer)?.get(scopeId);
  }

  /**
   * Resolve the effective policy for a scope: restrictive intersection over
   * layers top-down (§23.1). Returns the merged policy plus policy_hash,
   * evaluation inputs, per-key rule hits, and recorded override attempts.
   */
  resolveEffectivePolicy(scope: PolicyScope): ResolvedPolicy {
    const target = POLICY_LAYERS.indexOf(scope.layer);
    if (target < 0) throw new Error(`unknown policy layer: ${scope.layer}`);

    // Gather per-key candidates top-down, plus the evaluation inputs.
    const perKey = new Map<string, Candidate[]>();
    const documents: PolicyEvaluationInputs['documents'] = [];
    for (let li = 0; li <= target; li++) {
      const layer = POLICY_LAYERS[li];
      const scopeId = scopeIdFor(layer, scope);
      const doc = this.get(layer, scopeId);
      documents.push({ layer, scopeId, keys: doc ? Object.keys(doc.rules) : [] });
      if (!doc) continue;
      for (const [key, rule] of Object.entries(doc.rules)) {
        const list = perKey.get(key) ?? [];
        list.push({ layer, scopeId, rule });
        perKey.set(key, list);
      }
    }

    const policy: Record<string, unknown> = {};
    const hits: Record<string, PolicyRuleHit> = {};
    const attempts: OverrideAttempt[] = [];
    const denials: OverrideAttempt[] = [];

    for (const [key, candidates] of perKey) {
      const strategy = this.strategyFor(candidates);
      const endpoints = candidates.map(
        (c): OverrideEndpoint => ({ layer: c.layer, scopeId: c.scopeId, value: c.rule.value }),
      );
      const winner = this.mergeKey(key, candidates, strategy, attempts, denials);
      policy[key] = winner.value;
      hits[key] = {
        key,
        strategy,
        winner,
        winnerLocked: candidates.find((c) => c.layer === winner.layer)?.rule.locked ?? false,
        contributing: endpoints,
      };
    }

    const inputs: PolicyEvaluationInputs = { scope, documents };
    const policy_hash = createHash('sha256')
      .update(canonicalJson({ inputs, policy }))
      .digest('hex');
    return { policy, policy_hash, inputs, hits, denials, attempts, scope };
  }

  /**
   * The merge strategy for a key: the highest layer that declares a
   * non-default strategy wins the declaration; otherwise 'upper-wins'.
   */
  private strategyFor(candidates: Candidate[]): PolicyMergeStrategy {
    for (const c of candidates) {
      if (c.rule.merge && c.rule.merge !== 'upper-wins') return c.rule.merge;
    }
    return 'upper-wins';
  }

  private mergeKey(
    key: string,
    candidates: Candidate[],
    strategy: PolicyMergeStrategy,
    attempts: OverrideAttempt[],
    denials: OverrideAttempt[],
  ): OverrideEndpoint {
    const endpoint = (c: Candidate): OverrideEndpoint => ({
      layer: c.layer,
      scopeId: c.scopeId,
      value: c.rule.value,
    });

    if (strategy === 'deny-wins') {
      const declarer = candidates.find((c) => c.rule.merge === 'deny-wins');
      const denyValue = declarer?.rule.denyValue;
      if (denyValue === undefined) {
        throw new Error(`policy key '${key}': merge 'deny-wins' requires denyValue`);
      }
      const denied = candidates.filter((c) => deepEqual(c.rule.value, denyValue));
      if (denied.length > 0) {
        // Deny prioritized: the highest deny wins; no override attempt needed —
        // this is intersection, not an override.
        return endpoint(denied[0]);
      }
      // No deny present: fall through to upper-wins among the allows.
      return this.mergeUpperWins(key, candidates, attempts, denials);
    }

    if (strategy === 'strictest-min' || strategy === 'strictest-max') {
      const nums = candidates.map((c) => c.rule.value);
      if (!nums.every((v) => typeof v === 'number')) {
        throw new Error(
          `policy key '${key}': merge '${strategy}' requires all numeric values`,
        );
      }
      const best =
        strategy === 'strictest-min'
          ? Math.min(...(nums as number[]))
          : Math.max(...(nums as number[]));
      const winner = candidates.find((c) => c.rule.value === best) ?? candidates[0];
      return endpoint(winner);
    }

    return this.mergeUpperWins(key, candidates, attempts, denials);
  }

  /**
   * Default strategy: walk top-down tracking the currently effective rule.
   * Every lower-layer difference against the effective rule is recorded.
   * A locked effective rule denies the attempt (upper wins); an unlocked one
   * allows the override — the lower rule then becomes effective for the
   * layers below it. Identical values are not conflicts.
   */
  private mergeUpperWins(
    key: string,
    candidates: Candidate[],
    attempts: OverrideAttempt[],
    denials: OverrideAttempt[],
  ): OverrideEndpoint {
    let effective = candidates[0];
    for (const c of candidates.slice(1)) {
      if (deepEqual(effective.rule.value, c.rule.value)) continue;
      const attempt: OverrideAttempt = {
        key,
        attempted: { layer: c.layer, scopeId: c.scopeId, value: c.rule.value },
        winner: { layer: effective.layer, scopeId: effective.scopeId, value: effective.rule.value },
        winnerLocked: effective.rule.locked,
        allowed: !effective.rule.locked,
        ts: new Date().toISOString(),
      };
      attempts.push(attempt);
      if (effective.rule.locked) {
        this.emit('overrideDenied', attempt);
        denials.push(attempt);
      } else {
        this.emit('overrideAllowed', attempt);
        effective = c;
      }
    }
    return { layer: effective.layer, scopeId: effective.scopeId, value: effective.rule.value };
  }
}
