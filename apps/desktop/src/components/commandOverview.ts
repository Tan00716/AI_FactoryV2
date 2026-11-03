/**
 * V3.0 audit round 3, item #5: task command overview — pure summary
 * helpers for the read-only command panel. React-free and import-free so
 * desktop unit tests can load it directly with node type-stripping.
 *
 * HONESTY RULES (enforced by construction, not by convention):
 * - This module NEVER synthesizes a cloud row. The cloud gate is a
 *   constant `connected: false` until audit #1 (a real Codex turn) is
 *   verified; the panel renders the cloud section from that constant as
 *   an explicit empty state.
 * - Budget rows are estimates: the quota layer records simulated /
 *   reported usage only (V3-#8), so every budget row carries
 *   `estimated: true` and the panel must render the estimate badge.
 * - Persisted runs carry metadata only (no step data); they are flagged
 *   `persisted: true` and must never be presented as re-runnable.
 */

export interface CommandRunRow {
  id: string;
  label: string;
  ok: boolean;
  taskCount: number;
  finishedAt: string;
  persisted: boolean;
}

export interface CommandQueueJobRow {
  id: string;
  label: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

export interface CommandBudgetRow {
  id: string;
  scope: string;
  scopeKey: string;
  unit: string;
  used: number;
  limit: number;
  pct: number;
  status: 'ok' | 'warned' | 'tripped' | 'released';
  estimated: true;
}

/** Cloud gate: audit #1 (real-model loop) has not been verified, so the
 * cloud section has no data source. Never flip this without #1 evidence. */
export const CLOUD_GATE = {
  connected: false,
  reason: 'audit-1-pending',
} as const;

export interface RunInput {
  id: string;
  label: string;
  ok: boolean;
  taskCount: number;
  finishedAt: string;
  persisted?: boolean;
}

export function summarizeRuns(
  runs: readonly RunInput[],
  maxRows = 5,
): { rows: CommandRunRow[]; okCount: number; failCount: number } {
  const rows = runs.slice(0, maxRows).map((r) => ({
    id: r.id,
    label: r.label,
    ok: r.ok,
    taskCount: r.taskCount,
    finishedAt: r.finishedAt,
    persisted: r.persisted === true,
  }));
  return {
    rows,
    okCount: runs.filter((r) => r.ok).length,
    failCount: runs.filter((r) => !r.ok).length,
  };
}

export interface QueueInput {
  running: number;
  queued: number;
  maxConcurrency: number;
  jobs: readonly { id: string; label: string; status: CommandQueueJobRow['status'] }[];
}

export function summarizeQueue(
  q: QueueInput,
  maxRows = 5,
): { running: number; queued: number; maxConcurrency: number; jobs: CommandQueueJobRow[] } {
  return {
    running: q.running,
    queued: q.queued,
    maxConcurrency: q.maxConcurrency,
    jobs: q.jobs.slice(0, maxRows).map((j) => ({ id: j.id, label: j.label, status: j.status })),
  };
}

export interface BudgetInput {
  budget: { id: string; scope: string; scopeKey: string; unit: string };
  used: number;
  limit: number;
  pct: number;
  status: CommandBudgetRow['status'];
}

export function summarizeBudgets(
  budgets: readonly BudgetInput[],
): { rows: CommandBudgetRow[]; tripped: number; warned: number } {
  return {
    rows: budgets.map((b) => ({
      id: b.budget.id,
      scope: b.budget.scope,
      scopeKey: b.budget.scopeKey,
      unit: b.budget.unit,
      used: b.used,
      limit: b.limit,
      pct: b.pct,
      status: b.status,
      estimated: true as const,
    })),
    tripped: budgets.filter((b) => b.status === 'tripped').length,
    warned: budgets.filter((b) => b.status === 'warned').length,
  };
}
