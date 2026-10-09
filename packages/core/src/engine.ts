/**
 * Workflow engine — spec §12 + §13 + §92.
 *
 * Agents may *request* transitions (START_TASK, SUBMIT_FOR_REVIEW, … per §13);
 * the engine validates the gate, seals the consumed evidence (§42), moves the
 * task, and writes an immutable audit record (§70). An LLM never owns these
 * invariants (§92: "Use code for state transitions, gate checks, audit").
 */

import { AuditLog } from './audit';
import { EvidenceEngine } from './evidence';
import { TaskManager } from './tasks';
import { TaskStatus } from './types';
import { TransitionResult, checkTransition } from './workflow';

export interface EngineDeps {
  tasks: TaskManager;
  evidence: EvidenceEngine;
  audit: AuditLog;
}

export class WorkflowEngine {
  constructor(private deps: EngineDeps) {}

  /**
   * §13 — request a state transition. Returns ok:false with the exact missing
   * evidence when the gate denies the move; never mutates on denial.
   */
  requestTransition(
    taskId: string,
    to: TaskStatus,
    actor: string,
  ): TransitionResult {
    const { tasks, evidence, audit } = this.deps;
    const task = tasks.get(taskId);
    const taskEvidence = evidence.listByTask(taskId);

    const result = checkTransition({ task, to, actor, evidence: taskEvidence });

    if (!result.ok) {
      audit.record(actor, 'WORKFLOW_TRANSITION_DENIED', 'task', taskId, {
        from: result.from,
        to: result.to,
        reason: result.reason,
        missing: result.missing,
      });
      return result;
    }

    // Gate passed: seal consumed evidence FIRST (§42 immutability), then move.
    for (const ev of result.consumedEvidence) {
      evidence.seal(ev.id);
    }
    tasks.setStatus(taskId, to);

    audit.record(actor, 'WORKFLOW_TRANSITIONED', 'task', taskId, {
      from: result.from,
      to: result.to,
      sealedEvidence: result.consumedEvidence.map((e) => ({
        id: e.id,
        type: e.type,
        title: e.title,
      })),
    });

    return result;
  }

  /** High-impact helper: record an arbitrary audited action (§70). */
  recordAction(
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown> = {},
  ) {
    return this.deps.audit.record(actor, action, entityType, entityId, details);
  }
}
