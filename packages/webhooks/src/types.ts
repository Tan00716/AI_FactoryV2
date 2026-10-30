/**
 * Webhook endpoint + delivery types (R7-#5).
 *
 * v1 scope, stated plainly:
 * - ONE shared HMAC secret for all endpoints (env FACTORY_WEBHOOK_SECRET,
 *   or a file named by FACTORY_WEBHOOK_SECRET_FILE, mirroring the API
 *   token pattern in auth.ts). Per-sender secrets are a later item: a
 *   per-endpoint secret would force endpoint lookup before signature
 *   verification, letting an unauthenticated caller probe which event
 *   types are configured (401 vs 404). The shared secret lets the
 *   receiver verify first and look up second.
 * - The event NEVER chooses the chain: each endpoint maps one event
 *   type to one operator-configured tasks.json chain label. The event
 *   payload is trigger-only — it is never passed to the chain as args,
 *   so a hostile sender cannot inject commands through an event.
 * - Local receiver only: no public exposure, no GitHub-app wiring.
 *   Putting this port on the public internet is an operator decision
 *   outside v1's scope (see README).
 */

/** Operator-configured mapping: one event type -> one task chain. */
export interface WebhookEndpoint {
  /** Slug, unique across endpoints. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Event type matched exactly against the incoming event field. */
  eventType: string;
  /** tasks.json chain label to run (operator allowlist, not sender input). */
  chainLabel: string;
  /** Project root the chain runs in (jailed by the route at use). */
  root: string;
  /** Project id the chain run is recorded under. */
  projectId: string;
  enabled: boolean;
  createdAt: number;
}

export type DeliveryStatus =
  | 'triggered'
  | 'failed'
  | 'duplicate'
  | 'rejected';

/** One receiver outcome. Process-local ring; restart clears it. */
export interface WebhookDelivery {
  id: string;
  endpointId: string | null;
  eventType: string;
  eventId: string;
  receivedAt: number;
  status: DeliveryStatus;
  /** Rejection / failure reason code — never signature material. */
  reason?: string;
  chainOk?: boolean;
  chainError?: string;
}

/** On-disk shape of webhooks.json (version-stamped, atomic write). */
export interface WebhookConfigFile {
  version: 1;
  endpoints: WebhookEndpoint[];
}

/** Header names (lowercased; Node lowercases incoming headers). */
export const WEBHOOK_SIGNATURE_HEADER = 'x-ai-factory-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-ai-factory-timestamp';
export const WEBHOOK_NONCE_HEADER = 'x-ai-factory-nonce';
export const WEBHOOK_EVENT_HEADER = 'x-ai-factory-event';
export const WEBHOOK_EVENT_ID_HEADER = 'x-ai-factory-event-id';

/** Signature scheme: `sha256=<hex hmac>` over `${timestamp}.${nonce}.${rawBody}`. */
export const SIGNATURE_PREFIX = 'sha256=';

/** Timestamp freshness window, seconds. Older or further-future = stale. */
export const TIMESTAMP_WINDOW_SECONDS = 300;

/** Receiver body cap — larger bodies are 413, never buffered unbounded. */
export const MAX_BODY_BYTES = 1_048_576;

/** Delivery ring size (process-local). */
export const MAX_DELIVERIES = 100;

/** Nonce ring size (process-local, TTL = timestamp window). */
export const MAX_NONCES = 5000;

/** Endpoint count cap. */
export const MAX_ENDPOINTS = 64;
