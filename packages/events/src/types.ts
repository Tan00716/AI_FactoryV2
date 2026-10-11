/**
 * System Event Bus — event envelope types (spec §32, v1 vocabulary §91).
 *
 * §32.1 envelope: every event carries event_id, event_type, schema_version,
 * org/project/task/run refs, aggregate_id/version, actor_id/type,
 * correlation_id, causation_id, idempotency_key, occurred_at, recorded_at,
 * payload, payload_hash. The bus populates the transport-assigned fields;
 * producers may attach the domain fields via the emit envelope option.
 */
import type { FactoryEventType } from './eventTypes';

/** §32.1 — domain envelope fields a producer may attach at emit time. */
export interface EventEnvelopeInput {
  /** Envelope schema version, e.g. '2.0'. Defaults to '2.0'. */
  schemaVersion?: string;
  orgRef?: string;
  projectRef?: string;
  taskRef?: string;
  runRef?: string;
  aggregateId?: string;
  aggregateVersion?: number;
  actorId?: string;
  actorType?: string;
  /** Links this event to the originating request/workflow. */
  correlationId?: string;
  /** Id of the event that caused this one. */
  causationId?: string;
  /** Client-supplied idempotency key; consumers dedupe on it. */
  idempotencyKey?: string;
}

/** One event on the bus. `seq` is a per-bus monotonic sequence number. */
export interface FactoryEvent extends EventEnvelopeInput {
  /** Monotonic sequence number, assigned by the bus (starts at 1). */
  seq: number;
  /** Stable unique id for the event (≡ §32.1 event_id). */
  id: string;
  /** §32.1 event_type (loose: any non-empty string is accepted). */
  type: FactoryEventType | string;
  /** ISO-8601 timestamp of emission (≡ §32.1 occurred_at). */
  ts: string;
  /** §32.1 occurred_at — always equals ts. */
  occurredAt: string;
  /** §32.1 recorded_at — when the bus recorded the event (UTC). */
  recordedAt: string;
  /** §32.1 schema_version. */
  schemaVersion: string;
  /** §32.1 payload_hash — sha256 of the canonical JSON payload. */
  payloadHash: string;
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
