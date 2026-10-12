/**
 * Archived-project write guard (Batch 14).
 *
 * Archive is a lifecycle STATUS, not a deletion: an archived project's
 * history (tasks, evidence, approvals, reports) stays fully readable,
 * but no NEW facts may be created under it until it is unarchived. This
 * module is the single place that decision is evaluated, so every
 * guarded route answers identically:
 *
 *   409 { error, code: 'PROJECT_ARCHIVED', projectId }
 *
 * Guarded write surfaces (see the Batch 14 report for the full
 * inventory, including the surfaces deliberately NOT guarded):
 *   - POST /api/tasks and the task-scoped POSTs in index.ts
 *     (transition / evidence / subtasks / dependencies) — via task →
 *     project resolution;
 *   - POST /api/projects/:id/import (routes/project-io.ts);
 *   - POST /api/runtime/runs (routes/runtime.ts) — refused before the
 *     run record exists, so no record/intent/checkpoint is created;
 *   - POST /api/tasks/:id/v2-transition and /v2-complete
 *     (routes/v2-transitions.ts) — refused before the engine is touched;
 *   - the task-bound approval writes (routes/approvals.ts): create
 *     (when task_id is present), decision, invalidate, cancel;
 *   - POST /api/review when a taskId is supplied (routes/review.ts) —
 *     it seals gate evidence onto the task;
 *   - POST /api/qa/runs (routes/qa.ts) — it writes qa_result evidence
 *     onto the task;
 *   - the pipeline execution surface (routes/cicd.ts, Batch 15):
 *     POST /api/pipelines (when taskId is given), /:id/run,
 *     /:id/deploy, /:id/approve and /:id/rollback — each resolves its
 *     task from the body, the pipeline record, or the deploy's
 *     approval ticket, and refuses before any evidence/deployment
 *     side effect;
 *   - the task-bound git surface (routes/git.ts, Batch 15):
 *     POST /api/git/commit (when taskId is given — refused before
 *     the commit itself), /api/git/task-branch, /api/git/pr and
 *     /api/git/pr/:id/merge.
 *
 * Deliberately NOT guarded: the pure repository operations in
 * routes/git.ts (POST /api/git/branch, /checkout, /push) — they take
 * no task binding and create no task-scoped facts — and every GET:
 * reads of an archived project stay open by design.
 *
 * Access pattern: most routes import these helpers directly.
 * runtime.ts and review.ts instead receive the decision through
 * RouteContext.archivedTaskBody (injected by the coordinator in
 * index.ts, backed by isTaskProjectArchived/projectArchivedBody here),
 * because tests import those two modules straight from src, where an
 * extensionless value import does not resolve under Node's
 * type-stripping ESM loader. The decision logic lives only here
 * either way.
 */
import type { FactoryDatabase } from '@ai-factory/db';

/** True when the project exists AND is archived. Unknown ids are not archived. */
export function isProjectArchived(fdb: FactoryDatabase, projectId: string): boolean {
  const p = fdb.getProject(projectId);
  return p !== undefined && p.status === 'archived';
}

/** The project a task belongs to, or undefined when the task is unknown. */
export function projectIdOfTask(fdb: FactoryDatabase, taskId: string): string | undefined {
  return fdb.tasks.get(taskId)?.projectId;
}

/** True when writes under this task's project must be refused. */
export function isTaskProjectArchived(fdb: FactoryDatabase, taskId: string): boolean {
  const projectId = projectIdOfTask(fdb, taskId);
  return projectId !== undefined && isProjectArchived(fdb, projectId);
}

/** The uniform 409 body every guarded route returns. */
export function projectArchivedBody(projectId: string): {
  error: string;
  code: 'PROJECT_ARCHIVED';
  projectId: string;
} {
  return {
    error: `project is archived: ${projectId} (unarchive it to write again)`,
    code: 'PROJECT_ARCHIVED',
    projectId,
  };
}
