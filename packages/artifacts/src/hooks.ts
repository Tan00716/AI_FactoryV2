/**
 * Workflow hooks — spec §23 ("every important workflow action should
 * generate or reference an Artifact").
 *
 * This interface stays decoupled from the workflow core on purpose:
 * `ArtifactWorkflowHooks` consumes plain `{ kind, taskId, payload }`
 * events and turns key actions into artifacts, plus `register()` lets
 * future core wiring add/override handlers without touching the store.
 * The workflow core binds to this later; nothing here imports it.
 */
import { Artifact, ArtifactType } from './types';
import { ArtifactStore } from './store';

/** A workflow event the artifact system reacts to. */
export interface WorkflowEvent {
  /** Event kind, e.g. 'TASK_COMPLETED', 'TEST_RUN_FINISHED'. */
  kind: string;
  /** Task the event belongs to; becomes the artifact's taskId. */
  taskId: string;
  /**
   * Raw event data. The hook maps fields onto the artifact schema.
   * Special key: `relatedArtifactIds?: string[]` — existing artifacts to
   * link bidirectionally to each artifact this event generates.
   */
  payload?: Record<string, unknown>;
}

/** Handler invoked for one event kind; returns generated artifacts. */
export type WorkflowHookHandler = (event: WorkflowEvent, ctx: HookContext) => Artifact[];

/** What a handler gets: the store plus a clock-bound ISO timestamp. */
export interface HookContext {
  store: ArtifactStore;
  nowIso(): string;
}

interface AutoRule {
  type: ArtifactType;
  title: (e: WorkflowEvent) => string;
  fields: (e: WorkflowEvent) => Record<string, unknown>;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((i): i is string => typeof i === 'string') : [];
}

/**
 * Default rules: event kind → artifact type + field mapping. Payload
 * fields are used when present; otherwise safe non-empty defaults keep
 * auto-generation total (never throws validation errors). Generated
 * artifacts start as DRAFT — a human or the workflow can seal them.
 */
const DEFAULT_RULES: Record<string, AutoRule> = {
  TASK_PLANNED: {
    type: 'PLAN',
    title: (e) => str(e.payload?.title, `Plan for task ${e.taskId}`),
    fields: (e) => ({
      objective: str(e.payload?.objective, '(auto-generated draft — describe the objective)'),
      steps: strArr(e.payload?.steps),
    }),
  },
  COMMIT_PUSHED: {
    type: 'COMMIT',
    title: (e) => `Commit ${str(e.payload?.sha, 'unknown')}`,
    fields: (e) => ({
      sha: str(e.payload?.sha, 'unknown'),
      message: str(e.payload?.message, '(auto-generated)'),
      author: str(e.payload?.author, 'unknown'),
    }),
  },
  PR_OPENED: {
    type: 'PULL_REQUEST',
    title: (e) => str(e.payload?.title, `PR #${num(e.payload?.prNumber, 0)}`),
    fields: (e) => ({
      prNumber: num(e.payload?.prNumber, 0),
      title: str(e.payload?.title, '(auto-generated)'),
      sourceBranch: str(e.payload?.sourceBranch, 'unknown'),
      targetBranch: str(e.payload?.targetBranch, 'unknown'),
    }),
  },
  CODE_REVIEWED: {
    type: 'CODE_REVIEW',
    title: (e) => `Code review by ${str(e.payload?.reviewer, 'unknown')}`,
    fields: (e) => ({
      reviewer: str(e.payload?.reviewer, 'unknown'),
      verdict: str(e.payload?.verdict, 'comment'),
      findings: strArr(e.payload?.findings),
    }),
  },
  TEST_PLAN_CREATED: {
    type: 'TEST_PLAN',
    title: (e) => str(e.payload?.title, `Test plan for task ${e.taskId}`),
    fields: (e) => ({
      testCases: strArr(e.payload?.testCases),
      environment: str(e.payload?.environment, 'unknown'),
    }),
  },
  TEST_RUN_FINISHED: {
    type: 'TEST_RESULT',
    title: (e) => `Test result: ${str(e.payload?.suite, 'default suite')}`,
    fields: (e) => ({
      suite: str(e.payload?.suite, 'default'),
      passed: num(e.payload?.passed, 0),
      failed: num(e.payload?.failed, 0),
      summary: str(e.payload?.summary, '(auto-generated draft — fill in the summary)'),
    }),
  },
  SECURITY_SCAN_FINISHED: {
    type: 'SECURITY_REPORT',
    title: (e) => `Security report: ${str(e.payload?.scanner, 'scan')}`,
    fields: (e) => ({
      scanner: str(e.payload?.scanner, 'unknown'),
      severity: str(e.payload?.severity, 'unknown'),
      findings: strArr(e.payload?.findings),
    }),
  },
  BUILD_FINISHED: {
    type: 'BUILD_ARTIFACT',
    title: (e) => `Build ${str(e.payload?.artifactName, 'artifact')} ${str(e.payload?.version, '')}`.trim(),
    fields: (e) => ({
      artifactName: str(e.payload?.artifactName, 'unknown'),
      version: str(e.payload?.version, '0.0.0'),
      location: str(e.payload?.location, 'unknown'),
    }),
  },
  DEPLOY_FINISHED: {
    type: 'DEPLOYMENT',
    title: (e) => `Deploy ${str(e.payload?.version, 'unknown')} → ${str(e.payload?.environment, 'unknown')}`,
    fields: (e) => ({
      environment: str(e.payload?.environment, 'unknown'),
      version: str(e.payload?.version, 'unknown'),
      status: str(e.payload?.status, 'success'),
    }),
  },
  SMOKE_TEST_FINISHED: {
    type: 'SMOKE_TEST',
    title: (e) => `Smoke test on ${str(e.payload?.environment, 'unknown')}`,
    fields: (e) => ({
      environment: str(e.payload?.environment, 'unknown'),
      checksPassed: num(e.payload?.checksPassed, 0),
      checksFailed: num(e.payload?.checksFailed, 0),
    }),
  },
  UAT_FINISHED: {
    type: 'UAT_RESULT',
    title: (e) => `UAT by ${str(e.payload?.tester, 'unknown')}`,
    fields: (e) => ({
      tester: str(e.payload?.tester, 'unknown'),
      verdict: str(e.payload?.verdict, 'accept'),
      signOff: typeof e.payload?.signOff === 'boolean' ? e.payload.signOff : false,
    }),
  },
  RELEASE_CUT: {
    type: 'RELEASE',
    title: (e) => `Release ${str(e.payload?.version, 'unknown')}`,
    fields: (e) => ({
      version: str(e.payload?.version, 'unknown'),
      releaseNotes: str(e.payload?.releaseNotes, '(auto-generated draft — fill in release notes)'),
    }),
  },
  INCIDENT_RAISED: {
    type: 'INCIDENT',
    title: (e) => str(e.payload?.title, `Incident on task ${e.taskId}`),
    fields: (e) => ({
      severity: str(e.payload?.severity, 'unknown'),
      title: str(e.payload?.title, '(auto-generated draft — describe the incident)'),
      description: str(e.payload?.description, '(auto-generated draft — describe the incident)'),
      status: str(e.payload?.status, 'open'),
    }),
  },
  ROLLBACK_EXECUTED: {
    type: 'ROLLBACK',
    title: (e) => `Rollback to ${str(e.payload?.rollbackToVersion, 'unknown')}`,
    fields: (e) => ({
      rollbackToVersion: str(e.payload?.rollbackToVersion, 'unknown'),
      reason: str(e.payload?.reason, '(auto-generated draft — record the reason)'),
      status: str(e.payload?.status, 'success'),
    }),
  },
  TASK_COMPLETED: {
    type: 'FINAL_REPORT',
    title: (e) => str(e.payload?.title, `Final report for task ${e.taskId}`),
    fields: (e) => ({
      title: str(e.payload?.title, `Final report for task ${e.taskId}`),
      summary: str(e.payload?.summary, '(auto-generated draft — fill in the task summary)'),
      outcomes: strArr(e.payload?.outcomes),
    }),
  },
};

export class ArtifactWorkflowHooks {
  private readonly handlers = new Map<string, WorkflowHookHandler>();
  private readonly now: () => number;

  constructor(
    private readonly store: ArtifactStore,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    for (const [kind, rule] of Object.entries(DEFAULT_RULES)) {
      this.handlers.set(kind, (event) => [this.applyRule(event, rule)]);
    }
  }

  private applyRule(event: WorkflowEvent, rule: AutoRule): Artifact {
    const artifact = this.store.create({
      taskId: event.taskId,
      type: rule.type,
      title: rule.title(event),
      fields: rule.fields(event),
      createdBy: `workflow:${event.kind}`,
    });
    this.autoLink(artifact, event);
    return artifact;
  }

  /** Link `payload.relatedArtifactIds` to a freshly generated artifact. */
  private autoLink(artifact: Artifact, event: WorkflowEvent): void {
    const ids = event.payload?.relatedArtifactIds;
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id === 'string' && id !== artifact.id) {
        this.store.link(artifact.id, id);
      }
    }
  }

  /**
   * Handle a workflow event. Returns the artifacts generated (and/or
   * associated) by this event — empty when no handler is registered for
   * the event kind. Never throws for unknown kinds (decoupled by design).
   */
  onWorkflowEvent(event: WorkflowEvent): Artifact[] {
    const handler = this.handlers.get(event.kind);
    if (!handler) return [];
    const ctx: HookContext = { store: this.store, nowIso: () => new Date(this.now()).toISOString() };
    return handler(event, ctx);
  }

  /**
   * Register (or override) a handler for an event kind. The workflow
   * core will use this to bind richer, core-specific generation logic
   * later — e.g. a TASK_COMPLETED handler that summarizes linked
   * artifacts into the FINAL_REPORT draft.
   */
  register(kind: string, handler: WorkflowHookHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Event kinds that currently have handlers. */
  registeredKinds(): string[] {
    return [...this.handlers.keys()];
  }
}
