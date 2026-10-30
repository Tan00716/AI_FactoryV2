/**
 * Webhook endpoint persistence + delivery/dedup rings (R7-#5).
 *
 * Endpoints live in `<AI_FACTORY_DATA_DIR|data>/webhooks.json`
 * (same server-data pattern as quota's budgets.json): version-stamped,
 * atomic tmp+rename write, and fail-closed on corrupt JSON — a corrupt
 * file is never silently overwritten, the operator renames it away.
 *
 * Delivery + dedup rings are process-local (like watch triggers):
 * a restart clears delivery history and the event-id dedup set. The
 * signature + 5-minute window still bound replay across restarts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  MAX_DELIVERIES,
  MAX_ENDPOINTS,
  type WebhookConfigFile,
  type WebhookDelivery,
  type WebhookEndpoint,
} from './types';

export class WebhookStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookStoreError';
  }
}

export function webhooksFilePath(): string {
  const dir = process.env['AI_FACTORY_DATA_DIR'] ?? 'data';
  return resolve(dir, 'webhooks.json');
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

/**
 * Validate operator-supplied endpoint input. Returns errors (empty =
 * valid). The HMAC secret is deliberately NOT an endpoint field — it
 * comes from the environment (see types.ts), so it can never be
 * persisted in webhooks.json or echoed in a list response.
 */
export function validateEndpointInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(input)) return ['endpoint must be an object'];
  if (!nonEmptyString(input['id'], 64) || !ID_RE.test(input['id'] as string)) {
    errors.push('id must match ^[a-z0-9][a-z0-9_-]{0,63}$');
  }
  if (!nonEmptyString(input['name'], 200)) errors.push('name must be a non-empty string (max 200)');
  if (!nonEmptyString(input['eventType'], 100)) errors.push('eventType must be a non-empty string (max 100)');
  if (!nonEmptyString(input['chainLabel'], 200)) errors.push('chainLabel must be a non-empty string (max 200)');
  if (!nonEmptyString(input['root'], 4096)) errors.push('root must be a non-empty string');
  if (!nonEmptyString(input['projectId'], 200)) errors.push('projectId must be a non-empty string (max 200)');
  if (input['enabled'] !== undefined && typeof input['enabled'] !== 'boolean') {
    errors.push('enabled must be a boolean');
  }
  return errors;
}

/** Normalize validated input into a stored endpoint (secret never stored). */
export function toEndpoint(input: Record<string, unknown>, createdAt: number): WebhookEndpoint {
  return {
    id: input['id'] as string,
    name: (input['name'] as string).trim(),
    eventType: (input['eventType'] as string).trim(),
    chainLabel: (input['chainLabel'] as string).trim(),
    root: input['root'] as string,
    projectId: input['projectId'] as string,
    enabled: input['enabled'] === undefined ? true : (input['enabled'] as boolean),
    createdAt,
  };
}

/** Load endpoints; missing file = empty list; corrupt file = throw. */
export function loadEndpoints(filePath: string = webhooksFilePath()): WebhookEndpoint[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new WebhookStoreError(`cannot read webhooks file: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new WebhookStoreError('webhooks.json is corrupt JSON; refusing to overwrite it (rename it away explicitly)');
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['endpoints'])) {
    throw new WebhookStoreError('webhooks.json has an unknown shape; refusing to overwrite it (rename it away explicitly)');
  }
  const endpoints: WebhookEndpoint[] = [];
  for (const e of parsed['endpoints'] as unknown[]) {
    if (!isRecord(e)) throw new WebhookStoreError('webhooks.json contains a non-object endpoint');
    const errors = validateEndpointInput(e);
    if (errors.length > 0) {
      throw new WebhookStoreError(`webhooks.json contains an invalid endpoint: ${errors.join('; ')}`);
    }
    endpoints.push(toEndpoint(e, typeof e['createdAt'] === 'number' ? e['createdAt'] : Date.now()));
  }
  return endpoints;
}

/** Atomic save (tmp + rename). Throws WebhookStoreError on failure. */
export function saveEndpoints(endpoints: WebhookEndpoint[], filePath: string = webhooksFilePath()): void {
  if (endpoints.length > MAX_ENDPOINTS) {
    throw new WebhookStoreError(`at most ${MAX_ENDPOINTS} endpoints`);
  }
  const file: WebhookConfigFile = { version: 1, endpoints };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
  } catch (e) {
    throw new WebhookStoreError(`cannot write webhooks file: ${(e as Error).message}`);
  }
}

/** Process-local delivery history, newest first, capped. */
export class DeliveryRing {
  private readonly items: WebhookDelivery[] = [];

  record(d: Omit<WebhookDelivery, 'id'>): WebhookDelivery {
    const full: WebhookDelivery = { ...d, id: randomUUID() };
    this.items.unshift(full);
    while (this.items.length > MAX_DELIVERIES) this.items.pop();
    return full;
  }

  list(): WebhookDelivery[] {
    return [...this.items];
  }
}

/**
 * Process-local event-id dedup set: (endpointId, eventId) pairs.
 * A repeated eventId for the same endpoint is a duplicate, not a
 * second run — even with a fresh nonce and signature.
 */
export class DedupRing {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly cap: number;

  constructor(cap = 1000) {
    this.cap = cap;
  }

  /** True when this (endpoint, event) was already seen. */
  has(endpointId: string, eventId: string): boolean {
    return this.seen.has(`${endpointId}\n${eventId}`);
  }

  remember(endpointId: string, eventId: string): void {
    const key = `${endpointId}\n${eventId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.cap) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

/** Deterministic fallback event id when the sender supplies none. */
export function fallbackEventId(rawBody: string): string {
  return `sha256:${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`;
}
