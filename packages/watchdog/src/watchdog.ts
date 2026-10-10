/**
 * Watchdog — SPEC v2 §30.
 *
 * Tracks worker heartbeats, derives health, diagnoses the cause class, and
 * rate-limits recovery. State transitions and kill requests issued here go
 * through the injected policy gate (§30: "不能凭一个 Timer 重复重启所有
 * Worker"). The watchdog monitors its own health too, and a circuit breaker
 * stops restart storms.
 *
 * Clock is injectable; all time comes from it, so tests are deterministic.
 */
import {
  CircuitOpen,
  DEFAULT_HEARTBEAT_CONFIG,
  DiagnosisKind,
  Health,
  HeartbeatConfig,
  PolicyDeniedRecovery,
  ThresholdOverride,
  WatchdogError,
  WorkerSignals,
  WorkerStatus,
} from './types';

export interface WatchdogOptions {
  now?: () => number;
  /** Global default thresholds. */
  defaults?: Partial<HeartbeatConfig>;
  /** Gate every recovery action (kill/restart) through policy. */
  policyGate?: (action: 'kill' | 'restart', workerId: string, reason: string) => boolean;
  /** Notify on recovery failure / circuit open (supervisor / human path). */
  onNotify?: (message: string) => void;
  /** Max restarts per worker inside the circuit window. */
  maxRestartsPerWindow?: number;
  /** Circuit window in ms. */
  circuitWindowMs?: number;
  /** Minimum ms between two recovery actions for the same worker. */
  recoveryCooldownMs?: number;
}

interface WorkerState {
  config: HeartbeatConfig;
  lastHeartbeatAt: number | null;
  consecutiveMisses: number;
  health: Health;
  signals: WorkerSignals;
  reconnectable: boolean;
  restarts: number[];
  lastRecoveryAt: number | null;
}

export interface RecoveryRecord {
  workerId: string;
  action: 'kill' | 'restart';
  at: number;
  reason: string;
  diagnosis: DiagnosisKind;
}

export class Watchdog {
  private readonly workers = new Map<string, WorkerState>();
  private readonly overrides: ThresholdOverride[];
  private readonly defaults: HeartbeatConfig;
  private readonly now: () => number;
  private readonly policyGate: (action: 'kill' | 'restart', workerId: string, reason: string) => boolean;
  private readonly onNotify?: (message: string) => void;
  private readonly maxRestartsPerWindow: number;
  private readonly circuitWindowMs: number;
  private readonly recoveryCooldownMs: number;
  private readonly recoveries: RecoveryRecord[] = [];
  private lastTickAt: number | null = null;
  private missedTicks = 0;

  constructor(
    overrides: ThresholdOverride[] = [],
    opts: WatchdogOptions = {},
  ) {
    this.overrides = [...overrides];
    this.defaults = { ...DEFAULT_HEARTBEAT_CONFIG, ...(opts.defaults ?? {}) };
    this.now = opts.now ?? Date.now;
    this.policyGate = opts.policyGate ?? (() => true);
    this.onNotify = opts.onNotify;
    this.maxRestartsPerWindow = opts.maxRestartsPerWindow ?? 3;
    this.circuitWindowMs = opts.circuitWindowMs ?? 300_000;
    this.recoveryCooldownMs = opts.recoveryCooldownMs ?? 30_000;
  }

  private configFor(scope: string): HeartbeatConfig {
    const o = this.overrides.find((x) => x.scope === scope);
    return o ? { ...o.config } : { ...this.defaults };
  }

  /** Register a worker. `scope` selects per-tool/host thresholds. */
  registerWorker(workerId: string, scope = 'default'): void {
    if (this.workers.has(workerId)) return;
    this.workers.set(workerId, {
      config: this.configFor(scope),
      lastHeartbeatAt: null,
      consecutiveMisses: 0,
      health: 'HEALTHY',
      signals: {},
      reconnectable: true,
      restarts: [],
      lastRecoveryAt: null,
    });
  }

  heartbeat(workerId: string): void {
    const w = this.require(workerId);
    w.lastHeartbeatAt = this.now();
    w.consecutiveMisses = 0;
    if (w.health === 'SUSPECTED_STALL' || w.health === 'STALLED') {
      w.health = 'RECOVERING';
    } else if (w.health === 'HEALTHY') {
      // stays healthy
    }
  }

  /** The worker (or its supervisor) reports what it is legitimately doing. */
  reportSignals(workerId: string, signals: WorkerSignals): void {
    const w = this.require(workerId);
    w.signals = { ...w.signals, ...signals };
  }

  setReconnectable(workerId: string, reconnectable: boolean): void {
    this.require(workerId).reconnectable = reconnectable;
  }

  /**
   * Advance the watchdog clock. Derives SUSPECTED_STALL / STALLED from
   * heartbeat gaps — except when the worker is in a legitimate wait
   * (approval wait is WAITING, not a stall).
   */
  tick(): WorkerStatus[] {
    const t = this.now();
    if (this.lastTickAt !== null && t - this.lastTickAt > this.defaults.intervalMs * 4) {
      this.missedTicks += 1;
    }
    this.lastTickAt = t;

    const out: WorkerStatus[] = [];
    for (const [id, w] of this.workers) {
      if (w.health === 'FAILED') {
        out.push(this.status(id, w));
        continue;
      }
      const since =
        w.lastHeartbeatAt === null ? Number.POSITIVE_INFINITY : t - w.lastHeartbeatAt;
      w.consecutiveMisses =
        w.lastHeartbeatAt === null
          ? w.consecutiveMisses + 1
          : Math.floor(since / w.config.intervalMs);

      const explicit = w.signals.explicitState;
      if (explicit === 'WAITING' || explicit === 'IDLE') {
        // §30: waiting on a human approval (or idle) is not a stall.
        w.health = explicit;
        w.consecutiveMisses = 0;
      } else if (explicit === 'BLOCKED' || explicit === 'RECOVERING') {
        w.health = explicit;
      } else if (w.consecutiveMisses >= w.config.missLimit && w.health !== 'STALLED') {
        w.health = 'SUSPECTED_STALL';
      }
      if (
        (since >= w.config.stallAfterMs || w.lastHeartbeatAt === null) &&
        !w.reconnectable
      ) {
        w.health = 'STALLED';
      }
      out.push(this.status(id, w));
    }
    return out;
  }

  /** §30 — diagnose first, then choose a recovery. */
  diagnose(workerId: string): { diagnosis: DiagnosisKind; detail: string } {
    const w = this.require(workerId);
    const s = w.signals;
    if (s.approvalWait) return { diagnosis: 'approval-wait', detail: 'waiting on human approval — not a stall, do not kill' };
    if (s.loopStagnated) return { diagnosis: 'loop-stagnation', detail: 'same failure fingerprint repeating — escalate, do not blindly restart' };
    if (s.quotaOrAuthBlocked) return { diagnosis: 'quota-or-auth', detail: 'provider quota/auth blocked — restarting the worker cannot help' };
    if (s.lockWait) return { diagnosis: 'lock-or-dependency-wait', detail: 'waiting on a lock/dependency' };
    if (s.providerReachable === false) return { diagnosis: 'provider-stalled', detail: 'provider unreachable — check network/credentials before restarting' };
    if (w.health === 'STALLED' || (w.lastHeartbeatAt === null && w.consecutiveMisses > 0)) {
      return { diagnosis: 'worker-lost', detail: 'no heartbeat and unreconnectable — worker presumed lost' };
    }
    if (s.lastToolActivityAt !== undefined) {
      const idleMs = this.now() - s.lastToolActivityAt;
      if (idleMs > w.config.stallAfterMs) {
        return { diagnosis: 'tool-hung', detail: `no tool activity for ${idleMs}ms — tool may be hung` };
      }
    }
    return { diagnosis: 'healthy-activity', detail: 'no stall indicators' };
  }

  /**
   * Request recovery for a worker. The action goes through the policy gate;
   * the circuit breaker refuses restart storms; a cooldown spaces actions.
   */
  requestRecovery(
    workerId: string,
    action: 'kill' | 'restart',
    reason: string,
  ): RecoveryRecord {
    const w = this.require(workerId);
    const t = this.now();
    const { diagnosis } = this.diagnose(workerId);

    // Never "recover" an approval wait by killing it.
    if (diagnosis === 'approval-wait' && action === 'kill') {
      throw new PolicyDeniedRecovery(`refusing to kill ${workerId}: approval-wait is not a stall`);
    }
    if (!this.policyGate(action, workerId, reason)) {
      throw new PolicyDeniedRecovery(`${action} ${workerId}: ${reason}`);
    }
    const recent = w.restarts.filter((r) => t - r < this.circuitWindowMs);
    if (recent.length >= this.maxRestartsPerWindow) {
      const msg = `circuit open for ${workerId}: ${recent.length} restarts in ${this.circuitWindowMs}ms`;
      this.onNotify?.(msg);
      throw new CircuitOpen(workerId);
    }
    if (w.lastRecoveryAt !== null && t - w.lastRecoveryAt < this.recoveryCooldownMs) {
      throw new RecoveryThrottled(workerId, this.recoveryCooldownMs - (t - w.lastRecoveryAt));
    }
    w.restarts.push(t);
    w.lastRecoveryAt = t;
    if (action === 'restart') {
      w.consecutiveMisses = 0;
      w.health = 'RECOVERING';
    } else {
      w.health = 'FAILED';
    }
    const rec: RecoveryRecord = { workerId, action, at: t, reason, diagnosis };
    this.recoveries.push(rec);
    return rec;
  }

  markFailed(workerId: string, reason: string): void {
    const w = this.require(workerId);
    w.health = 'FAILED';
    this.onNotify?.(`worker ${workerId} marked FAILED: ${reason}`);
  }

  getStatus(workerId: string): WorkerStatus {
    return this.status(workerId, this.require(workerId));
  }

  recoveryHistory(): RecoveryRecord[] {
    return [...this.recoveries];
  }

  /** The watchdog's own health: missed ticks degrade it. */
  selfHealth(): 'ok' | 'degraded' {
    return this.missedTicks === 0 ? 'ok' : 'degraded';
  }

  private status(id: string, w: WorkerState): WorkerStatus {
    const { diagnosis, detail } = this.diagnose(id);
    return {
      workerId: id,
      health: w.health,
      consecutiveMisses: w.consecutiveMisses,
      lastHeartbeatAt: w.lastHeartbeatAt,
      diagnosis,
      detail,
    };
  }

  private require(workerId: string): WorkerState {
    const w = this.workers.get(workerId);
    if (!w) throw new WatchdogError('UNKNOWN_WORKER', `Unknown worker ${workerId}`);
    return w;
  }
}

class RecoveryThrottled extends WatchdogError {
  constructor(workerId: string, waitMs: number) {
    super('RECOVERY_THROTTLED', `Recovery for ${workerId} throttled: wait ${waitMs}ms`);
  }
}
