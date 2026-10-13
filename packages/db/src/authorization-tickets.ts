/**
 * Operational pre-authorization ticket registry — SPEC v2 §17.2
 * (G-09, Batch 18).
 *
 * §17.2: "Operational 预授权票记录触发政策与 Rule ID，不假装 Human 刚
 * 点击 Dispatch" — an operational pre-authorization is a recorded
 * ticket that names the policy and Rule ID that triggered it, so a
 * POLICY dispatch can point at a real, inspectable authorization
 * instead of a bare Rule ID string typed into a request. Batch 17
 * made the dispatch endpoint record via + Rule ID; this registry is
 * the ticket book those dispatches can now consume.
 *
 * Ticket semantics (the deliberate choices, pinned by tests):
 *  - SINGLE-USE. A ticket authorizes one dispatch consumption:
 *    recordConsumption moves ACTIVE → USED and appends the
 *    consumption record (which task, which action, by whom, when).
 *    A second consumption is refused — a ticket that silently
 *    authorized an unbounded number of dispatches would be a blank
 *    cheque with a Rule ID written on it.
 *  - EXPIRY IS EFFECTIVE, NOT SWEPT. There is no timer rewriting rows:
 *    a stored ACTIVE ticket whose expiresAt has passed READS as
 *    EXPIRED (effectiveTicketStatus), and every state-changing
 *    operation judges by the effective status. The stored row keeps
 *    the status it was left in; the effective status is the truth a
 *    consumer must act on.
 *  - Scope is a coverage claim, checked by ticketCoversTask at
 *    consumption time: project (exact match, when the ticket names
 *    one), task category (when the ticket lists priorities, the
 *    task's priority must be among them — the Task model has no
 *    task_type field (§17.1 G-06 is still open), so priority is the
 *    category axis a ticket can honestly be checked against), and
 *    actions (when listed, the consumed action must be among them;
 *    dispatch consumption consumes the 'dispatch' action). An
 *    omitted scope dimension constrains nothing.
 *  - credential material is never involved: a ticket is an
 *    authorization RECORD, not a secret; it stores names and ids only.
 *
 * Copy contract: scope and consumptions round-trip through JSON text
 * (SQLite) / structuredClone (memory), so every read is a fresh deep
 * copy — callers can never mutate stored state through a fetched
 * ticket, and create() snapshots its input. The in-memory
 * implementation is the behavior reference the SQLite implementation
 * is pinned against, same as the outbox store.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type AuthorizationTicketStatus = 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';

/** The action a POLICY dispatch consumes from a ticket. */
export const TICKET_ACTION_DISPATCH = 'dispatch';

export interface AuthorizationTicketScope {
  /** When set, only tasks of this project are covered. */
  projectId?: string;
  /**
   * Task categories covered, expressed as Task priorities (P0–P4):
   * the Task model carries no task_type field yet (§17.1 G-06), so
   * priority is the category axis that can actually be verified
   * against a task at consumption time.
   */
  priorities?: string[];
  /** When set, only these actions are covered ('dispatch', …). */
  actions?: string[];
}

export interface AuthorizationTicketConsumption {
  taskId: string;
  action: string;
  /** The audit actor the consumption was recorded under ('policy'). */
  consumedBy: string;
  consumedAt: string;
  /** The ticket's Rule ID, denormalized onto the record it justified. */
  policyRuleId: string;
}

export interface AuthorizationTicket {
  id: string;
  /** §17.2 — the triggering policy's Rule ID this ticket records. */
  policyRuleId: string;
  scope: AuthorizationTicketScope;
  issuedBy: string;
  createdAt: string;
  /** Validity deadline (ISO) or null = no expiry. */
  expiresAt: string | null;
  status: AuthorizationTicketStatus;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  consumptions: AuthorizationTicketConsumption[];
}

export interface CreateAuthorizationTicketInput {
  policyRuleId: string;
  scope?: AuthorizationTicketScope;
  issuedBy: string;
  /** ISO deadline; omit/null for a ticket that does not expire. */
  expiresAt?: string | null;
}

/** A lifecycle operation was attempted from a state that forbids it. */
export class AuthorizationTicketError extends Error {
  readonly ticketId: string;
  readonly status: AuthorizationTicketStatus;
  constructor(ticketId: string, status: AuthorizationTicketStatus, action: string) {
    super(
      `Cannot ${action} authorization ticket ${ticketId}: status is ${status}`,
    );
    this.name = 'AuthorizationTicketError';
    this.ticketId = ticketId;
    this.status = status;
  }
}

export class AuthorizationTicketNotFoundError extends Error {
  constructor(id: string) {
    super(`Authorization ticket ${id} not found`);
    this.name = 'AuthorizationTicketNotFoundError';
  }
}

/**
 * The status a consumer must act on: a stored ACTIVE ticket past its
 * expiresAt is EXPIRED even though no sweep rewrote the row. `nowMs`
 * is injectable for deterministic tests.
 */
export function effectiveTicketStatus(
  t: Pick<AuthorizationTicket, 'status' | 'expiresAt'>,
  nowMs: number = Date.now(),
): AuthorizationTicketStatus {
  if (
    t.status === 'ACTIVE' &&
    t.expiresAt !== null &&
    Number.isFinite(Date.parse(t.expiresAt)) &&
    Date.parse(t.expiresAt) <= nowMs
  ) {
    return 'EXPIRED';
  }
  return t.status;
}

/** The ticket as read: stored fields, status replaced by the effective one. */
export function withEffectiveStatus(
  t: AuthorizationTicket,
  nowMs: number = Date.now(),
): AuthorizationTicket {
  const status = effectiveTicketStatus(t, nowMs);
  return status === t.status ? t : { ...t, status };
}

export interface TicketCoverageTask {
  projectId: string;
  priority: string;
}

/**
 * Does this ticket's scope cover consuming `action` for this task?
 * Returns the list of unmet scope dimensions (empty = covered). The
 * ticket's STATUS is not judged here — callers check the effective
 * status separately so the two refusal reasons stay distinguishable
 * in audits.
 */
export function ticketCoverageGaps(
  ticket: Pick<AuthorizationTicket, 'scope'>,
  task: TicketCoverageTask,
  action: string,
): string[] {
  const gaps: string[] = [];
  const scope = ticket.scope ?? {};
  if (scope.projectId !== undefined && scope.projectId !== task.projectId) {
    gaps.push(
      `project: ticket covers project ${scope.projectId}, task is in project ${task.projectId}`,
    );
  }
  if (
    scope.priorities !== undefined &&
    scope.priorities.length > 0 &&
    !scope.priorities.includes(task.priority)
  ) {
    gaps.push(
      `task category: ticket covers priorities [${scope.priorities.join(', ')}], task priority is ${task.priority}`,
    );
  }
  if (
    scope.actions !== undefined &&
    scope.actions.length > 0 &&
    !scope.actions.includes(action)
  ) {
    gaps.push(
      `action: ticket covers actions [${scope.actions.join(', ')}], not '${action}'`,
    );
  }
  return gaps;
}

export interface AuthorizationTicketStore {
  create(input: CreateAuthorizationTicketInput): AuthorizationTicket;
  /** One ticket by id (effective status), or undefined. */
  get(id: string): AuthorizationTicket | undefined;
  /** All tickets (effective status), creation order; optional filters. */
  list(filter?: {
    status?: AuthorizationTicketStatus;
    projectId?: string;
  }): AuthorizationTicket[];
  /**
   * ACTIVE → REVOKED. Throws AuthorizationTicketNotFoundError for an
   * unknown id and AuthorizationTicketError from any other effective
   * status (a USED/EXPIRED ticket has nothing left to revoke).
   */
  revoke(
    id: string,
    opts: { by: string; reason?: string },
  ): AuthorizationTicket;
  /**
   * Consume the ticket for one dispatch (ACTIVE → USED, consumption
   * appended). Throws like revoke() from a non-ACTIVE effective
   * status. Scope coverage is NOT judged here — the caller checks
   * ticketCoverageGaps first so its refusal audit names the gap.
   */
  recordConsumption(
    id: string,
    consumption: { taskId: string; action: string; consumedBy: string },
  ): AuthorizationTicket;
}

abstract class BaseAuthorizationTicketStore {
  protected readonly now: () => number;
  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }
  protected nowIso(): string {
    return new Date(this.now()).toISOString();
  }
  protected effective(t: AuthorizationTicket): AuthorizationTicket {
    return withEffectiveStatus(t, this.now());
  }
}

/**
 * Default AuthorizationTicketStore: an in-process Map with copy-in /
 * copy-out semantics. Nothing survives a restart — it exists so
 * embedders and tests without a database keep a working registry, and
 * as the behavior reference the SQLite implementation is pinned
 * against. Durable deployments use SqliteAuthorizationTicketStore
 * (the server does, via FactoryDatabase.authorizationTickets).
 */
export class InMemoryAuthorizationTicketStore
  extends BaseAuthorizationTicketStore
  implements AuthorizationTicketStore
{
  private readonly rows = new Map<string, AuthorizationTicket>();

  create(input: CreateAuthorizationTicketInput): AuthorizationTicket {
    const t: AuthorizationTicket = {
      id: randomUUID(),
      policyRuleId: input.policyRuleId,
      scope: structuredClone(input.scope ?? {}),
      issuedBy: input.issuedBy,
      createdAt: this.nowIso(),
      expiresAt: input.expiresAt ?? null,
      status: 'ACTIVE',
      revokedBy: null,
      revokedAt: null,
      revokeReason: null,
      consumptions: [],
    };
    this.rows.set(t.id, structuredClone(t));
    return this.effective(structuredClone(t));
  }

  get(id: string): AuthorizationTicket | undefined {
    const t = this.rows.get(id);
    return t ? this.effective(structuredClone(t)) : undefined;
  }

  list(filter?: {
    status?: AuthorizationTicketStatus;
    projectId?: string;
  }): AuthorizationTicket[] {
    const out: AuthorizationTicket[] = [];
    for (const t of this.rows.values()) {
      const e = this.effective(structuredClone(t));
      if (filter?.status !== undefined && e.status !== filter.status) continue;
      if (
        filter?.projectId !== undefined &&
        e.scope.projectId !== filter.projectId
      ) {
        continue;
      }
      out.push(e);
    }
    return out;
  }

  revoke(
    id: string,
    opts: { by: string; reason?: string },
  ): AuthorizationTicket {
    const t = this.rows.get(id);
    if (!t) throw new AuthorizationTicketNotFoundError(id);
    const status = effectiveTicketStatus(t, this.now());
    if (status !== 'ACTIVE') {
      throw new AuthorizationTicketError(id, status, 'revoke');
    }
    t.status = 'REVOKED';
    t.revokedBy = opts.by;
    t.revokedAt = this.nowIso();
    t.revokeReason = opts.reason ?? null;
    return this.effective(structuredClone(t));
  }

  recordConsumption(
    id: string,
    consumption: { taskId: string; action: string; consumedBy: string },
  ): AuthorizationTicket {
    const t = this.rows.get(id);
    if (!t) throw new AuthorizationTicketNotFoundError(id);
    const status = effectiveTicketStatus(t, this.now());
    if (status !== 'ACTIVE') {
      throw new AuthorizationTicketError(id, status, 'consume');
    }
    t.consumptions.push({
      taskId: consumption.taskId,
      action: consumption.action,
      consumedBy: consumption.consumedBy,
      consumedAt: this.nowIso(),
      policyRuleId: t.policyRuleId,
    });
    t.status = 'USED';
    return this.effective(structuredClone(t));
  }
}

function rowToTicket(r: Record<string, unknown>): AuthorizationTicket {
  return {
    id: r['id'] as string,
    policyRuleId: r['policy_rule_id'] as string,
    scope: JSON.parse(r['scope'] as string) as AuthorizationTicketScope,
    issuedBy: r['issued_by'] as string,
    createdAt: r['created_at'] as string,
    expiresAt: (r['expires_at'] as string | null) ?? null,
    status: r['status'] as AuthorizationTicketStatus,
    revokedBy: (r['revoked_by'] as string | null) ?? null,
    revokedAt: (r['revoked_at'] as string | null) ?? null,
    revokeReason: (r['revoke_reason'] as string | null) ?? null,
    consumptions: JSON.parse(
      r['consumptions'] as string,
    ) as AuthorizationTicketConsumption[],
  };
}

/**
 * SQLite-backed AuthorizationTicketStore — same shapes, statuses and
 * error behavior as the in-memory reference; only the backing changes.
 * One row per ticket on the authorization_tickets table.
 */
export class SqliteAuthorizationTicketStore
  extends BaseAuthorizationTicketStore
  implements AuthorizationTicketStore
{
  constructor(
    private readonly db: DatabaseSync,
    opts: { now?: () => number } = {},
  ) {
    super(opts);
  }

  private save(t: AuthorizationTicket): void {
    this.db
      .prepare(
        `INSERT INTO authorization_tickets
           (id, policy_rule_id, scope, issued_by, created_at, expires_at,
            status, revoked_by, revoked_at, revoke_reason, consumptions)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           policy_rule_id=excluded.policy_rule_id, scope=excluded.scope,
           issued_by=excluded.issued_by, created_at=excluded.created_at,
           expires_at=excluded.expires_at, status=excluded.status,
           revoked_by=excluded.revoked_by, revoked_at=excluded.revoked_at,
           revoke_reason=excluded.revoke_reason,
           consumptions=excluded.consumptions`,
      )
      .run(
        t.id,
        t.policyRuleId,
        JSON.stringify(t.scope),
        t.issuedBy,
        t.createdAt,
        t.expiresAt,
        t.status,
        t.revokedBy,
        t.revokedAt,
        t.revokeReason,
        JSON.stringify(t.consumptions),
      );
  }

  private row(id: string): AuthorizationTicket | undefined {
    const r = this.db
      .prepare('SELECT * FROM authorization_tickets WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? rowToTicket(r) : undefined;
  }

  create(input: CreateAuthorizationTicketInput): AuthorizationTicket {
    const t: AuthorizationTicket = {
      id: randomUUID(),
      policyRuleId: input.policyRuleId,
      scope: structuredClone(input.scope ?? {}),
      issuedBy: input.issuedBy,
      createdAt: this.nowIso(),
      expiresAt: input.expiresAt ?? null,
      status: 'ACTIVE',
      revokedBy: null,
      revokedAt: null,
      revokeReason: null,
      consumptions: [],
    };
    this.save(t);
    return this.effective(structuredClone(t));
  }

  get(id: string): AuthorizationTicket | undefined {
    const t = this.row(id);
    return t ? this.effective(t) : undefined;
  }

  list(filter?: {
    status?: AuthorizationTicketStatus;
    projectId?: string;
  }): AuthorizationTicket[] {
    const rows = this.db
      .prepare('SELECT * FROM authorization_tickets ORDER BY rowid')
      .all() as unknown as Record<string, unknown>[];
    const out: AuthorizationTicket[] = [];
    for (const r of rows) {
      const e = this.effective(rowToTicket(r));
      if (filter?.status !== undefined && e.status !== filter.status) continue;
      if (
        filter?.projectId !== undefined &&
        e.scope.projectId !== filter.projectId
      ) {
        continue;
      }
      out.push(e);
    }
    return out;
  }

  revoke(
    id: string,
    opts: { by: string; reason?: string },
  ): AuthorizationTicket {
    const t = this.row(id);
    if (!t) throw new AuthorizationTicketNotFoundError(id);
    const status = effectiveTicketStatus(t, this.now());
    if (status !== 'ACTIVE') {
      throw new AuthorizationTicketError(id, status, 'revoke');
    }
    t.status = 'REVOKED';
    t.revokedBy = opts.by;
    t.revokedAt = this.nowIso();
    t.revokeReason = opts.reason ?? null;
    this.save(t);
    return this.effective(t);
  }

  recordConsumption(
    id: string,
    consumption: { taskId: string; action: string; consumedBy: string },
  ): AuthorizationTicket {
    const t = this.row(id);
    if (!t) throw new AuthorizationTicketNotFoundError(id);
    const status = effectiveTicketStatus(t, this.now());
    if (status !== 'ACTIVE') {
      throw new AuthorizationTicketError(id, status, 'consume');
    }
    t.consumptions.push({
      taskId: consumption.taskId,
      action: consumption.action,
      consumedBy: consumption.consumedBy,
      consumedAt: this.nowIso(),
      policyRuleId: t.policyRuleId,
    });
    t.status = 'USED';
    this.save(t);
    return this.effective(t);
  }
}
