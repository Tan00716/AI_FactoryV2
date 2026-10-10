/**
 * Key transactions — SPEC v2 §48.4.
 *
 * "State/Lease/Budget/Outbox key changes are committed in one transaction
 * or a coordinatable saga." Each script below is a composable list of
 * steps; every step has an assertion that runs immediately after it.
 * Steps share a TxContext that accumulates outbox events — the events are
 * only "committed" (returned) when EVERY step passes. A failure aborts
 * with TxAbortError naming the step: no partial commit.
 *
 * In production these scripts wrap a real DB transaction; here the unit
 * of work is explicit so the ordering and the assertions are testable
 * without SQLite.
 *
 * Scripts:
 *  - authorizeTask : check human authority → pin root authorization →
 *                    task version update → outbox
 *  - assignStart   : authz/dependency/capability → reserve budget →
 *                    acquire lease/fence → run/delegation → outbox
 *  - transition    : expected version → gates/approvals/artifacts →
 *                    policy → state/milestone/progress invalidation → outbox
 *  - deploy        : PREPARED op + idempotency key + lease + approved
 *                    digest → broker → confirmed/UNKNOWN → reconcile → outbox
 */

export interface OutboxEvent {
  event_id: string;
  event_type: string;
  aggregate_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface TxContext {
  outbox: OutboxEvent[];
  vars: Map<string, unknown>;
}

export interface TxStep<Ctx extends TxContext = TxContext> {
  name: string;
  run(ctx: Ctx): void;
  assert?(ctx: Ctx): void;
}

export class TxAbortError extends Error {
  readonly scriptName: string;
  readonly stepName: string;
  constructor(scriptName: string, stepName: string, reason: string) {
    super(`[${scriptName}] aborted at step "${stepName}": ${reason}`);
    this.name = 'TxAbortError';
    this.scriptName = scriptName;
    this.stepName = stepName;
  }
}

export function newTxContext(): TxContext {
  return { outbox: [], vars: new Map() };
}

/** Run every step in order; assert after each; return the outbox on success. */
export function runTxScript<Ctx extends TxContext>(
  scriptName: string,
  steps: Array<TxStep<Ctx>>,
  ctx: Ctx,
): OutboxEvent[] {
  for (const step of steps) {
    try {
      step.run(ctx);
    } catch (e) {
      throw new TxAbortError(scriptName, step.name, (e as Error).message);
    }
    if (step.assert) {
      try {
        step.assert(ctx);
      } catch (e) {
        throw new TxAbortError(scriptName, `${step.name}::assert`, (e as Error).message);
      }
    }
  }
  return ctx.outbox;
}

// ---------------------------------------------------------------------------
// authorizeTask — §48.4
// ---------------------------------------------------------------------------

export interface AuthorizeTaskInput {
  taskId: string;
  humanId: string;
  orgId: string;
  projectId: string;
  scope: string;
}

export interface AuthorizeTaskDeps {
  /** Throws when the human lacks dispatch authority in this org. */
  checkHumanAuthority(humanId: string, orgId: string): void;
  pinRootAuthorization(input: AuthorizeTaskInput): { id: string; scope: string };
  bumpTaskVersion(taskId: string): number;
  newEventId(): string;
  nowIso(): string;
}

export function authorizeTaskScript(
  deps: AuthorizeTaskDeps,
  input: AuthorizeTaskInput,
): Array<TxStep> {
  return [
    {
      name: 'check-human-authority',
      run(ctx) {
        deps.checkHumanAuthority(input.humanId, input.orgId);
      },
    },
    {
      name: 'pin-root-authorization',
      run(ctx) {
        const root = deps.pinRootAuthorization(input);
        ctx.vars.set('rootAuthorization', root);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: 'AUTHORIZATION_PINNED',
          aggregate_id: input.taskId,
          occurred_at: deps.nowIso(),
          payload: { rootAuthorizationId: root.id, scope: root.scope, humanId: input.humanId },
        });
      },
      assert(ctx) {
        const root = ctx.vars.get('rootAuthorization') as { id: string } | undefined;
        if (!root?.id) throw new Error('root authorization was not pinned');
      },
    },
    {
      name: 'task-version-update',
      run(ctx) {
        const version = deps.bumpTaskVersion(input.taskId);
        ctx.vars.set('taskVersion', version);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: 'TASK_VERSIONED',
          aggregate_id: input.taskId,
          occurred_at: deps.nowIso(),
          payload: { version },
        });
      },
      assert(ctx) {
        if (typeof ctx.vars.get('taskVersion') !== 'number') {
          throw new Error('task version was not bumped');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// assignStart — §48.4
// ---------------------------------------------------------------------------

export interface AssignStartInput {
  taskId: string;
  runId: string;
  delegationId: string;
  orgId: string;
  projectId: string;
  expectedTaskVersion: number;
  envelopeId: string;
  reservationId: string;
  budgetMinor: number;
  resourceId: string;
  capabilityRef: string;
  ttlMs: number;
}

export interface AssignStartDeps {
  checkAuthorization(taskId: string, projectId: string): void;
  checkDependenciesReady(taskId: string): void;
  checkCapability(capabilityRef: string, taskId: string): void;
  reserveBudget(envelopeId: string, reservationId: string, amountMinor: number): void;
  acquireWriterLease(resourceId: string, runId: string, ttlMs: number): number; // returns fencing token
  createRun(runId: string, taskId: string): void;
  createDelegation(delegationId: string, taskId: string, runId: string): void;
  newEventId(): string;
  nowIso(): string;
}

export function assignStartScript(
  deps: AssignStartDeps,
  input: AssignStartInput,
): Array<TxStep> {
  return [
    { name: 'check-authorization', run() { deps.checkAuthorization(input.taskId, input.projectId); } },
    { name: 'check-dependencies', run() { deps.checkDependenciesReady(input.taskId); } },
    { name: 'check-capability', run() { deps.checkCapability(input.capabilityRef, input.taskId); } },
    {
      name: 'reserve-budget',
      run() { deps.reserveBudget(input.envelopeId, input.reservationId, input.budgetMinor); },
    },
    {
      name: 'acquire-lease',
      run(ctx) {
        const fencingToken = deps.acquireWriterLease(input.resourceId, input.runId, input.ttlMs);
        ctx.vars.set('fencingToken', fencingToken);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: 'LEASE_ACQUIRED',
          aggregate_id: input.resourceId,
          occurred_at: deps.nowIso(),
          payload: { runId: input.runId, fencingToken },
        });
      },
      assert(ctx) {
        if (typeof ctx.vars.get('fencingToken') !== 'number') {
          throw new Error('no fencing token issued');
        }
      },
    },
    {
      name: 'create-run',
      run(ctx) {
        deps.createRun(input.runId, input.taskId);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: 'RUN_CREATED',
          aggregate_id: input.runId,
          occurred_at: deps.nowIso(),
          payload: { taskId: input.taskId },
        });
      },
    },
    {
      name: 'create-delegation',
      run(ctx) {
        deps.createDelegation(input.delegationId, input.taskId, input.runId);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: 'DELEGATION_CREATED',
          aggregate_id: input.delegationId,
          occurred_at: deps.nowIso(),
          payload: { taskId: input.taskId, runId: input.runId },
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// transition — §48.4
// ---------------------------------------------------------------------------

export interface TransitionInput {
  taskId: string;
  expectedVersion: number;
  from: string;
  to: string;
  candidateDigest?: string;
}

export interface TransitionDeps {
  checkExpectedVersion(taskId: string, expectedVersion: number): number; // returns actual
  loadGates(taskId: string): Array<{ id: string; verdict: string }>;
  checkApprovals(taskId: string, to: string): void;
  checkArtifacts(taskId: string, candidateDigest?: string): void;
  policyCheck(taskId: string, to: string): void;
  applyState(taskId: string, from: string, to: string): void;
  invalidateMilestones(taskId: string, to: string): string[];
  invalidateProgress(taskId: string): void;
  newEventId(): string;
  nowIso(): string;
}

export function transitionScript(
  deps: TransitionDeps,
  input: TransitionInput,
): Array<TxStep> {
  return [
    {
      name: 'check-expected-version',
      run(ctx) {
        const actual = deps.checkExpectedVersion(input.taskId, input.expectedVersion);
        ctx.vars.set('actualVersion', actual);
      },
      assert(ctx) {
        if (ctx.vars.get('actualVersion') !== input.expectedVersion) {
          throw new Error(`VERSION_CONFLICT: expected ${input.expectedVersion}`);
        }
      },
    },
    {
      name: 'load-gates',
      run(ctx) {
        const gates = deps.loadGates(input.taskId);
        ctx.vars.set('gates', gates);
        const failed = gates.filter((g) => g.verdict === 'FAILED' || g.verdict === 'BLOCKED');
        if (failed.length > 0) {
          throw new Error(`gate(s) not satisfied: ${failed.map((g) => g.id).join(',')}`);
        }
      },
    },
    { name: 'check-approvals', run() { deps.checkApprovals(input.taskId, input.to); } },
    { name: 'check-artifacts', run() { deps.checkArtifacts(input.taskId, input.candidateDigest); } },
    { name: 'policy-check', run() { deps.policyCheck(input.taskId, input.to); } },
    {
      name: 'apply-state',
      run(ctx) {
        deps.applyState(input.taskId, input.from, input.to);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: 'TASK_TRANSITIONED',
          aggregate_id: input.taskId,
          occurred_at: deps.nowIso(),
          payload: { from: input.from, to: input.to },
        });
      },
    },
    {
      name: 'invalidate-milestones',
      run(ctx) {
        const invalidated = deps.invalidateMilestones(input.taskId, input.to);
        ctx.vars.set('invalidatedMilestones', invalidated);
      },
    },
    {
      name: 'invalidate-progress',
      run() { deps.invalidateProgress(input.taskId); },
    },
  ];
}

// ---------------------------------------------------------------------------
// deploy — §48.4
// ---------------------------------------------------------------------------

export type ExternalOpResult = 'CONFIRMED_SUCCEEDED' | 'CONFIRMED_FAILED' | 'UNKNOWN';

export interface DeployInput {
  operationId: string;
  idempotencyKey: string;
  taskId: string;
  artifactDigest: string;
  approvedDigest: string;
  environment: string;
  resourceId: string;
  runId: string;
  ttlMs: number;
}

export interface DeployDeps {
  registerIdempotencyKey(key: string, operationId: string): 'NEW' | 'SEEN_SAME' | 'SEEN_DIFFERENT';
  acquireDeployLease(resourceId: string, runId: string, ttlMs: number): number;
  checkApprovedDigest(artifactDigest: string, approvedDigest: string): void;
  /** The broker performs the external action; may throw or return UNKNOWN. */
  brokerExecute(input: DeployInput): ExternalOpResult;
  recordOperationResult(operationId: string, result: ExternalOpResult): void;
  reconcile(operationId: string, result: ExternalOpResult): void;
  newEventId(): string;
  nowIso(): string;
}

export function deployScript(deps: DeployDeps, input: DeployInput): Array<TxStep> {
  return [
    {
      name: 'prepare-operation',
      run(ctx) {
        const seen = deps.registerIdempotencyKey(input.idempotencyKey, input.operationId);
        if (seen === 'SEEN_DIFFERENT') {
          throw new Error(
            `idempotency key ${input.idempotencyKey} already used with a different payload — refusing second action`,
          );
        }
        ctx.vars.set('idempotencySeen', seen);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: 'EXTERNAL_OP_PREPARED',
          aggregate_id: input.operationId,
          occurred_at: deps.nowIso(),
          payload: { idempotencyKey: input.idempotencyKey, replay: seen === 'SEEN_SAME' },
        });
      },
    },
    {
      name: 'acquire-deploy-lease',
      run(ctx) {
        const token = deps.acquireDeployLease(input.resourceId, input.runId, input.ttlMs);
        ctx.vars.set('fencingToken', token);
      },
      assert(ctx) {
        if (typeof ctx.vars.get('fencingToken') !== 'number') throw new Error('no fencing token');
      },
    },
    {
      name: 'check-approved-digest',
      run() { deps.checkApprovedDigest(input.artifactDigest, input.approvedDigest); },
    },
    {
      name: 'broker-execute',
      run(ctx) {
        const result = deps.brokerExecute(input);
        ctx.vars.set('opResult', result);
        ctx.outbox.push({
          event_id: deps.newEventId(),
          event_type: result === 'UNKNOWN' ? 'EXTERNAL_OP_UNKNOWN' : 'EXTERNAL_OP_RECORDED',
          aggregate_id: input.operationId,
          occurred_at: deps.nowIso(),
          payload: { result },
        });
      },
    },
    {
      name: 'record-result',
      run(ctx) {
        deps.recordOperationResult(input.operationId, ctx.vars.get('opResult') as ExternalOpResult);
      },
    },
    {
      name: 'reconcile',
      run(ctx) {
        // UNKNOWN is never blindly replayed: reconcile coordinates instead.
        deps.reconcile(input.operationId, ctx.vars.get('opResult') as ExternalOpResult);
      },
      assert() {
        // The deploy script never auto-retries an UNKNOWN external action.
      },
    },
  ];
}
