/**
 * Demo: a task blows its token budget, gets rejected, and escalates.
 *
 * A tiny token budget stands in for a real task budget. The agent consumes
 * tokens as it works; when the budget is exhausted, consume() throws
 * BudgetExceededError and the onExceed hook fires — the hook records an
 * audit entry and pings a human (here: console output). The agent then
 * files a budget-increase request, which stays PENDING until approved.
 */

import { BudgetExceededError, BudgetTracker, UsageRecorder } from '../src/index';

const audit: string[] = [];
const notifications: string[] = [];

const tracker = new BudgetTracker({
  onExceed: (event) => {
    // Escalation hook: record audit + notify a human (§81 "Budget exceeded"
    // is a human exception-handler trigger).
    audit.push(
      `[AUDIT] actor=system action=BUDGET_EXCEEDED task=${event.taskId} ` +
        `dimension=${event.dimension} used=${event.used}/${event.limit}`,
    );
    notifications.push(
      `[HUMAN] Task ${event.taskId} exceeded its ${event.dimension} budget ` +
        `(used ${event.used} of ${event.limit}). Increase requested — awaiting approval.`,
    );
  },
});

const usage = new UsageRecorder();
const TASK = 'task-demo-blowout';

tracker.setBudget(TASK, { tokens: 10_000 });
tracker.start(TASK);
console.log(`Task ${TASK} budget: 10,000 tokens`);

const batches: Array<{ agent: string; tokens: number }> = [
  { agent: 'planner', tokens: 4_000 },
  { agent: 'coder', tokens: 4_000 },
  { agent: 'coder', tokens: 5_000 }, // ← this one blows the budget
];

for (const batch of batches) {
  try {
    tracker.consume(TASK, { tokens: batch.tokens });
    usage.record(TASK, batch.agent, 'tokens', batch.tokens);
    console.log(`consume ok: ${batch.agent} +${batch.tokens} tokens`);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.log(
        `REJECTED: ${batch.agent} wanted ${batch.tokens} tokens — ` +
          `${err.dimension} exceeded for task ${err.taskId} (used=${err.used}, limit=${err.limit})`,
      );
      const req = tracker.requestIncrease(TASK, 'tokens', 20_000);
      console.log(`increase request ${req.id.slice(0, 8)}… → status: ${req.status}`);
    } else {
      throw err;
    }
  }
}

console.log('\n--- audit trail ---');
for (const line of audit) console.log(line);
console.log('--- human notifications ---');
for (const line of notifications) console.log(line);
console.log('--- remaining budget ---', tracker.check(TASK).tokens, 'tokens');
console.log('--- pending increases ---', tracker.pendingIncreases(TASK).length);
console.log('--- usage summary (by agent) ---');
console.log(JSON.stringify(usage.summarize({ taskId: TASK }).byAgent, null, 2));
