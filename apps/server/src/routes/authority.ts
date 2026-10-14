/**
 * Authority conflict routes — spec §8.1, INV-31.
 *
 *  POST /api/authority/directives              register a principal's directive
 *  GET  /api/authority/conflicts[?status=]     list conflicts
 *  GET  /api/authority/conflicts/:id           one conflict with its directives
 *  POST /api/authority/conflicts/:id/resolve   human escalation decision
 *  GET  /api/authority/targets/:kind/:id       directives + open conflict + paused flag
 *
 * The registry is the Authority check (who may order what). Policy and
 * Scheduler stay their own engines. Principal identity is asserted by the
 * caller and recorded in audit — it is not cryptographically verified here
 * (documented boundary).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  AuthorityConflictRegistry,
  AUTHORITY_RANK,
  type AuthorityAuditEvent,
  type AuthorityConflict,
  type AuthorityLevel,
  type DirectiveEffect,
  type AuthorityTargetKind,
} from '@ai-factory/policy';
import { needsHuman } from '@ai-factory/autonomy';
import type { FactoryDatabase } from '@ai-factory/db';
import type { NeedsHumanDbRecord } from '@ai-factory/db';
import type { RouteContext } from './context';

/**
 * The registry emits its own audit events (registration, detection,
 * auto-resolution, human resolution, supersede, attach). They are buffered
 * here and flushed into the server audit log by each handler — the
 * registry itself stays storage-agnostic.
 */
const pendingAudit: AuthorityAuditEvent[] = [];

/**
 * §81 emission buffer (Batch 36): upgrade records built synchronously by
 * the registry's onConflictOpened hook, written through to fdb by the
 * directive handler after the conflict response is committed. A failed
 * write-through is audited (NEEDS_HUMAN_PERSIST_FAILED) — it never
 * rolls back the conflict record itself.
 */
const pendingUpgrades: NeedsHumanDbRecord[] = [];

let needsHumanDb: FactoryDatabase | null = null;

const LEVEL_BY_RANK: Record<number, AuthorityLevel> = {
  4: 'owner',
  3: 'security_authority',
  2: 'manager',
  1: 'operator',
  0: 'viewer',
};

/**
 * Build the §81 'ai-disagreement' upgrade record for a freshly-opened
 * conflict. Two equally-valid, incompatible directives from same-rank
 * principals is the determinate §81 trigger with a server emission
 * point; the other seven §81 triggers have no emitter (honest).
 *
 * recipient is null: the server has coarse-grained token RBAC with no
 * named human accounts, so we record the required level instead of
 * inventing a person. requiredDeciderLevel is strictly higher than both
 * parties (the §8.1 upward rule).
 *
 * Exported as a test seam (like every other §81 builder) so the
 * F19 narrative persistence can be asserted at the builder level.
 */
export function buildUpgradeRecord(
  conflict: AuthorityConflict,
  registry: AuthorityConflictRegistry,
): NeedsHumanDbRecord {
  const directives = conflict.directiveIds
    .map((id) => registry.getDirective(id))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const ranks = directives.map((d) => AUTHORITY_RANK[d.authorityLevel] ?? 0);
  const maxRank = ranks.length > 0 ? Math.max(...ranks) : 0;
  const maxLevel = LEVEL_BY_RANK[maxRank] ?? 'viewer';
  const requiredLevel = LEVEL_BY_RANK[maxRank + 1];
  const deadlocked = requiredLevel === undefined;
  const effects = directives.map((d) => d.effect);
  const target = `${conflict.targetKind}:${conflict.targetId}`;

  // F19 follow-up (Batch 45): the honest narrative must survive persistence —
  // it goes in detailJson as `narrative` (the transient `detail` field is not
  // persisted; NeedsHumanDbRecord has no `detail` column).
  const narrative =
    `AUTHORITY_CONFLICT ${conflict.conflictId}: ${effects.join(' vs ')} on ${target} — both directives are equally valid at rank ${maxRank} (${maxLevel}) and genuinely incompatible; the target is paused. ` +
    `Both directives remain valid; the conflict is structural, not a judgment on either principal.`;
  const rec = needsHuman('ai-disagreement', {
    detail: narrative,
    context: {
      conflictId: conflict.conflictId,
      targetKind: conflict.targetKind,
      targetId: conflict.targetId,
      directiveIds: conflict.directiveIds.join(','),
      maxPartyLevel: maxLevel,
    },
    originalCommand: directives
      .map((d) => `${d.principalId} (${d.authorityLevel}): ${d.effect} ${d.instruction}`.trim())
      .join(' ; '),
    impactScope: `target ${target} is paused until a higher-ranked human decides`,
    stoppedActions: [`${target} — paused by AUTHORITY_CONFLICT ${conflict.conflictId}`],
    suggestion: deadlocked
      ? `No rank above ${maxLevel} exists: this conflict cannot be resolved in-band; a human with out-of-band authority must intervene.`
      : `A strictly higher-ranked human (${requiredLevel}) must decide via POST /api/authority/conflicts/${conflict.conflictId}/resolve.`,
  });

  return {
    id: rec.id,
    reason: rec.reason,
    reasonZh: rec.reasonZh,
    severity: rec.severity,
    source: `authority-conflict:${conflict.conflictId}`,
    recipient: null,
    requiredDeciderLevel: deadlocked ? maxLevel : requiredLevel,
    detailJson: JSON.stringify({
      narrative,
      conflictId: conflict.conflictId,
      target,
      directiveIds: conflict.directiveIds,
      incompatibleEffects: effects,
      maxPartyRank: maxRank,
      maxPartyLevel: maxLevel,
      deadlocked,
      suggestion: rec.suggestion,
    }),
    contextJson: JSON.stringify(rec.context ?? {}),
    raisedAt: Date.now(),
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
}

function createRegistry(db: FactoryDatabase | null): AuthorityConflictRegistry {
  return new AuthorityConflictRegistry({
    audit: (e) => pendingAudit.push(e),
    // §81 emission (Batch 36): only when a database is wired (server
    // boot). Pre-boot the registry works exactly as before — pure
    // memory, storage-agnostic, no manufactured emissions.
    ...(db
      ? {
          onConflictOpened: (conflict: AuthorityConflict) => {
            pendingUpgrades.push(buildUpgradeRecord(conflict, registry));
          },
        }
      : {}),
  });
}

let registry: AuthorityConflictRegistry = createRegistry(null);

/**
 * Boot wiring (Batch 36): re-create the registry with the §81 emission
 * hook so freshly-opened conflicts write needsHuman upgrade records to
 * fdb. Called once at server boot; before boot the registry works
 * exactly as before (no emission, storage-agnostic).
 */
export function initAuthorityRoutes(db: FactoryDatabase): void {
  needsHumanDb = db;
  registry = createRegistry(db);
}

function flushNeedsHuman(ctx: RouteContext): void {
  if (pendingUpgrades.length === 0) return;
  const db = needsHumanDb;
  for (const row of pendingUpgrades.splice(0)) {
    if (!db) {
      // Should not happen post-boot; audit loudly rather than dropping.
      ctx.audit.record('system', 'NEEDS_HUMAN_PERSIST_FAILED', 'needs-human', row.id, {
        reason: 'no database wired',
        source: row.source,
      });
      continue;
    }
    try {
      db.needsHuman.submit(row);
      ctx.audit.record('system', 'NEEDS_HUMAN_RAISED', 'needs-human', row.id, {
        reason: row.reason,
        source: row.source,
        requiredDeciderLevel: row.requiredDeciderLevel,
      });
    } catch (err) {
      ctx.audit.record('system', 'NEEDS_HUMAN_PERSIST_FAILED', 'needs-human', row.id, {
        error: err instanceof Error ? err.message : String(err),
        source: row.source,
      });
    }
  }
}

function flushAudit(ctx: RouteContext): void {
  for (const e of pendingAudit.splice(0)) {
    ctx.audit.record(
      'system',
      e.event,
      'authority-conflict',
      String(e.details['conflictId'] ?? e.details['directiveId'] ?? 'authority'),
      e.details,
    );
  }
}

export async function handleAuthorityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/authority')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/authority'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 1 && seg[0] === 'directives') {
    const body = await ctx.readBody(req);
    const { principalId, authorityLevel, targetKind, targetId, effect, instruction } = body as Record<string, unknown>;
    try {
      const { directive, conflict, superseded } = registry.registerDirective({
        principalId: principalId as string,
        authorityLevel: authorityLevel as AuthorityLevel,
        targetKind: targetKind as AuthorityTargetKind,
        targetId: targetId as string,
        effect: effect as DirectiveEffect,
        instruction: typeof instruction === 'string' ? instruction : '',
      });
      flushAudit(ctx);
      // §81 emission (Batch 36): an OPEN conflict just raised a
      // needsHuman upgrade. Write-through happens here, after the
      // conflict response is committed — failures are audited, never
      // rolled back.
      flushNeedsHuman(ctx);
      ctx.json(res, 200, {
        directive,
        conflict,
        supersededDirectiveId: superseded?.directiveId ?? null,
        paused: conflict?.status === 'OPEN',
      });
    } catch (err) {
      ctx.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (method === 'GET' && seg.length === 1 && seg[0] === 'conflicts') {
    const status = url.searchParams.get('status');
    const list = registry.listConflicts(
      status === 'OPEN' || status === 'RESOLVED' ? status : undefined,
    );
    ctx.json(res, 200, { conflicts: list });
    return true;
  }

  if (method === 'GET' && seg.length === 2 && seg[0] === 'conflicts') {
    const c = registry.getConflict(seg[1]);
    if (!c) {
      ctx.json(res, 404, { error: 'unknown conflict' });
      return true;
    }
    ctx.json(res, 200, {
      conflict: c,
      directives: c.directiveIds
        .map((id) => registry.getDirective(id))
        .filter((d) => d !== null),
    });
    return true;
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'conflicts' && seg[2] === 'resolve') {
    const body = await ctx.readBody(req);
    const { decidedByPrincipalId, decidedByLevel, winningDirectiveId, rationale } = body as Record<string, unknown>;
    const result = registry.resolveConflict(seg[1], {
      decidedByPrincipalId: decidedByPrincipalId as string,
      decidedByLevel: decidedByLevel as AuthorityLevel,
      winningDirectiveId: winningDirectiveId as string,
      rationale: typeof rationale === 'string' ? rationale : '',
    });
    if (!result.ok) {
      ctx.json(res, 400, { error: result.reason });
      return true;
    }
    flushAudit(ctx);
    ctx.json(res, 200, { conflict: result.conflict });
    return true;
  }

  if (method === 'GET' && seg.length === 3 && seg[0] === 'targets') {
    const kind = seg[1] as AuthorityTargetKind;
    const id = decodeURIComponent(seg[2]);
    if (kind !== 'run' && kind !== 'task') {
      ctx.json(res, 400, { error: 'target kind must be run or task' });
      return true;
    }
    const open = registry.listConflicts('OPEN').find(
      (c) => c.targetKind === kind && c.targetId === id,
    );
    ctx.json(res, 200, {
      targetKind: kind,
      targetId: id,
      paused: open != null,
      openConflict: open ?? null,
      directives: registry.listDirectives(kind, id),
    });
    return true;
  }

  return false;
}
