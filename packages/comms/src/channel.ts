import {
  CommsMessage,
  CommsPayload,
  MESSAGE_KINDS,
  MessageKind,
  TaskTrace,
} from './types.ts';

/** Inject for deterministic time in tests. */
export interface Clock {
  now: () => number;
}

export interface ChannelOptions {
  clock?: Clock;
  /** Max serialized payload size in bytes. Defaults to 64 KiB. */
  maxPayloadBytes?: number;
}

export interface PostInput {
  taskId: string;
  from: string;
  to: string;
  payload: CommsPayload;
  /** New correlation id is minted when omitted. */
  correlationId?: string;
}

export type CommsErrorCode =
  | 'MISSING_TASK_ID'
  | 'MISSING_SENDER'
  | 'MISSING_RECIPIENT'
  | 'EMPTY_PAYLOAD'
  | 'UNKNOWN_KIND'
  | 'PAYLOAD_TOO_LARGE'
  | 'MESSAGE_NOT_FOUND';

export class CommsError extends Error {
  readonly code: CommsErrorCode;
  constructor(code: CommsErrorCode, message: string) {
    super(message);
    this.name = 'CommsError';
    this.code = code;
  }
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * In-memory delivery channel, isolated per taskId.
 *
 * post() validates every message: non-empty payload, known primitive kind
 * (free-text/chat kinds are rejected), bounded payload size, and a taskId.
 */
export class Channel {
  private readonly clock: Clock;
  private readonly maxPayloadBytes: number;
  private seq = 0;
  private readonly messages: CommsMessage[] = [];
  private readonly byId = new Map<string, CommsMessage>();

  constructor(options: ChannelOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  }

  /** Validate and deliver a message, returning the stored envelope. */
  post(input: PostInput): CommsMessage {
    this.validate(input);

    this.seq += 1;
    const correlationId =
      input.correlationId && input.correlationId.trim().length > 0
        ? input.correlationId
        : `corr-${this.seq}`;
    const message: CommsMessage = {
      id: `msg-${this.seq}`,
      taskId: input.taskId.trim(),
      from: input.from.trim(),
      to: input.to.trim(),
      timestamp: this.clock.now(),
      correlationId,
      payload: input.payload,
    };
    this.messages.push(message);
    this.byId.set(message.id, message);
    return message;
  }

  /** Fetch a single message by id. */
  getById(id: string): CommsMessage {
    const message = this.byId.get(id);
    if (!message) {
      throw new CommsError('MESSAGE_NOT_FOUND', `no message with id ${id}`);
    }
    return message;
  }

  /** All messages for one task, in posting order. */
  listByTask(taskId: string): CommsMessage[] {
    return this.messages.filter((m) => m.taskId === taskId);
  }

  /**
   * Trace one handoff chain: every message sharing a correlationId,
   * in chronological order.
   */
  traceChain(correlationId: string): CommsMessage[] {
    return this.messages
      .filter((m) => m.correlationId === correlationId)
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }

  /**
   * Export the complete communication trace of a task
   * (feeds run/trace auditing).
   */
  exportTrace(taskId: string): TaskTrace {
    const messages = this.listByTask(taskId).sort(
      (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
    );
    const participants = new Set<string>();
    const kindCounts = Object.fromEntries(
      MESSAGE_KINDS.map((k) => [k, 0]),
    ) as Record<MessageKind, number>;
    for (const m of messages) {
      participants.add(m.from);
      participants.add(m.to);
      kindCounts[m.payload.kind] += 1;
    }
    return {
      taskId,
      exportedAt: this.clock.now(),
      messageCount: messages.length,
      participants: [...participants].sort(),
      kindCounts,
      messages,
    };
  }

  /** Total messages stored across all tasks. */
  size(): number {
    return this.messages.length;
  }

  private validate(input: PostInput): void {
    if (isBlank(input.taskId)) {
      throw new CommsError('MISSING_TASK_ID', 'taskId is required');
    }
    if (isBlank(input.from)) {
      throw new CommsError('MISSING_SENDER', 'from is required');
    }
    if (isBlank(input.to)) {
      throw new CommsError('MISSING_RECIPIENT', 'to is required');
    }
    const payload = input.payload as unknown;
    if (typeof payload !== 'object' || payload === null) {
      throw new CommsError('EMPTY_PAYLOAD', 'payload must be a non-null object');
    }
    const keys = Object.keys(payload);
    if (keys.length === 0 || (keys.length === 1 && keys[0] === 'kind')) {
      throw new CommsError('EMPTY_PAYLOAD', 'payload carries no content');
    }
    const kind = (payload as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !(MESSAGE_KINDS as readonly string[]).includes(kind)) {
      // No free-text/chat message type is allowed on this channel.
      throw new CommsError(
        'UNKNOWN_KIND',
        `payload kind must be one of [${MESSAGE_KINDS.join(', ')}]; free-text chat messages are not allowed`,
      );
    }
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxPayloadBytes) {
      throw new CommsError(
        'PAYLOAD_TOO_LARGE',
        `payload exceeds ${this.maxPayloadBytes} bytes`,
      );
    }
  }
}
