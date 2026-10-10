/**
 * Permission engine — spec §44 (capability-based permissions), full version.
 *
 * Capability set is owned by @ai-factory/core (§44 prototype subset — it
 * already lists every capability from the spec examples); this module is the
 * complete check engine:
 *
 *   checkCapability({ agentPermissions, capability, context, effectivePolicy })
 *     → { decision: 'allow' | 'deny', reason, ... }
 *
 * Decision rules (in order):
 *  1. Unknown capability (not in ALL_PERMISSIONS) → deny.
 *  2. Agent lacks the capability → deny.
 *  3. Effective policy key `capability.<name>` = 'denied' → deny;
 *     = 'allowed' → allow (explicit policy grant).
 *  4. Effective policy key `security.production_write` = 'denied' and the
 *     call targets production → deny.
 *  5. Capabilities on the default-deny list (deploy.prod) → deny unless
 *     step 3 granted them explicitly. Production deployment is never granted
 *     by permission alone.
 *  6. Otherwise → allow.
 *
 * Every deny is reported through the `audit` hook (independently auditable,
 * per §44); allows are reported too when `auditAll` is set.
 */
import { ALL_PERMISSIONS, Permission } from '@ai-factory/core';

export type { Permission };

/** The full §44 capability list, re-exported from core (single source). */
export const ALL_CAPABILITIES: ReadonlyArray<Permission> = ALL_PERMISSIONS;

/**
 * Capabilities that default to deny even when the agent holds them —
 * they require an explicit `capability.<name>: allowed` policy grant.
 */
export const DEFAULT_DENIED_CAPABILITIES: ReadonlyArray<Permission> = ['deploy.prod'];

export interface CapabilityContext {
  /** Whether the action targets a production environment/resource. */
  production?: boolean;
  /** Resource identifier (path, URL, branch, environment name…). */
  resource?: string;
  /** Free-form note recorded with the decision. */
  note?: string;
}

export interface CapabilityCheckInput {
  agentId?: string;
  /** Capabilities granted to the agent (its Agent.permissions). */
  agentPermissions: Permission[];
  /** The capability being exercised. */
  capability: Permission;
  context?: CapabilityContext;
  /** Flat effective policy (see PolicyStore.resolveEffectivePolicy). */
  effectivePolicy?: Record<string, unknown>;
}

export interface CapabilityDecision {
  decision: 'allow' | 'deny';
  reason: string;
  capability: Permission;
  agentId?: string;
  ts: string;
}

export interface CapabilityCheckHooks {
  /** Called for every deny (independent audit trail, §44). */
  audit?: (decision: CapabilityDecision) => void;
  /** When true, the audit hook is also called for allows. */
  auditAll?: boolean;
}

function decision(
  dec: 'allow' | 'deny',
  capability: Permission,
  reason: string,
  agentId: string | undefined,
): CapabilityDecision {
  return { decision: dec, capability, reason, agentId, ts: new Date().toISOString() };
}

function policyValue(effectivePolicy: Record<string, unknown> | undefined, key: string): unknown {
  return effectivePolicy?.[key];
}

/**
 * Check whether an agent may exercise a capability. Returns allow/deny +
 * reason; every deny is passed to `hooks.audit` for the audit trail.
 */
export function checkCapability(
  input: CapabilityCheckInput,
  hooks?: CapabilityCheckHooks,
): CapabilityDecision {
  const { agentId, agentPermissions, capability, context, effectivePolicy } = input;

  const finish = (d: CapabilityDecision): CapabilityDecision => {
    if (d.decision === 'deny' || hooks?.auditAll) hooks?.audit?.(d);
    return d;
  };

  // 1. Unknown capability.
  if (!(ALL_PERMISSIONS as readonly string[]).includes(capability)) {
    return finish(
      decision('deny', capability, `unknown capability "${capability}" (not a §44 capability)`, agentId),
    );
  }

  // 2. Agent lacks the capability.
  if (!agentPermissions.includes(capability)) {
    return finish(
      decision(
        'deny',
        capability,
        `agent ${agentId ?? '<unknown>'} lacks capability "${capability}"`,
        agentId,
      ),
    );
  }

  // 3. Explicit policy grant/deny for this capability.
  const policyCap = policyValue(effectivePolicy, `capability.${capability}`);
  if (policyCap === 'denied') {
    return finish(
      decision('deny', capability, `policy denies capability "${capability}"`, agentId),
    );
  }
  if (policyCap === 'allowed') {
    return finish(
      decision('allow', capability, `explicitly granted by policy ("capability.${capability}"=allowed)`, agentId),
    );
  }

  // 4. Production write blocked by policy.
  const prodWrite = policyValue(effectivePolicy, 'security.production_write');
  if (context?.production === true && prodWrite === 'denied') {
    return finish(
      decision(
        'deny',
        capability,
        `policy denies production writes ("security.production_write"=denied)`,
        agentId,
      ),
    );
  }

  // 5. Default-deny capabilities (e.g. deploy.prod): permission alone is not
  //    enough; require an explicit policy grant (handled in step 3).
  if ((DEFAULT_DENIED_CAPABILITIES as readonly string[]).includes(capability)) {
    return finish(
      decision(
        'deny',
        capability,
        `"${capability}" is default-denied: it requires an explicit policy grant ` +
          `("capability.${capability}"=allowed)`,
        agentId,
      ),
    );
  }

  // 6. Granted.
  return finish(
    decision('allow', capability, `agent holds capability "${capability}"`, agentId),
  );
}

/** Convenience: true when checkCapability would allow (no audit hook). */
export function canPerform(input: CapabilityCheckInput): boolean {
  return checkCapability(input).decision === 'allow';
}
