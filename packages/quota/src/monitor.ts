/**
 * Quota monitor — SPEC v2 §27.1–§27.2, §27.4.
 *
 * Records provider-reported usage, classifies limit events, and answers the
 * two operational questions: "what does policy say to do?" and "may already
 * started deterministic tools keep running while the quota is hit?"
 *
 * §27.4: started + still-authorized deterministic tools (pytest, build, CI,
 * read-only monitoring) MAY continue and must save their results; anything
 * needing a NEW model decision pauses. Quota exhaustion is not a license for
 * unbounded deterministic work — timeout, budget, risk and control-epoch
 * constraints still apply.
 */
import {
  LimitEvent,
  LimitEventKind,
  QuotaBucket,
  QuotaError,
} from './types';
import { decideQuotaPolicy, QuotaDecision, QuotaPolicyName } from './policy';

export interface QuotaMonitorOptions {
  now?: () => number;
  /** Quota policy selected for the workspace/factory. */
  policy?: QuotaPolicyName;
}

/** A deterministic tool that was already running when the quota hit. */
export interface InflightTool {
  toolId: string;
  runId: string;
  /** Must still hold: authorization, budget, risk approval, control epoch. */
  authorizationValid: boolean;
  budgetRemaining: number;
  riskApproved: boolean;
  controlEpochCurrent: boolean;
  timeoutMs: number;
  startedAt: number;
}

export class DeterministicToolBlocked extends QuotaError {
  constructor(toolId: string, reason: string) {
    super('DETERMINISTIC_TOOL_BLOCKED', `Inflight deterministic tool ${toolId} may not continue: ${reason}`);
  }
}

export class QuotaMonitor {
  private readonly buckets = new Map<string, QuotaBucket>();
  private readonly events: LimitEvent[] = [];
  private readonly now: () => number;
  private policy: QuotaPolicyName;

  constructor(opts: QuotaMonitorOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.policy = opts.policy ?? 'STRICT_PROVIDER';
  }

  setPolicy(p: QuotaPolicyName): void {
    this.policy = p;
  }

  getPolicy(): QuotaPolicyName {
    return this.policy;
  }

  private key(b: Pick<QuotaBucket, 'providerAccountId' | 'workspaceId' | 'limitBucket'>): string {
    return `${b.providerAccountId}|${b.workspaceId}|${b.limitBucket}`;
  }

  recordBucket(b: QuotaBucket): void {
    this.buckets.set(this.key(b), { ...b });
  }

  /**
   * List all recorded provider buckets (copies). Backs
   * GET /api/quota/buckets — usage display (§27, spec §29.1 quota strip).
   */
  listBuckets(): QuotaBucket[] {
    return [...this.buckets.values()].map((b) => ({ ...b }));
  }

  getBucket(
    providerAccountId: string,
    workspaceId: string,
    limitBucket: string,
  ): QuotaBucket | undefined {
    const b = this.buckets.get(`${providerAccountId}|${workspaceId}|${limitBucket}`);
    return b ? { ...b } : undefined;
  }

  /**
   * Classify a provider signal into a limit event. Unknown signals are not
   * silently dropped — they surface as PROVIDER_OUTAGE for triage.
   */
  recordLimitSignal(
    signal: string,
    bucket: QuotaBucket,
    retryAfterSec?: number,
  ): LimitEvent {
    const s = signal.toLowerCase();
    let kind: LimitEventKind;
    if (/429|rate.?limit/.test(s)) kind = 'RATE_LIMITED_429';
    else if (/credit|budget|quota|exhaust/i.test(s)) kind = 'CREDITS_EXHAUSTED';
    else if (/concurr/.test(s)) kind = 'CONCURRENCY_LIMIT';
    else if (/auth|401|403|expir/.test(s)) kind = 'AUTH_EXPIRY';
    else kind = 'PROVIDER_OUTAGE';
    const event: LimitEvent = {
      kind,
      bucket: { ...bucket },
      retryAfterSec,
      observedAt: new Date(this.now()).toISOString(),
    };
    this.events.push(event);
    return { ...event };
  }

  recentEvents(): LimitEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Apply the configured policy to a limit event. */
  decide(event: LimitEvent, affectedRunIds: string[]): QuotaDecision {
    return decideQuotaPolicy(this.policy, event, affectedRunIds);
  }

  /**
   * §27.4 — may an already-running deterministic tool continue while the
   * quota is hit? Only when it is still authorized, funded, risk-approved,
   * inside the current control epoch, and within its own timeout.
   */
  assertInflightToolMayContinue(tool: InflightTool): void {
    const t = this.now();
    if (!tool.authorizationValid) {
      throw new DeterministicToolBlocked(tool.toolId, 'authorization no longer valid');
    }
    if (!tool.riskApproved) {
      throw new DeterministicToolBlocked(tool.toolId, 'risk approval lapsed');
    }
    if (!tool.controlEpochCurrent) {
      throw new DeterministicToolBlocked(tool.toolId, 'control epoch changed — re-authorize');
    }
    if (tool.budgetRemaining <= 0) {
      throw new DeterministicToolBlocked(tool.toolId, 'no budget remaining');
    }
    if (t - tool.startedAt > tool.timeoutMs) {
      throw new DeterministicToolBlocked(tool.toolId, 'own timeout exceeded');
    }
  }
}
