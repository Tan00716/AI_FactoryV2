/**
 * Failure loop — spec §38:
 *
 *   QA FAILED → Failure Analyzer → classify → assign owner → fix →
 *   re-run affected tests → regression → QA
 *
 * QaLoop executes suites via a caller-supplied runnersFactory, classifies
 * each failure (classifyFailure), assigns the owner, calls the fix hook,
 * re-runs only the affected categories, and finally re-runs a full
 * regression. Exceeding maxAttempts → verdict FAIL + escalated=true.
 */

import type { AgentRegistry } from '@ai-factory/core';
import { classifyFailure } from './classify';
import { qaSpecialistFor } from './org';
import { aggregate, runQa, SuiteRunner } from './runner';
import {
  CategoryResult,
  FailureClass,
  FailureRecord,
  QaResultPayload,
  TestCategory,
} from './types';

export interface QaLoopOptions {
  /** Max QA executions (including reruns). Default 3. */
  maxAttempts?: number;
  /** Fix hook called once per classified failure, before the rerun. */
  onFixNeeded?: (failure: FailureRecord) => Promise<void> | void;
  agents?: AgentRegistry;
  taskId?: string;
  /** The task's current agent — default PRODUCT_FAILURE owner; else 'coder'. */
  taskAgent?: string;
  actor?: string;
}

export interface QaLoopResult {
  payload: QaResultPayload;
  escalated: boolean;
  attempts: number;
}

/** §38 owner assignment: TEST → QA specialist, PRODUCT → owning agent, else human. */
export function assignOwner(
  classification: FailureClass,
  opts: { agents?: AgentRegistry; category: TestCategory; taskAgent?: string },
): string {
  switch (classification) {
    case 'TEST_FAILURE':
      return qaSpecialistFor(opts.agents, opts.category);
    case 'PRODUCT_FAILURE':
      return opts.taskAgent ?? 'coder';
    case 'ENVIRONMENT_FAILURE':
    case 'INFRA_FAILURE':
    case 'AI_FAILURE':
    case 'UNKNOWN':
      return 'human';
  }
}

function summarize(output: string | undefined, name: string): string {
  const lines = (output ?? '').split('\n');
  // Prefer the actual failing assertion line over TAP headers/plan lines.
  const interesting =
    lines.find((l) => /^not ok\b/i.test(l.trim())) ??
    lines.find((l) => /assertionerror|expected|error:/i.test(l)) ??
    lines.find((l) => l.trim());
  const first = (interesting ?? '').trim().slice(0, 300);
  return first || `${name}: failed`;
}

function toRecords(
  categories: CategoryResult[],
  runners: SuiteRunner[],
  attempt: number,
  opts: QaLoopOptions,
): FailureRecord[] {
  const names = new Map(runners.map((r) => [r.category, r.name]));
  return categories
    .filter((c) => c.verdict === 'FAIL')
    .map((c) => {
      const classification = classifyFailure({
        message: c.output ?? names.get(c.category) ?? c.category,
      });
      return {
        attempt,
        category: c.category,
        classification,
        owner: assignOwner(classification, {
          agents: opts.agents,
          category: c.category,
          taskAgent: opts.taskAgent,
        }),
        message: summarize(c.output, names.get(c.category) ?? c.category),
        at: new Date().toISOString(),
      } satisfies FailureRecord;
    });
}

export class QaLoop {
  private readonly maxAttempts: number;
  private readonly onFixNeeded?: QaLoopOptions['onFixNeeded'];
  private readonly opts: QaLoopOptions;

  constructor(opts: QaLoopOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }
    this.onFixNeeded = opts.onFixNeeded;
    this.opts = opts;
  }

  /**
   * Run the loop. `runnersFactory(attempt)` supplies fresh runners for each
   * attempt; on reruns the loop automatically narrows to affected categories.
   */
  async execute(
    runnersFactory: (attempt: number) => SuiteRunner[],
  ): Promise<QaLoopResult> {
    const taskId = this.opts.taskId ?? 'qa';
    const failures: FailureRecord[] = [];
    const latest = new Map<TestCategory, CategoryResult>();
    let attempts = 0;
    let affected: Set<TestCategory> | null = null;

    const run = async (
      attempt: number,
      only?: Set<TestCategory>,
    ): Promise<{ runners: SuiteRunner[]; failed: FailureRecord[] }> => {
      const all = runnersFactory(attempt);
      const runners =
        only && only.size > 0 ? all.filter((r) => only.has(r.category)) : all;
      const result = await runQa(taskId, runners, { actor: this.opts.actor });
      for (const c of result.categories) latest.set(c.category, c);
      return { runners, failed: toRecords(result.categories, runners, attempt, this.opts) };
    };

    while (attempts < this.maxAttempts) {
      attempts++;
      const only = attempts > 1 ? affected : null;
      const { failed } = await run(attempts, only ?? undefined);

      if (failed.length === 0) {
        if (attempts === 1) {
          return {
            payload: aggregate([...latest.values()], failures),
            escalated: false,
            attempts,
          };
        }
        // §38: after affected tests pass, re-run a full regression once more.
        if (attempts >= this.maxAttempts) {
          return {
            payload: aggregate([...latest.values()], failures),
            escalated: false,
            attempts,
          };
        }
        attempts++;
        const { failed: regFailed } = await run(attempts);
        failures.push(...regFailed);
        if (regFailed.length > 0) {
          for (const f of regFailed) await this.onFixNeeded?.(f);
          return {
            payload: aggregate([...latest.values()], failures),
            escalated: true,
            attempts,
          };
        }
        return {
          payload: aggregate([...latest.values()], failures),
          escalated: false,
          attempts,
        };
      }

      failures.push(...failed);
      for (const f of failed) await this.onFixNeeded?.(f);
      if (attempts >= this.maxAttempts) {
        return {
          payload: aggregate([...latest.values()], failures),
          escalated: true,
          attempts,
        };
      }
      affected = new Set<TestCategory>(failed.map((f) => f.category));
    }

    return {
      payload: aggregate([...latest.values()], failures),
      escalated: true,
      attempts,
    };
  }
}
