/**
 * System Event Bus — event envelope types (spec §91).
 */
import type { FactoryEventType } from './eventTypes';

/** One event on the bus. `seq` is a per-bus monotonic sequence number. */
export interface FactoryEvent {
  /** Monotonic sequence number, assigned by the bus (starts at 1). */
  seq: number;
  /** Stable unique id for the event. */
  id: string;
  /** §91 event name (loose: any non-empty string is accepted). */
  type: FactoryEventType | string;
  /** ISO-8601 timestamp of emission. */
  ts: string;
  /** Producer label, e.g. 'server', 'qa', 'runtime'. */
  source: string;
  /** Event-specific data. Never contains secrets — producers must redact. */
  payload: Record<string, unknown>;
}

/** Input accepted by `EventBus.emit`. */
export interface EmitInput {
  type: string;
  payload?: unknown;
  source?: string;
}

/** Subscriber callback. */
export type EventHandler = (event: FactoryEvent) => void;

/** Injectable clock for deterministic tests. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
