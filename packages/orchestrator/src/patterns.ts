/**
 * Orchestration pattern chooser — spec §21.
 *
 * The platform supports both:
 *  - manager pattern: PM calls Tech Lead calls specialists (agents-as-tools;
 *    the manager keeps ownership and calls specialists as bounded capabilities)
 *  - handoff pattern: Agent A → Agent B → Agent C (responsibility moves)
 *
 * The system chooses based on ownership and task structure. This is a
 * DOCUMENTED HEURISTIC — it does not understand the task, it counts
 * structure:
 *
 *  - `subtaskCount >= 2` with parallelizable work (fanOut) → 'manager':
 *    one owner must coordinate bounded specialist calls.
 *  - `subtaskCount >= 2` but strictly sequential with distinct ownership
 *    per stage (pipeline) → 'handoff': responsibility moves down the chain.
 *  - single subtask (or none) → 'manager': no chain to hand off through;
 *    the owner executes directly (degenerate manager of one).
 */
export type OrchestrationPattern = 'manager' | 'handoff';

export interface PatternInput {
  /** Number of subtasks the task decomposes into. */
  subtaskCount: number;
  /**
   * True when subtasks can run in parallel / fan out (e.g. backend +
   * frontend + QA). Implies a coordinator is needed.
   */
  fanOut: boolean;
  /**
   * True when each stage has a distinct single owner and responsibility
   * should move with the work (a pipeline).
   */
  sequentialPipeline: boolean;
}

export function choosePattern(input: PatternInput): OrchestrationPattern {
  // Pipeline beats fan-out: a strict chain hands responsibility along.
  if (input.subtaskCount >= 2 && input.sequentialPipeline && !input.fanOut) {
    return 'handoff';
  }
  // Everything else is coordinated by a single owner.
  return 'manager';
}
