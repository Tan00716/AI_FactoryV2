/**
 * In-memory System Event Bus — spec §91.
 *
 * - subscribe/emit with monotonic `seq` + ISO `ts` on every event
 * - loose payload validation: payload must be a JSON object when provided
 *   (unknown event-type strings are accepted — forward compatibility)
 * - retains the most recent N events (default 1000), oldest evicted first
 * - subscriber errors never break emission or other subscribers
 */
import { createHash, randomUUID } from 'crypto';
import { systemClock } from './types';
import type { Clock, EventEnvelopeInput, EventHandler, FactoryEvent } from './types';

/** §32.1 — sha256 of the canonical (key-sorted) JSON payload. */
export function payloadHashOf(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface EventBusOptions {
  /** How many recent events to retain. Defaults to 1000. */
  retention?: number;
  /** Injectable clock for deterministic tests. */
  clock?: Clock;
}

export class EventBus {
  private seq = 0;
  private readonly events: FactoryEvent[] = [];
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly retention: number;
  private readonly clock: Clock;

  constructor(options: EventBusOptions = {}) {
    this.retention = Math.max(1, options.retention ?? 1000);
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Emit an event. Returns the stored envelope.
   * §32.1: the bus assigns seq/id/ts and derives occurredAt (= ts),
   * recordedAt, schemaVersion ('2.0' default) and payloadHash; producers
   * may attach the remaining domain envelope fields via `envelope`.
   */
  emit(
    type: string,
    payload?: unknown,
    source = 'factory',
    envelope: EventEnvelopeInput = {},
  ): FactoryEvent {
    if (typeof type !== 'string' || type.length === 0) {
      throw new Error('event type must be a non-empty string');
    }
    const data = coercePayload(payload);
    const ts = new Date(this.clock.now()).toISOString();
    const event: FactoryEvent = {
      seq: ++this.seq,
      id: randomUUID(),
      type,
      ts,
      occurredAt: ts,
      recordedAt: new Date(this.clock.now()).toISOString(),
      schemaVersion: envelope.schemaVersion ?? '2.0',
      payloadHash: payloadHashOf(data),
      source,
      payload: data,
      ...(envelope.orgRef !== undefined ? { orgRef: envelope.orgRef } : {}),
      ...(envelope.projectRef !== undefined ? { projectRef: envelope.projectRef } : {}),
      ...(envelope.taskRef !== undefined ? { taskRef: envelope.taskRef } : {}),
      ...(envelope.runRef !== undefined ? { runRef: envelope.runRef } : {}),
      ...(envelope.aggregateId !== undefined ? { aggregateId: envelope.aggregateId } : {}),
      ...(envelope.aggregateVersion !== undefined
        ? { aggregateVersion: envelope.aggregateVersion }
        : {}),
      ...(envelope.actorId !== undefined ? { actorId: envelope.actorId } : {}),
      ...(envelope.actorType !== undefined ? { actorType: envelope.actorType } : {}),
      ...(envelope.correlationId !== undefined ? { correlationId: envelope.correlationId } : {}),
      ...(envelope.causationId !== undefined ? { causationId: envelope.causationId } : {}),
      ...(envelope.idempotencyKey !== undefined ? { idempotencyKey: envelope.idempotencyKey } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.retention) {
      this.events.splice(0, this.events.length - this.retention);
    }
    this.dispatch(event);
    return event;
  }

  /**
   * Subscribe to one event type, or '*' for all events.
   * Returns an unsubscribe function.
   */
  subscribe(type: string | '*', handler: EventHandler): () => void {
    if (typeof handler !== 'function') {
      throw new Error('handler must be a function');
    }
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      const s = this.handlers.get(type);
      if (s) s.delete(handler);
    };
  }

  /** Most recent events, newest first. Optional type filter. */
  recent(limit = 100, type?: string): FactoryEvent[] {
    const n = Math.max(0, limit);
    const out: FactoryEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < n; i--) {
      const e = this.events[i];
      if (type === undefined || e.type === type) out.push({ ...e });
    }
    return out;
  }

  /** Number of retained events. */
  count(): number {
    return this.events.length;
  }

  /** Current sequence number (i.e. total events ever emitted). */
  lastSeq(): number {
    return this.seq;
  }

  private dispatch(event: FactoryEvent): void {
    const specific = this.handlers.get(event.type);
    const wild = this.handlers.get('*');
    const seen = new Set<EventHandler>();
    for (const set of [wild, specific]) {
      if (!set) continue;
      for (const h of set) {
        if (seen.has(h)) continue;
        seen.add(h);
        try {
          h({ ...event });
        } catch {
          // Subscriber failures must not break the bus or other subscribers.
        }
      }
    }
  }
}

/**
 * Loose payload validation: undefined → {}, plain objects pass through,
 * anything else (arrays, primitives) is rejected. The bus never inspects
 * payload contents — producers own redaction (see redact.ts).
 */
function coercePayload(payload: unknown): Record<string, unknown> {
  if (payload === undefined) return {};
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  throw new Error('event payload must be a JSON object (or omitted)');
}
