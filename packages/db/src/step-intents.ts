/**
 * SQLite-backed StepIntentStore — SPEC v2 §28.1 (G-59).
 *
 * The runtime's StepIntentStore is an in-process Map: intents are written
 * BEFORE a tool executes and committed after, but a process restart loses
 * every one of them, so crash reconciliation has nothing to read. This
 * store keeps the exact same contract on top of the step_intents table:
 * same intent shape, same args/result hashing, same INTENT_NOT_FOUND
 * failure — only the backing changes.
 *
 * Why `extends StepIntentStore`: runAgent's options and Harness type the
 * store slot as the concrete runtime class, whose private fields make a
 * structurally-identical reimplementation unassignable in TypeScript.
 * Extending is also the honest dependency direction — persistence builds
 * on the runtime contract, and @ai-factory/runtime does not depend on
 * this package, so there is no cycle. All four base methods are
 * overridden; the inherited in-memory Map is never touched.
 *
 * Reconciliation stance (§28.3): rows a dead process left in PENDING are
 * surfaced by listInterrupted() for the caller to report and reconcile.
 * Nothing here ever marks them executed or replays them.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  FactoryError,
  StepIntentStore,
  systemClock,
  type Clock,
  type StepIntent,
} from '@ai-factory/runtime';

/** Must stay byte-identical with runtime durable.ts's intent hashing. */
function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function rowToIntent(r: Record<string, unknown>): StepIntent {
  const intent: StepIntent = {
    id: r['id'] as string,
    runId: r['run_id'] as string,
    tool: r['tool'] as string,
    argsHash: r['args_hash'] as string,
    // The in-memory store always carries the key (value may be
    // undefined); mirror that so read-backs are field-for-field equal.
    capabilityRef: (r['capability_ref'] as string | null) ?? undefined,
    persistedAt: Number(r['persisted_at']),
    status: r['status'] as StepIntent['status'],
  };
  // resultHash exists on the intent only after recordResult — same here.
  if (typeof r['result_hash'] === 'string') intent.resultHash = r['result_hash'];
  return intent;
}

export class SqliteStepIntentStore extends StepIntentStore {
  private readonly sqlite: DatabaseSync;
  private readonly clockRef: Clock;

  constructor(db: DatabaseSync, clock?: Clock) {
    super(clock);
    this.sqlite = db;
    this.clockRef = clock ?? systemClock;
  }

  override persistIntent(
    runId: string,
    tool: string,
    args: unknown,
    capabilityRef?: string,
  ): StepIntent {
    const intent: StepIntent = {
      id: randomUUID(),
      runId,
      tool,
      argsHash: sha256Hex(JSON.stringify(args ?? null)),
      capabilityRef,
      persistedAt: this.clockRef.now(),
      status: 'PENDING',
    };
    this.sqlite
      .prepare(
        `INSERT INTO step_intents
           (id, run_id, tool, args_hash, capability_ref, persisted_at, status, result_hash)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        intent.id, intent.runId, intent.tool, intent.argsHash,
        intent.capabilityRef ?? null, intent.persistedAt, intent.status, null,
      );
    return { ...intent };
  }

  override recordResult(id: string, ok: boolean, result: unknown): StepIntent {
    const row = this.sqlite
      .prepare('SELECT * FROM step_intents WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      // Same failure contract as the in-memory store (code + message).
      throw new FactoryError('INTENT_NOT_FOUND', `Step intent ${id} not found`);
    }
    const status: StepIntent['status'] = ok ? 'EXECUTED' : 'FAILED';
    const resultHash = sha256Hex(JSON.stringify(result ?? null));
    this.sqlite
      .prepare('UPDATE step_intents SET status = ?, result_hash = ? WHERE id = ?')
      .run(status, resultHash, id);
    return { ...rowToIntent({ ...row, status, result_hash: resultHash }) };
  }

  override pendingIntents(runId?: string): StepIntent[] {
    const rows = (
      runId === undefined
        ? this.sqlite
            .prepare(
              `SELECT * FROM step_intents WHERE status = 'PENDING'
               ORDER BY persisted_at, rowid`,
            )
            .all()
        : this.sqlite
            .prepare(
              `SELECT * FROM step_intents WHERE status = 'PENDING' AND run_id = ?
               ORDER BY persisted_at, rowid`,
            )
            .all(runId)
    ) as Record<string, unknown>[];
    return rows.map(rowToIntent);
  }

  override listIntents(runId?: string): StepIntent[] {
    const rows = (
      runId === undefined
        ? this.sqlite
            .prepare('SELECT * FROM step_intents ORDER BY persisted_at, rowid')
            .all()
        : this.sqlite
            .prepare(
              'SELECT * FROM step_intents WHERE run_id = ? ORDER BY persisted_at, rowid',
            )
            .all(runId)
    ) as Record<string, unknown>[];
    return rows.map(rowToIntent);
  }

  /**
   * §28.3 startup scan input: intents persisted but never committed with
   * a result. This is only meaningful at process startup — at that point
   * every PENDING row predates the current process, i.e. it was left
   * behind by a process that died (or was killed) between persistIntent
   * and recordResult. Read-only by design: the scan reports; it never
   * rewrites a row to EXECUTED/FAILED and never replays the tool call.
   * Disposition (reconcile against the target system, escalate, drop)
   * belongs to the caller.
   */
  listInterrupted(): StepIntent[] {
    return this.pendingIntents();
  }
}
