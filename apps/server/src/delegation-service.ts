/**
 * Delegation durability — SPEC v2 §12.2, §48.2 (Batch 32).
 *
 * Until Batch 32 the DelegationManager was pure process memory: a
 * restart forgot every delegation. This module keeps one
 * DelegationManager as the live enforcement point (§12.2 rules) and
 * writes every mutation through to fdb.delegations the moment it
 * happens, so the manager is rebuildable after a restart.
 *
 * Hydration honesty (the Batch 26 ORPHANED / Batch 31 INTERRUPTED
 * precedent): a delegation row that is still ACTIVE predates this
 * process — the delegator that supervised it is gone. initDelegationService
 * demotes those rows to INTERRUPTED in the DB (write-back) and audits
 * each one (DELEGATION_INTERRUPTED_ON_RESTART). INTERRUPTED rows are
 * never loaded into the live manager: they are read-only history,
 * never auto-resumed, never re-activated — a new delegation takes a
 * new id. DRAFT/COMPLETED/CANCELLED rows load as-is (DRAFT never
 * started, so no liveness claim; terminal states are historical
 * facts).
 *
 * The live manager enforces the §12.2 rules on every mutation; this
 * module persists the RESULT of each successful mutation. A failed
 * mutation (SCOPE_VIOLATION, BUDGET_EXCEEDED, …) throws before any
 * write — the DB never sees a rejected delegation.
 */
import {
  DelegationManager,
  type CreateDelegationInput,
  type Delegation,
  type DelegationError,
} from '@ai-factory/orchestrator';
import type {
  DelegationDbRecord,
  DelegationStore,
  FactoryDatabase,
  PersistedDelegationStatus,
} from '@ai-factory/db';
import type { AuditLog } from '@ai-factory/core';

export const DELEGATION_ACTIVE_AT_RESTART_NOTE =
  'was ACTIVE when the owning process died; no process supervises it now, ' +
  'its real-world fate is UNKNOWN — never auto-resumed, never re-activated';

export interface DelegationServiceDeps {
  fdb: FactoryDatabase;
  audit: AuditLog;
  clock?: { now: () => number };
}

function toRecord(d: Delegation, rehydratedAt: string | null = null): DelegationDbRecord {
  const now = new Date().toISOString();
  return {
    delegationId: d.delegation_id,
    parentDelegationId: d.parent_delegation_id,
    delegator: d.delegator,
    delegatee: d.delegatee,
    taskId: d.task_id,
    status: d.status as PersistedDelegationStatus,
    version: d.version,
    recordJson: JSON.stringify(d),
    createdAt: d.created_at,
    updatedAt: now,
    rehydratedAt,
  };
}

export interface DelegationService {
  manager: DelegationManager;
  store: DelegationStore;
  /** Live (manager-held) delegations plus INTERRUPTED history from the DB. */
  listAll(): { live: Delegation[]; interrupted: DelegationDbRecord[]; corrupt: string[] };
  createRoot(input: CreateDelegationInput, actor: string): Delegation;
  createChild(input: CreateDelegationInput, actor: string): Delegation;
  activate(id: string, actor: string): Delegation;
  complete(id: string, actor: string): Delegation;
  cancel(id: string, actor: string): Delegation;
  handoff(id: string, actor: string): Delegation;
  reparent(id: string, newParentId: string, actor: string): Delegation;
}

function writeThrough(
  store: DelegationStore,
  d: Delegation,
  rehydratedAt: string | null = null,
): Delegation {
  store.save(toRecord(d, rehydratedAt));
  return { ...d };
}

export function createDelegationService(deps: DelegationServiceDeps): DelegationService {
  const { fdb, audit, clock } = deps;
  const store = fdb.delegations;
  const manager = new DelegationManager(clock ? { clock } : {});

  const record = (
    actor: string,
    action: string,
    d: Delegation,
    extra: Record<string, unknown> = {},
  ): void => {
    audit.record(actor, action, 'delegation', d.delegation_id, {
      delegator: d.delegator,
      delegatee: d.delegatee,
      task_id: d.task_id,
      status: d.status,
      version: d.version,
      ...extra,
    });
  };

  const mutate = (
    action: string,
    actor: string,
    fn: () => Delegation,
    extra: Record<string, unknown> = {},
  ): Delegation => {
    const d = fn(); // throws before any write on rule violation
    writeThrough(store, d);
    record(actor, action, d, extra);
    return { ...d };
  };

  return {
    manager,
    store,
    listAll() {
      const live: Delegation[] = [];
      const corrupt: string[] = [];
      for (const row of store.list()) {
        if (row.status === 'INTERRUPTED') continue;
        try {
          live.push(JSON.parse(row.recordJson) as Delegation);
        } catch {
          // Corrupt row: reported, never injected into the live manager.
          corrupt.push(row.delegationId);
        }
      }
      return { live, interrupted: store.listByStatus('INTERRUPTED'), corrupt };
    },
    createRoot: (input, actor) =>
      mutate('DELEGATION_CREATED', actor, () => manager.createRoot(input), { root: true }),
    createChild: (input, actor) => mutate('DELEGATION_CREATED', actor, () => manager.create(input)),
    activate: (id, actor) => mutate('DELEGATION_ACTIVATED', actor, () => manager.activate(id)),
    complete: (id, actor) => mutate('DELEGATION_COMPLETED', actor, () => manager.complete(id)),
    cancel: (id, actor) => mutate('DELEGATION_CANCELLED', actor, () => manager.cancel(id)),
    handoff: (id, actor) =>
      mutate('DELEGATION_HANDOFF', actor, () => manager.handoff(id, actor), {
        handoffBy: actor,
      }),
    reparent: (id, newParentId, actor) =>
      mutate('DELEGATION_REPARENTED', actor, () => manager.reparent(id, newParentId), {
        newParentId,
      }),
  };
}

export interface DelegationHydrationResult {
  loaded: number;
  skipped: string[];
  interrupted: number;
}

/**
 * Boot-time wiring: demote pre-existing ACTIVE rows to INTERRUPTED
 * (write-back + one audit record each), then load the rest into a
 * fresh manager. Returns the live service.
 */
export function initDelegationService(deps: DelegationServiceDeps): {
  service: DelegationService;
  hydration: DelegationHydrationResult;
} {
  const { fdb, audit } = deps;
  const store = fdb.delegations;
  const now = new Date().toISOString();

  let interrupted = 0;
  for (const row of store.listByStatus('ACTIVE')) {
    if (store.markInterrupted(row.delegationId, now)) {
      interrupted++;
      audit.record('system', 'DELEGATION_INTERRUPTED_ON_RESTART', 'delegation', row.delegationId, {
        delegator: row.delegator,
        delegatee: row.delegatee,
        task_id: row.taskId,
        note: DELEGATION_ACTIVE_AT_RESTART_NOTE,
      });
    }
  }

  const service = createDelegationService(deps);
  const snapshot: Delegation[] = [];
  const skipped: string[] = [];
  for (const row of store.list()) {
    if (row.status === 'INTERRUPTED') continue; // read-only history, never live
    try {
      const d = JSON.parse(row.recordJson) as Delegation;
      snapshot.push(d);
    } catch {
      skipped.push(row.delegationId);
    }
  }
  const loaded = service.manager.loadSnapshot(snapshot);
  if (loaded.loaded > 0 || interrupted > 0) {
    console.log(
      `[ai-factory] delegations hydrated: ${loaded.loaded} live record(s)` +
        (interrupted > 0 ? `, ${interrupted} ACTIVE row(s) demoted to INTERRUPTED` : '') +
        (loaded.skipped.length > 0 ? `, ${loaded.skipped.length} corrupt row(s) skipped` : ''),
    );
  }
  return {
    service,
    hydration: { loaded: loaded.loaded, skipped: [...skipped, ...loaded.skipped], interrupted },
  };
}

/** Re-exported so routes can distinguish rule violations from bugs. */
export type { DelegationError };
