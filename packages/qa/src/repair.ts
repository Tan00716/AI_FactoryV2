/**
 * Repair tracking — SPEC v2 §38.3.
 *
 *   Fail evidence → Classification → Authorized repair → New candidate →
 *   affected tests → appropriate regression → independent QA.
 *
 * Two guardrails live here:
 *   1. Stagnation — the same normalized failure fingerprint three times in a
 *      row with no substantive progress triggers STAGNATION (default).
 *   2. Repair budget — exceeding the total repair budget escalates instead of
 *      looping forever.
 *   3. Changing Tests/Fixtures/Thresholds invalidates past verification and
 *      requires an independent review before the change counts.
 */
import { createHash } from 'node:crypto';

/** Normalize a failure message into a stable fingerprint (strip volatile bits). */
export function failureFingerprint(message: string): string {
  const normalized = message
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, '<ts>')
    .replace(/\b\d+(\.\d+)+\b/g, '<num>')
    .replace(/(["'])(?:(?!\1).){0,120}\1/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export interface RepairAttempt {
  attemptId: number;
  fingerprint: string;
  classification: string;
  owner: string;
  /** True when this attempt produced new evidence of progress (new passing tests, changed failure, …). */
  substantiveProgress: boolean;
  at: string;
}

export interface RepairBudget {
  /** Max repair attempts before escalation. */
  maxAttempts: number;
  /** Optional cost ceiling in abstract units; attempts deduct via costOfAttempt. */
  maxCost?: number;
}

export class RepairBudgetExceededError extends Error {
  constructor(public readonly attempts: number) {
    super(`Repair budget exceeded after ${attempts} attempts — escalating instead of looping`);
    this.name = 'RepairBudgetExceededError';
  }
}

export class StagnationError extends Error {
  constructor(public readonly fingerprint: string) {
    super(
      `Repair stagnation: failure fingerprint ${fingerprint} repeated 3 times with no substantive progress`,
    );
    this.name = 'StagnationError';
  }
}

/**
 * Changing tests/fixtures/thresholds invalidates past verification (§38.3):
 * the change only counts after an independent review. The reviewer must be a
 * different identity from the change author.
 */
export class UnreviewedTestChangeError extends Error {
  constructor() {
    super(
      'Changing Tests/Fixtures/Thresholds requires an independent review before it counts — unreviewed changes are refused',
    );
    this.name = 'UnreviewedTestChangeError';
  }
}

export interface TestChange {
  kind: 'test' | 'fixture' | 'threshold';
  description: string;
  authorId: string;
  reviewedById?: string;
}

/** Tracks repair attempts for one failing unit of work. */
export class RepairTracker {
  private readonly attempts: RepairAttempt[] = [];
  private costSpent = 0;
  private readonly now: () => number;

  constructor(
    private readonly budget: RepairBudget,
    opts: { now?: () => number } = {},
  ) {
    if (!Number.isInteger(budget.maxAttempts) || budget.maxAttempts < 1) {
      throw new Error('budget.maxAttempts must be a positive integer');
    }
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record a repair attempt. Throws StagnationError when the same fingerprint
   * appears 3 times consecutively with no substantive progress, and
   * RepairBudgetExceededError when the budget is spent.
   */
  recordAttempt(input: {
    message: string;
    classification: string;
    owner: string;
    substantiveProgress: boolean;
    cost?: number;
  }): RepairAttempt {
    const fingerprint = failureFingerprint(input.message);
    const attempt: RepairAttempt = {
      attemptId: this.attempts.length + 1,
      fingerprint,
      classification: input.classification,
      owner: input.owner,
      substantiveProgress: input.substantiveProgress,
      at: new Date(this.now()).toISOString(),
    };
    this.attempts.push(attempt);
    this.costSpent += input.cost ?? 1;

    // Stagnation: same fingerprint 3x in a row, none with substantive progress.
    const tail = this.attempts.slice(-3);
    if (
      tail.length === 3 &&
      tail.every((a) => a.fingerprint === fingerprint && !a.substantiveProgress)
    ) {
      throw new StagnationError(fingerprint);
    }
    if (
      this.attempts.length >= this.budget.maxAttempts ||
      (this.budget.maxCost !== undefined && this.costSpent >= this.budget.maxCost)
    ) {
      throw new RepairBudgetExceededError(this.attempts.length);
    }
    return attempt;
  }

  getAttempts(): RepairAttempt[] {
    return [...this.attempts];
  }

  /** Validate a Tests/Fixtures/Thresholds change: independent review required. */
  static assertTestChangeReviewed(change: TestChange): void {
    const reviewer = (change.reviewedById ?? '').trim();
    const author = (change.authorId ?? '').trim();
    if (!reviewer || reviewer === author) {
      throw new UnreviewedTestChangeError();
    }
  }
}
