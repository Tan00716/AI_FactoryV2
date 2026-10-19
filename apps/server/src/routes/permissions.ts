/**
 * Permission-tier routes — W-C unified permission model.
 *
 *   GET  /api/permissions/tiers            list tiers + policies (seeds defaults)
 *   PUT  /api/permissions/tiers/:tier      {auto[], ask[], deny[]} — operator edit
 *   GET  /api/permissions/agents           list agent→tier assignments
 *   PUT  /api/permissions/agents/:agentId  {tier} — assign a tier
 *   POST /api/permissions/evaluate         {action, agentId?, tier?, riskLevel?}
 *        → {tier, tierVerdict, level, requiresApproval, reasons[], rule?}
 *        strictest-wins composition of the tier policy and the
 *        approvals engine (evaluateAction). A tier can only make an
 *        action MORE restrictive, never less: approvals-BLOCKED
 *        (e.g. 'secret.write') stays blocked for every tier.
 *        Optional {tool, target} dry-runs the declarative rules and
 *        reports the winning rule (or null) without executing.
 *   GET  /api/permissions/rules            three rule layers (project /
 *        personal / global) with paths, rules and corrupt flags
 *   PUT  /api/permissions/rules            {layer?, rules[]} — replace one
 *        layer's rules; audited as PERMISSION_RULE_CHANGED. The rules
 *        are enforced at the tool-runner choke point: a deny rule
 *        refuses the call even when approval was bypassed upstream.
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handlePermissionTierRoutes } from './routes/permissions';
 *   if (await handlePermissionTierRoutes(req, res, url, ctx)) return;
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PERMISSION_TIERS,
  defaultTierPolicy,
  evaluateTierPolicy,
  isPermissionTier,
  validateTierPolicy,
  type PermissionTier,
  type TierPolicy,
} from '@ai-factory/permissions';
import { evaluateAction, type RiskLevel } from '@ai-factory/approvals';
import type { RouteContext } from './context';
import {
  RULE_LAYER_NAMES,
  permissionRules,
  type RuleLayerName,
} from '../permission-rules';

const PREFIX = '/api/permissions';
const DEFAULT_AGENT_TIER: PermissionTier = 'write';

function nowIso(): string {
  return new Date().toISOString();
}

function isRiskLevel(v: unknown): v is RiskLevel {
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL';
}

function parseStoredPolicy(tier: PermissionTier, json: string): TierPolicy {
  try {
    const p = JSON.parse(json) as { auto?: string[]; ask?: string[]; deny?: string[] };
    const v = validateTierPolicy(p);
    if (v.ok) return { tier, ...v.policy };
  } catch {
    // fall through to default
  }
  return defaultTierPolicy(tier);
}

/** Load all tier policies, seeding defaults into the DB on first read. */
function loadPolicies(ctx: RouteContext): TierPolicy[] {
  const store = ctx.fdb.permissionTiers;
  const existing = new Map(store.listTierPolicies().map((r) => [r.tier, r.policyJson] as const));
  if (existing.size === 0) {
    for (const tier of PERMISSION_TIERS) {
      const p = defaultTierPolicy(tier);
      store.saveTierPolicy(tier, JSON.stringify({ auto: p.auto, ask: p.ask, deny: p.deny }), nowIso());
    }
    return PERMISSION_TIERS.map(defaultTierPolicy);
  }
  return PERMISSION_TIERS.map((tier) => {
    const json = existing.get(tier);
    return json === undefined ? defaultTierPolicy(tier) : parseStoredPolicy(tier, json);
  });
}

function policyOf(ctx: RouteContext, tier: PermissionTier): TierPolicy {
  return loadPolicies(ctx).find((p) => p.tier === tier) ?? defaultTierPolicy(tier);
}

export interface TierComposition {
  tier: PermissionTier;
  tierVerdict: 'auto' | 'ask' | 'deny';
  /** Effective approval level after strictest-wins composition. */
  level: 'AUTO' | 'ASK' | 'DENY';
  requiresApproval: boolean;
  reasons: string[];
}

/**
 * Strictest-wins composition of the tier policy and the approvals
 * engine. Exported for reuse (approvals /evaluate integration).
 */
export function composeTierDecision(
  ctx: RouteContext,
  action: string,
  tier: PermissionTier,
  riskLevel: RiskLevel = 'LOW',
): TierComposition {
  const reasons: string[] = [];
  const tierEval = evaluateTierPolicy(policyOf(ctx, tier), action);
  reasons.push(...tierEval.reasons);
  const approvalEval = evaluateAction(action, riskLevel);
  reasons.push(`approvals engine: ${approvalEval.reason}`);

  if (tierEval.verdict === 'deny') {
    return { tier, tierVerdict: 'deny', level: 'DENY', requiresApproval: false, reasons };
  }
  if (approvalEval.level === 'BLOCKED') {
    return { tier, tierVerdict: tierEval.verdict, level: 'DENY', requiresApproval: false, reasons };
  }
  const needsApproval = tierEval.verdict === 'ask' || approvalEval.requiresApproval;
  return {
    tier,
    tierVerdict: tierEval.verdict,
    level: needsApproval ? 'ASK' : 'AUTO',
    requiresApproval: needsApproval,
    reasons,
  };
}

export function resolveAgentTier(ctx: RouteContext, agentId?: string, tier?: string): PermissionTier {
  if (tier !== undefined) {
    if (!isPermissionTier(tier)) throw new Error(`tier must be one of: ${PERMISSION_TIERS.join(', ')}`);
    return tier;
  }
  if (agentId) {
    const row = ctx.fdb.permissionTiers.getAgentTier(agentId);
    if (row && isPermissionTier(row.tier)) return row.tier;
  }
  return DEFAULT_AGENT_TIER;
}

export async function handlePermissionTierRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const seg = path.slice(PREFIX.length).split('/').filter(Boolean);

  // GET /api/permissions/tiers
  if (method === 'GET' && seg.length === 1 && seg[0] === 'tiers') {
    const policies = loadPolicies(ctx);
    return ctx.json(res, 200, {
      tiers: policies.map((p) => ({ tier: p.tier, auto: p.auto, ask: p.ask, deny: p.deny })),
      defaultAgentTier: DEFAULT_AGENT_TIER,
    }), true;
  }

  // PUT /api/permissions/tiers/:tier
  if (method === 'PUT' && seg.length === 2 && seg[0] === 'tiers') {
    const tier = seg[1] as string;
    if (!isPermissionTier(tier)) {
      return ctx.json(res, 400, { error: `tier must be one of: ${PERMISSION_TIERS.join(', ')}` }), true;
    }
    const body = await ctx.readBody(req);
    const v = validateTierPolicy(body);
    if (!v.ok) return ctx.json(res, 400, { error: v.error }), true;
    const actor = (body['updatedBy'] as string | undefined) ?? 'human';
    ctx.fdb.permissionTiers.saveTierPolicy(tier, JSON.stringify(v.policy), nowIso());
    ctx.audit.record(actor, 'TIER_POLICY_UPDATED', 'permission_tier', tier, {
      auto: v.policy.auto.length,
      ask: v.policy.ask.length,
      deny: v.policy.deny.length,
    });
    return ctx.json(res, 200, { tier, ...v.policy }), true;
  }

  // GET /api/permissions/agents
  if (method === 'GET' && seg.length === 1 && seg[0] === 'agents') {
    return ctx.json(res, 200, {
      assignments: ctx.fdb.permissionTiers.listAgentTiers(),
      defaultTier: DEFAULT_AGENT_TIER,
    }), true;
  }

  // PUT /api/permissions/agents/:agentId
  if (method === 'PUT' && seg.length === 2 && seg[0] === 'agents') {
    const agentId = decodeURIComponent(seg[1] as string);
    const body = await ctx.readBody(req);
    const tier = body['tier'] as string | undefined;
    if (!isPermissionTier(tier)) {
      return ctx.json(res, 400, { error: `tier must be one of: ${PERMISSION_TIERS.join(', ')}` }), true;
    }
    const actor = (body['updatedBy'] as string | undefined) ?? 'human';
    ctx.fdb.permissionTiers.setAgentTier(agentId, tier, nowIso());
    ctx.audit.record(actor, 'AGENT_TIER_ASSIGNED', 'agent', agentId, { tier });
    return ctx.json(res, 200, { agentId, tier }), true;
  }

  // GET /api/permissions/rules — three layers + surviving paths
  if (method === 'GET' && seg.length === 1 && seg[0] === 'rules') {
    const layers = permissionRules().layers();
    return ctx.json(res, 200, {
      layers: layers.map((l) => ({ name: l.name, path: l.path, rules: l.rules, corrupt: l.corrupt })),
      layerNames: [...RULE_LAYER_NAMES],
    }), true;
  }

  // PUT /api/permissions/rules {layer?, rules[]} — replace one layer's rules
  if (method === 'PUT' && seg.length === 1 && seg[0] === 'rules') {
    const body = await ctx.readBody(req);
    const layer = (body['layer'] as string | undefined) ?? 'project';
    if (!(RULE_LAYER_NAMES as readonly string[]).includes(layer)) {
      return ctx.json(res, 400, { error: `layer must be one of: ${RULE_LAYER_NAMES.join(', ')}` }), true;
    }
    const actor = (body['updatedBy'] as string | undefined) ?? 'human';
    try {
      const { saved, warnings } = permissionRules().saveLayer(layer as RuleLayerName, body['rules']);
      ctx.audit.record(actor, 'PERMISSION_RULE_CHANGED', 'permission_rules', layer, {
        saved,
        warnings: warnings.length,
      });
      return ctx.json(res, 200, { layer, saved, warnings }), true;
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  // POST /api/permissions/evaluate
  if (method === 'POST' && seg.length === 1 && seg[0] === 'evaluate') {
    const body = await ctx.readBody(req);
    const action = body['action'] as string | undefined;
    if (typeof action !== 'string' || !action) {
      return ctx.json(res, 400, { error: 'action is required' }), true;
    }
    const riskLevel = body['riskLevel'] ?? body['risk_level'];
    if (riskLevel !== undefined && !isRiskLevel(riskLevel)) {
      return ctx.json(res, 400, { error: 'riskLevel must be LOW|MEDIUM|HIGH|CRITICAL' }), true;
    }
    try {
      const tier = resolveAgentTier(ctx, body['agentId'] as string | undefined, body['tier'] as string | undefined);
      const comp = composeTierDecision(ctx, action, tier, (riskLevel as RiskLevel) ?? 'LOW');
      // Optional declarative-rule dry-run: {tool: 'shell.execute', target: 'npm run build'}
      // reports the winning rule without executing anything.
      let rule: { effect: string; tool: string; pattern: string; layer: string } | null = null;
      const tool = body['tool'];
      if (typeof tool === 'string' && tool) {
        const target = typeof body['target'] === 'string' ? (body['target'] as string) : '';
        const v = permissionRules().evaluateRaw(tool, target);
        if (v !== undefined) {
          rule = { effect: v.effect, tool: v.rule.tool, pattern: v.rule.pattern, layer: v.layer };
        }
      }
      return ctx.json(res, 200, { action, ...comp, rule }), true;
    } catch (e) {
      return ctx.json(res, 400, { error: (e as Error).message }), true;
    }
  }

  return false;
}
