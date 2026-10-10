/**
 * UsageRecorder — raw usage events and dashboard aggregations (§79).
 *
 * Every metered event lands here as {taskId, agentId, kind, amount, at}.
 * summarize() rolls them up by task / agent / kind within an optional time
 * window, producing the aggregate structure the Dashboard renders.
 */

import { Clock, UsageRecord, UsageRecordKind } from './types';

export interface SummarizeFilter {
  taskId?: string;
  agentId?: string;
  kind?: UsageRecordKind;
  /** Epoch-millis window (inclusive). */
  from?: number;
  to?: number;
}

export interface KindTotals {
  timeMs: number;
  tokens: number;
  toolCalls: number;
  retries: number;
  storageBytes: number;
  processes: number;
}

export interface GroupSummary {
  /** Total across all kinds (mixed units — useful for ranking, not billing). */
  total: number;
  kinds: KindTotals;
}

export interface UsageSummary {
  /** Number of records included after filtering. */
  records: number;
  totals: KindTotals;
  byTask: Record<string, GroupSummary>;
  byAgent: Record<string, GroupSummary>;
  window: { from: number | null; to: number | null };
}

const zeroTotals = (): KindTotals => ({
  timeMs: 0,
  tokens: 0,
  toolCalls: 0,
  retries: 0,
  storageBytes: 0,
  processes: 0,
});

const newGroup = (): GroupSummary => ({ total: 0, kinds: zeroTotals() });

export class UsageRecorder {
  private readonly clock: Clock;
  private records: UsageRecord[] = [];

  constructor(clock: Clock = { now: () => Date.now() }) {
    this.clock = clock;
  }

  /** Record one metered usage event. */
  record(taskId: string, agentId: string, kind: UsageRecordKind, amount: number, at?: number): UsageRecord {
    if (amount < 0) throw new Error('usage amount must be non-negative');
    const rec: UsageRecord = {
      taskId,
      agentId,
      kind,
      amount,
      at: at ?? this.clock.now(),
    };
    this.records.push(rec);
    return { ...rec };
  }

  /** All records, oldest first (cloned). */
  list(): UsageRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  /** Roll up records into the Dashboard aggregate structure. */
  summarize(filter: SummarizeFilter = {}): UsageSummary {
    const matched = this.records.filter(
      (r) =>
        (filter.taskId === undefined || r.taskId === filter.taskId) &&
        (filter.agentId === undefined || r.agentId === filter.agentId) &&
        (filter.kind === undefined || r.kind === filter.kind) &&
        (filter.from === undefined || r.at >= filter.from) &&
        (filter.to === undefined || r.at <= filter.to),
    );

    const summary: UsageSummary = {
      records: matched.length,
      totals: zeroTotals(),
      byTask: {},
      byAgent: {},
      window: { from: filter.from ?? null, to: filter.to ?? null },
    };

    for (const rec of matched) {
      summary.totals[rec.kind] += rec.amount;

      const task = (summary.byTask[rec.taskId] ??= newGroup());
      task.total += rec.amount;
      task.kinds[rec.kind] += rec.amount;

      const agent = (summary.byAgent[rec.agentId] ??= newGroup());
      agent.total += rec.amount;
      agent.kinds[rec.kind] += rec.amount;
    }
    return summary;
  }

  /** Drop everything (used in tests / data retention). */
  clear(): void {
    this.records = [];
  }
}
