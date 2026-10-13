/**
 * Git Broker — spec §36 ("Git Broker 按动作控制远端、Branch、Repository
 * 和凭证": the broker controls remotes, branches, repositories and
 * credentials BY ACTION).
 *
 * A policy gate in front of git operations. Every operation is first
 * classified into an action category; the broker then decides — before
 * anything touches a repository — whether that category is allowed at
 * all (fail-closed allowlist: a category not listed is denied), whether
 * the call carries the context the category demands (e.g. a task
 * binding for push/merge/remote), and whether the host's injected
 * context check vetoes it (e.g. "this task's project is archived").
 *
 * Design rules, mirroring the rest of this codebase:
 * - The broker knows nothing about HTTP, the server, or the database.
 *   Host-specific context (archived projects, branch protection lists,
 *   credential availability) arrives through the injected
 *   `contextCheck` predicate — @ai-factory/git never imports the
 *   server or @ai-factory/db.
 * - EVERY decision, allow or deny, is reported to the injected audit
 *   hook with its reason. A denied operation is never executed:
 *   `execute()` authorizes first and only then runs the operation, so
 *   a denial is zero-side-effect by construction.
 * - Credentials: the broker never sees or stores credential material.
 *   It controls whether an action category may run at all; the actual
 *   credential a git invocation uses stays with git's own credential
 *   helpers, inside the host's process/network policy (§36: repository
 *   configuration must not bypass process/network policy).
 */

export type GitAction =
  | 'read' // status / log / diff / branch listing
  | 'branch' // create branch, checkout, task branches
  | 'commit'
  | 'push'
  | 'pull'
  | 'merge'
  | 'rebase'
  | 'tag'
  | 'stash'
  | 'worktree' // §22.1 (Batch 19): git worktree add / remove — a working
  // tree (and usually its task branch) created or deleted for one task.
  | 'remote'; // remote management (add / remove / set-url)

/** Every action category the broker can classify. */
export const GIT_ACTIONS: readonly GitAction[] = [
  'read',
  'branch',
  'commit',
  'push',
  'pull',
  'merge',
  'rebase',
  'tag',
  'stash',
  'worktree',
  'remote',
];

/** Who is asking, and the context the policy may demand. */
export interface GitBrokerContext {
  /** The human/agent identity performing the action (for audit). */
  actor: string;
  /** Repository path the action targets. */
  repo: string;
  /** Task the action is bound to, when it creates task-scoped facts. */
  taskId?: string;
  /** Project the action belongs to, when the caller resolved one. */
  projectId?: string;
  /** Branch involved (pushed branch, merge source/target, …). */
  branch?: string;
  /** Remote involved (push/pull/remote actions). */
  remote?: string;
}

/** One broker decision — the audit record shape. */
export interface GitBrokerDecision {
  allowed: boolean;
  action: GitAction;
  actor: string;
  repo: string;
  taskId: string | null;
  branch: string | null;
  remote: string | null;
  /** Why the action was denied; null when allowed. */
  reason: string | null;
  /** ISO timestamp of the decision. */
  at: string;
}

export type GitBrokerAuditHook = (decision: GitBrokerDecision) => void;

export interface GitBrokerPolicy {
  /**
   * Action categories allowed at all. FAIL-CLOSED: a category not in
   * this list is denied, whatever the context.
   */
  allowedActions: ReadonlySet<GitAction> | readonly GitAction[];
  /**
   * Categories that additionally require a task binding (`taskId` in
   * the context). Default: push, merge, remote — the categories whose
   * effects leave the local repository or rewrite its history.
   */
  taskRequiredActions?: readonly GitAction[];
  /**
   * Host-injected context check: return a denial reason string to veto
   * the action, or null to let it proceed. This is where server-side
   * rules live (archived project, credential scope, …) without the
   * broker importing the host.
   */
  contextCheck?: (
    action: GitAction,
    ctx: GitBrokerContext,
  ) => string | null | Promise<string | null>;
}

const DEFAULT_TASK_REQUIRED: readonly GitAction[] = [
  'push',
  'merge',
  'remote',
  'worktree', // worktrees are always task-owned (§22.1); a taskless
  // worktree creation is refused by the package default.
];

/** The package default: every category allowed, task binding required
 *  for push/merge/remote. Hosts tighten `allowedActions` to taste. */
export function defaultGitBrokerPolicy(): GitBrokerPolicy {
  return {
    allowedActions: [...GIT_ACTIONS],
    taskRequiredActions: [...DEFAULT_TASK_REQUIRED],
  };
}

/** Thrown by GitBroker.execute when the action is denied. The operation
 *  was NOT run. Carries the full decision for the caller's response. */
export class GitBrokerDeniedError extends Error {
  readonly decision: GitBrokerDecision;
  constructor(decision: GitBrokerDecision) {
    super(`git broker denied action "${decision.action}": ${decision.reason ?? 'denied'}`);
    this.name = 'GitBrokerDeniedError';
    this.decision = decision;
  }
}

export interface GitBrokerOptions {
  /** Receives EVERY decision (allow and deny), for the audit log. */
  audit?: GitBrokerAuditHook;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class GitBroker {
  private readonly allowed: ReadonlySet<GitAction>;
  private readonly taskRequired: ReadonlySet<GitAction>;
  private readonly contextCheck?: GitBrokerPolicy['contextCheck'];
  private readonly audit?: GitBrokerAuditHook;
  private readonly now: () => Date;

  constructor(policy: GitBrokerPolicy, opts: GitBrokerOptions = {}) {
    this.allowed = new Set(policy.allowedActions);
    this.taskRequired = new Set(policy.taskRequiredActions ?? DEFAULT_TASK_REQUIRED);
    this.contextCheck = policy.contextCheck;
    this.audit = opts.audit;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Decide whether `action` may proceed under `ctx`. Pure decision —
   * runs nothing — but every call is audited. Denial order: allowlist
   * (fail-closed) → task binding → host context check.
   */
  async authorize(action: GitAction, ctx: GitBrokerContext): Promise<GitBrokerDecision> {
    let reason: string | null = null;
    if (!this.allowed.has(action)) {
      reason = `action "${action}" is not in the git broker allowlist`;
    } else if (this.taskRequired.has(action) && !ctx.taskId) {
      reason = `action "${action}" requires a task binding (taskId)`;
    } else if (this.contextCheck) {
      reason = await this.contextCheck(action, ctx);
    }
    const decision: GitBrokerDecision = {
      allowed: reason === null,
      action,
      actor: ctx.actor,
      repo: ctx.repo,
      taskId: ctx.taskId ?? null,
      branch: ctx.branch ?? null,
      remote: ctx.remote ?? null,
      reason,
      at: this.now().toISOString(),
    };
    this.audit?.(decision);
    return decision;
  }

  /**
   * Authorize, then run `operation`. On denial throws
   * GitBrokerDeniedError and the operation is never invoked.
   */
  async execute<T>(
    action: GitAction,
    ctx: GitBrokerContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const decision = await this.authorize(action, ctx);
    if (!decision.allowed) throw new GitBrokerDeniedError(decision);
    return operation();
  }
}
