/**
 * PolicyStore — spec §43 (Policy Engine).
 *
 * Holds one policy document per (layer, scopeId) and resolves the effective
 * policy for a scope by merging layers top-down (Global → Tool). Upper
 * layers always win: a lower layer that sets a key already defined above to
 * a different value triggers a recorded override attempt. Locked upper keys
 * (the default) deny the attempt outright (overrideDenied event + denials
 * entry); unlocked upper keys may be overridden but the attempt is still
 * recorded (overrideAllowed event) — never silently.
 */
import {
  GLOBAL_SCOPE_ID,
  LayerPolicy,
  OverrideAttempt,
  OverrideEndpoint,
  POLICY_LAYERS,
  PolicyEvent,
  PolicyEventKind,
  PolicyLayer,
  PolicyPatch,
  PolicyRule,
  PolicyScope,
  ResolvedPolicy,
} from './types';

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
   * stored as locked rules; pass `{ value, locked: false }` for rules that a
   * lower layer may override (the override is still recorded), or set the
   * store-wide `locked` option for the whole patch.
   */
  set(layer: PolicyLayer, scopeId: string, patch: PolicyPatch, opts?: { locked?: boolean }): void {
    const defaultLocked = opts?.locked ?? true;
    const rules: Record<string, PolicyRule> = {};
    for (const [key, v] of Object.entries(patch)) {
      rules[key] = isRule(v) ? { value: v.value, locked: v.locked } : { value: v, locked: defaultLocked };
    }
    let byScope = this.layers.get(layer);
    if (!byScope) {
      byScope = new Map();
      this.layers.set(layer, byScope);
    }
    byScope.set(scopeId, { rules });
  }

  /** Get the raw policy document for a layer/scope (undefined when absent). */
  get(layer: PolicyLayer, scopeId: string): LayerPolicy | undefined {
    return this.layers.get(layer)?.get(scopeId);
  }

  /**
   * Resolve the effective policy for a scope: merge layers top-down, upper
   * wins. Every lower-layer attempt to change an upper-defined key is
   * recorded; locked upper keys deny it. Returns { policy, denials }.
   */
  resolveEffectivePolicy(scope: PolicyScope): ResolvedPolicy {
    const target = POLICY_LAYERS.indexOf(scope.layer);
    if (target < 0) throw new Error(`unknown policy layer: ${scope.layer}`);

    const merged: Record<string, PolicyRule> = {};
    const origin: Record<string, PolicyLayer> = {};
    const attempts: OverrideAttempt[] = [];
    const denials: OverrideAttempt[] = [];

    for (let li = 0; li <= target; li++) {
      const layer = POLICY_LAYERS[li];
      const scopeId = scopeIdFor(layer, scope);
      const doc = this.get(layer, scopeId);
      if (!doc) continue;
      for (const [key, rule] of Object.entries(doc.rules)) {
        const existing = merged[key];
        if (!existing) {
          merged[key] = { value: rule.value, locked: rule.locked };
          origin[key] = layer;
          continue;
        }
        if (deepEqual(existing.value, rule.value)) continue; // same value: no conflict
        const winnerLayer = origin[key];
        const endpoint = (l: PolicyLayer, v: unknown): OverrideEndpoint => ({
          layer: l,
          scopeId: scopeIdFor(l, scope),
          value: v,
        });
        const attempt: OverrideAttempt = {
          key,
          attempted: endpoint(layer, rule.value),
          winner: endpoint(winnerLayer, existing.value),
          winnerLocked: existing.locked,
          allowed: !existing.locked,
          ts: new Date().toISOString(),
        };
        attempts.push(attempt);
        if (existing.locked) {
          // Upper layer wins; the attempt is denied and recorded.
          this.emit('overrideDenied', attempt);
          denials.push(attempt);
        } else {
          // Upper key explicitly unlockable: allow, but still recorded.
          this.emit('overrideAllowed', attempt);
          merged[key] = { value: rule.value, locked: rule.locked };
          origin[key] = layer;
        }
      }
    }

    const policy: Record<string, unknown> = {};
    for (const [key, rule] of Object.entries(merged)) policy[key] = rule.value;
    return { policy, denials, attempts, scope };
  }
}
