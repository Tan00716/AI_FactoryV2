/**
 * Disagreement routes — spec §96–§97 (lives in @ai-factory/evaluation).
 *
 *  POST /api/disputes             {verdictA, verdictB} → detect + independent adjudication
 *  GET  /api/disputes?status=     list disputes
 *  GET  /api/disputes/escalations escalations (live + persisted, §48.2 Batch 33)
 *  POST /api/disputes/verify-gate {task} → whether independent verification applies (§97)
 *
 * Escalation durability (§48.2, Batch 33): until Batch 33 the only
 * home for a dispute adjudication escalation was
 * DisputeCoordinator.escalationRecords, an in-memory array — a
 * restart forgot every pending escalation. Every ESCALATED outcome
 * is now written through to fdb.escalations the moment it happens
 * (the append-only record layer); a write failure audits
 * ESCALATION_PERSIST_FAILED loudly but does not roll back the
 * response (the record is still in the live coordinator — the same
 * "persist failure never un-happens the decision" pattern as Batch
 * 31 pipelines). Escalation records are terminal (pending human
 * actions are the human's problem, not this process's state), so
 * hydrate is read-only: persisted rows merge with live coordinator
 * records on read, no demotion, no re-activation. The §81
 * needsHuman escalation shape is NOT emitted by disputes — it is
 * emitted by AUTHORITY_CONFLICT entering OPEN (Batch 36, see
 * routes/authority.ts) and stored in fdb.needsHuman.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import {
  DisputeCoordinator,
  shouldUseIndependentVerification,
  type EscalationRecord,
} from '@ai-factory/evaluation';
import type { FactoryDatabase } from '@ai-factory/db';
import type { AuditLog } from '@ai-factory/core';
import type { RouteContext } from './context';

const coordinator = new DisputeCoordinator();

/** Persisted escalation rows hydrated at boot (read-only history). */
let persistedEscalations: EscalationRecord[] = [];

export function initDisputesPersistence(fdb: FactoryDatabase, audit: AuditLog): void {
  persistedEscalations = [];
  try {
    const rows = fdb.escalations.listEscalations();
    for (const r of rows) {
      try {
        persistedEscalations.push({
          escalationId: r.escalationId,
          disputeId: r.disputeId,
          reasons: JSON.parse(r.reasonsJson) as string[],
          pendingHumanActions: JSON.parse(r.pendingHumanActionsJson) as string[],
          evidenceBySide: JSON.parse(r.evidenceBySideJson) as EscalationRecord['evidenceBySide'],
          createdAt: r.createdAt,
        });
      } catch (e) {
        // Corrupt rows fail loudly: one bad row never hides the rest.
        audit.record('system', 'ESCALATION_ROW_CORRUPT', 'escalation', r.escalationId, {
          error: e instanceof Error ? e.message : 'corrupt escalation row',
        });
      }
    }
  } catch (e) {
    // A read failure is an honest boot condition, not a silent one:
    // persisted history is unavailable, live escalation records still work.
    audit.record('system', 'ESCALATION_HYDRATE_FAILED', 'escalation', '(all)', {
      error: e instanceof Error ? e.message : 'escalation hydrate failed',
    });
  }
}

/** Live coordinator records plus persisted rows, de-duplicated by id (live wins). */
function listAllEscalations(): EscalationRecord[] {
  const live = coordinator.escalations();
  const seen = new Set(live.map((e) => e.escalationId));
  const merged = [...live];
  for (const e of persistedEscalations) {
    if (!seen.has(e.escalationId)) merged.push(e);
  }
  return merged;
}

export async function handleDisputeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/disputes')) return false;
  const method = req.method ?? 'GET';
  const seg = path.slice('/api/disputes'.length).split('/').filter(Boolean);

  if (method === 'POST' && seg.length === 0) {
    const body = await ctx.readBody(req);
    const verdictA = body['verdictA'] as never | undefined;
    const verdictB = body['verdictB'] as never | undefined;
    if (!verdictA || !verdictB) {
      ctx.json(res, 400, { error: 'verdictA and verdictB are required' });
      return true;
    }
    const dispute = coordinator.open(verdictA, verdictB);
    if (!dispute) {
      ctx.json(res, 200, { dispute: null, note: 'no conflict between verdicts' });
      return true;
    }
    const outcome = coordinator.adjudicate(dispute.disputeId);
    ctx.audit.record('system', 'DISPUTE_ADJUDICATED', 'dispute', dispute.disputeId, {
      status: outcome.dispute.status,
    });
    if (outcome.status === 'ESCALATED') {
      // Write the escalation record through to fdb.escalations the
      // moment it exists. A write failure audits loudly but does not
      // roll back the response — the escalation already happened.
      try {
        ctx.fdb.escalations.recordEscalation({
          escalationId: outcome.escalation.escalationId,
          disputeId: outcome.escalation.disputeId,
          reasonsJson: JSON.stringify(outcome.escalation.reasons),
          pendingHumanActionsJson: JSON.stringify(outcome.escalation.pendingHumanActions),
          evidenceBySideJson: JSON.stringify(outcome.escalation.evidenceBySide),
          createdAt: outcome.escalation.createdAt,
        });
      } catch (e) {
        ctx.audit.record('system', 'ESCALATION_PERSIST_FAILED', 'escalation', outcome.escalation.escalationId, {
          error: e instanceof Error ? e.message : 'escalation persist failed',
          disputeId: outcome.escalation.disputeId,
        });
      }
    }
    ctx.json(res, 200, { dispute: outcome.dispute, outcome });
    return true;
  }

  if (method === 'GET' && seg.length === 1 && seg[0] === 'escalations') {
    return ctx.json(res, 200, { escalations: listAllEscalations() }), true;
  }

  if (method === 'GET' && seg.length === 0) {
    const status = url.searchParams.get('status') ?? undefined;
    ctx.json(res, 200, { disputes: coordinator.list(status as never) });
    return true;
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'verify-gate') {
    const body = await ctx.readBody(req);
    const task = body['task'] as never | undefined;
    if (!task) {
      ctx.json(res, 400, { error: 'task is required' });
      return true;
    }
    ctx.json(res, 200, shouldUseIndependentVerification(task));
    return true;
  }

  return false;
}
