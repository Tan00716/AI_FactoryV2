/**
 * Signed webhook receiver routes (round-7 task R7-#5) — the event-driven
 * complement to watch triggers (R6-S3) and the scheduler (R6-S5).
 *
 *   POST /api/webhooks/receive                 HMAC-signed external event
 *   GET  /api/webhooks/endpoints               list endpoints (management)
 *   POST /api/webhooks/endpoints               create endpoint (management)
 *   PUT  /api/webhooks/endpoints/:id           replace endpoint (management)
 *   DELETE /api/webhooks/endpoints/:id         delete endpoint (management)
 *   GET  /api/webhooks/deliveries              delivery history (management)
 *
 * Authentication split — read this before touching index.ts wiring:
 * - The RECEIVER authenticates by HMAC, not by API token: external
 *   senders cannot present a Bearer token, so index.ts dispatches
 *   POST /api/webhooks/receive BEFORE the API token gate. The handler
 *   verifies signature + timestamp window + nonce before any work,
 *   and audits every outcome. Every other /api/webhooks/* path goes
 *   through the normal gate (GET -> viewer, other methods -> operator
 *   by the default prefix rule — no auth.ts change needed).
 * - The HMAC secret is shared across endpoints and comes from the
 *   environment (FACTORY_WEBHOOK_SECRET, or a file named by
 *   FACTORY_WEBHOOK_SECRET_FILE, mirroring auth.ts). It is never
 *   stored in webhooks.json, never echoed in a response, never logged.
 *
 * Receiver pipeline (order is the security property):
 *   raw body (capped) -> JSON parse -> secret configured? -> timestamp
 *   window -> HMAC -> nonce replay (consumed only after a valid
 *   signature) -> event-id dedup -> endpoint lookup (first enabled
 *   match wins, like sweep's first-match-wins) -> run the endpoint's
 *   tasks.json chain through runTaskChainByLabel — the SAME runner seam
 *   as a manual POST /api/tasks/run, never a second execution channel.
 * The event payload is trigger-only: it never reaches the chain as
 * args, so a hostile sender cannot inject commands through an event.
 *
 * Persistence: endpoints in <AI_FACTORY_DATA_DIR|data>/webhooks.json
 * (atomic, fail-closed on corrupt). Deliveries + dedup + nonces are
 * process-local rings (restart clears them; the signature + window
 * still bound replay across restarts).
 *
 * Dual-mode: this module is imported straight from src by nothing —
 * its tests boot the real dist server — but it still follows the
 * setter-injection rule: the jail resolver and the chain runner are
 * injected from index.ts, and @ai-factory/webhooks is a real package
 * dependency. No src-relative value imports.
 *
 * Deliberately NOT in v1 (honest boundaries, rendered in the UI):
 *  - Per-sender secrets (would force endpoint lookup before signature
 *    verification, leaking which event types are configured).
 *  - Public exposure / GitHub-app wiring: v1 is a local receiver.
 *    Exposing this port publicly is an operator networking decision.
 *  - Event-payload-to-task-args passthrough (injection surface).
 *  - Fan-out to every matching endpoint: first enabled match wins.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  DedupRing,
  DeliveryRing,
  MAX_BODY_BYTES,
  MAX_ENDPOINTS,
  NonceRing,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_NONCE_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookStoreError,
  fallbackEventId,
  loadEndpoints,
  saveEndpoints,
  toEndpoint,
  validateEndpointInput,
  verifySignature,
  type WebhookEndpoint,
} from '@ai-factory/webhooks';
import type { RouteContext } from './context';
import type { ChainRunOutcome } from './tasks';

const PREFIX = '/api/webhooks';

class WebhookRouteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'WebhookRouteError';
    this.code = code;
    this.status = status;
  }
}

export interface WebhookDeps {
  /** Jail a requested project root (throws on escape). */
  resolveRoot: (root?: string) => string;
  /** Run a tasks.json chain (the shared runner seam). */
  runChain: (
    label: string,
    root: string,
    projectId: string,
    actor: string,
    ctx: RouteContext,
  ) => Promise<ChainRunOutcome>;
}

let deps: WebhookDeps | null = null;

/** Installed once by index.ts at boot. */
export function setWebhookDeps(d: WebhookDeps | null): void {
  deps = d;
}

function needDeps(): WebhookDeps {
  if (!deps) throw new WebhookRouteError('webhook service is not wired', 'not-wired', 500);
  return deps;
}

function resolveRoot(rawRoot?: string): string {
  const d = needDeps();
  try {
    return d.resolveRoot(rawRoot);
  } catch (e) {
    throw new WebhookRouteError((e as Error).message, 'bad-root', 403);
  }
}

const deliveries = new DeliveryRing();
const dedup = new DedupRing();
const nonces = new NonceRing();

/** Shared HMAC secret: env wins, else a file named by env (auth.ts pattern). */
export function webhookSecret(): string | null {
  const direct = (process.env['FACTORY_WEBHOOK_SECRET'] ?? '').trim();
  if (direct) return direct;
  const file = (process.env['FACTORY_WEBHOOK_SECRET_FILE'] ?? '').trim();
  if (!file) return null;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(new WebhookRouteError('body too large', 'body-too-large', 413));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function loadAll(): WebhookEndpoint[] {
  try {
    return loadEndpoints();
  } catch (e) {
    if (e instanceof WebhookStoreError) throw new WebhookRouteError(e.message, 'store-error', 500);
    throw e;
  }
}

function saveAll(endpoints: WebhookEndpoint[]): void {
  try {
    saveEndpoints(endpoints);
  } catch (e) {
    if (e instanceof WebhookStoreError) throw new WebhookRouteError(e.message, 'store-error', 500);
    throw e;
  }
}

export async function handleWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith(PREFIX)) return false;
  const rest = path.slice(PREFIX.length);

  try {
    // ---- receiver (HMAC auth; dispatched pre-gate by index.ts) ------
    if (rest === '/receive' && method === 'POST') {
      await handleReceiveWithRes(req, res, ctx);
      return true;
    }

    // ---- management (behind the API token gate) ----------------------
    if (rest === '/endpoints' && method === 'GET') {
      ctx.json(res, 200, { endpoints: loadAll(), secretConfigured: webhookSecret() !== null });
      return true;
    }

    if (rest === '/endpoints' && method === 'POST') {
      const body = await ctx.readBody(req);
      const errors = validateEndpointInput(body);
      if (errors.length > 0) {
        ctx.json(res, 400, { error: 'invalid endpoint', errors, code: 'invalid-endpoint' });
        return true;
      }
      const endpoints = loadAll();
      if (endpoints.length >= MAX_ENDPOINTS) {
        ctx.json(res, 400, { error: `at most ${MAX_ENDPOINTS} endpoints`, code: 'too-many-endpoints' });
        return true;
      }
      const endpoint = toEndpoint(body, Date.now());
      if (endpoints.some((e) => e.id === endpoint.id)) {
        ctx.json(res, 409, { error: `endpoint id already exists: ${endpoint.id}`, code: 'duplicate-id' });
        return true;
      }
      saveAll([...endpoints, endpoint]);
      ctx.audit.record('human', 'WEBHOOK_ENDPOINT_CREATED', 'webhook-endpoint', endpoint.id, {
        eventType: endpoint.eventType,
        chainLabel: endpoint.chainLabel,
      });
      ctx.json(res, 201, { endpoint });
      return true;
    }

    const endpointMatch = rest.match(/^\/endpoints\/([^/]+)$/);
    if (endpointMatch) {
      const endpointId = decodeURIComponent(endpointMatch[1]);
      if (method === 'PUT') {
        const body = await ctx.readBody(req);
        const errors = validateEndpointInput({ ...body, id: endpointId });
        if (errors.length > 0) {
          ctx.json(res, 400, { error: 'invalid endpoint', errors, code: 'invalid-endpoint' });
          return true;
        }
        const endpoints = loadAll();
        const idx = endpoints.findIndex((e) => e.id === endpointId);
        if (idx === -1) {
          ctx.json(res, 404, { error: `endpoint not found: ${endpointId}`, code: 'not-found' });
          return true;
        }
        const next = toEndpoint({ ...body, id: endpointId }, endpoints[idx].createdAt);
        endpoints[idx] = next;
        saveAll(endpoints);
        ctx.audit.record('human', 'WEBHOOK_ENDPOINT_UPDATED', 'webhook-endpoint', endpointId, {
          eventType: next.eventType,
          chainLabel: next.chainLabel,
        });
        ctx.json(res, 200, { endpoint: next });
        return true;
      }
      if (method === 'DELETE') {
        const endpoints = loadAll();
        const idx = endpoints.findIndex((e) => e.id === endpointId);
        if (idx === -1) {
          ctx.json(res, 404, { error: `endpoint not found: ${endpointId}`, code: 'not-found' });
          return true;
        }
        const [removed] = endpoints.splice(idx, 1);
        saveAll(endpoints);
        ctx.audit.record('human', 'WEBHOOK_ENDPOINT_DELETED', 'webhook-endpoint', endpointId, {
          eventType: removed.eventType,
        });
        ctx.json(res, 200, { deleted: endpointId });
        return true;
      }
    }

    if (rest === '/deliveries' && method === 'GET') {
      ctx.json(res, 200, { deliveries: deliveries.list() });
      return true;
    }

    return false;
  } catch (e) {
    if (e instanceof WebhookRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
}

/** Receiver: raw body + HMAC + replay + dedup + chain trigger. */
export async function handleReceiveWithRes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const d = needDeps();
  let raw: string;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    if (e instanceof WebhookRouteError) {
      ctx.audit.record('webhook', 'WEBHOOK_REJECTED', 'webhook', 'unknown', { reason: e.code });
      ctx.json(res, e.status, { error: e.message, code: e.code });
      return;
    }
    throw e;
  }

  let parsed: Record<string, unknown>;
  try {
    const v: unknown = raw ? JSON.parse(raw) : {};
    parsed = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  } catch {
    ctx.audit.record('webhook', 'WEBHOOK_REJECTED', 'webhook', 'unknown', { reason: 'invalid-json' });
    ctx.json(res, 400, { error: 'invalid JSON body', code: 'invalid-json' });
    return;
  }

  const header = (name: string): string | null => {
    const v = req.headers[name];
    return typeof v === 'string' ? v : null;
  };
  const eventType = header(WEBHOOK_EVENT_HEADER) ?? (typeof parsed['event'] === 'string' ? parsed['event'] : null);
  const eventId = header(WEBHOOK_EVENT_ID_HEADER)
    ?? (typeof parsed['eventId'] === 'string' ? parsed['eventId'] : null)
    ?? fallbackEventId(raw);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const reject = (status: number, reason: string, code: string): void => {
    ctx.audit.record('webhook', 'WEBHOOK_REJECTED', 'webhook', eventId, {
      reason,
      eventType: eventType ?? null,
    });
    deliveries.record({
      endpointId: null,
      eventType: eventType ?? '',
      eventId,
      receivedAt: Date.now(),
      status: 'rejected',
      reason,
    });
    ctx.json(res, status, { error: reason, code });
  };

  // Secret first: without one the receiver is fail-closed, not open.
  const secret = webhookSecret();
  if (!secret) {
    reject(503, 'webhook secret is not configured', 'secret-not-configured');
    return;
  }

  const signature = header(WEBHOOK_SIGNATURE_HEADER);
  const timestamp = header(WEBHOOK_TIMESTAMP_HEADER);
  const nonce = header(WEBHOOK_NONCE_HEADER);
  const verified = verifySignature(secret, signature, timestamp, nonce, raw, nowSeconds);
  if (!verified.ok) {
    const status = verified.reason === 'missing-secret' ? 503 : 401;
    reject(status, `signature verification failed: ${verified.reason}`, verified.reason);
    return;
  }
  // Replay check AFTER a valid signature: an invalid signature must not
  // burn the nonce, and a valid signature with a spent nonce is a replay.
  if (nonces.has(nonce as string, Date.now())) {
    reject(401, 'signature verification failed: replay-nonce', 'replay-nonce');
    return;
  }
  nonces.remember(nonce as string, Date.now());

  if (!eventType) {
    reject(400, 'missing event type', 'missing-event');
    return;
  }

  const endpoints = loadAll();
  const endpoint = endpoints.find((e) => e.enabled && e.eventType === eventType);
  if (!endpoint) {
    reject(404, `no enabled endpoint for event type: ${eventType}`, 'no-endpoint');
    return;
  }

  if (dedup.has(endpoint.id, eventId)) {
    ctx.audit.record('webhook', 'WEBHOOK_DUPLICATE', 'webhook-endpoint', endpoint.id, {
      eventType,
      eventId,
    });
    deliveries.record({
      endpointId: endpoint.id,
      eventType,
      eventId,
      receivedAt: Date.now(),
      status: 'duplicate',
      reason: 'duplicate-event',
    });
    ctx.json(res, 200, { status: 'duplicate', endpointId: endpoint.id, eventId });
    return;
  }
  dedup.remember(endpoint.id, eventId);

  let root: string;
  try {
    root = resolveRoot(endpoint.root);
  } catch (e) {
    const msg = (e as Error).message;
    ctx.audit.record('webhook', 'WEBHOOK_FAILED', 'webhook-endpoint', endpoint.id, {
      eventType,
      eventId,
      error: msg,
    });
    deliveries.record({
      endpointId: endpoint.id,
      eventType,
      eventId,
      receivedAt: Date.now(),
      status: 'failed',
      reason: 'bad-root',
      chainError: msg,
    });
    ctx.json(res, 500, { error: msg, code: 'bad-root' });
    return;
  }

  const outcome = await d.runChain(endpoint.chainLabel, root, endpoint.projectId, 'webhook', ctx);
  if (outcome.ok) {
    ctx.audit.record('webhook', 'WEBHOOK_TRIGGERED', 'webhook-endpoint', endpoint.id, {
      eventType,
      eventId,
      chainLabel: endpoint.chainLabel,
    });
    deliveries.record({
      endpointId: endpoint.id,
      eventType,
      eventId,
      receivedAt: Date.now(),
      status: 'triggered',
      chainOk: true,
    });
    ctx.json(res, 200, { status: 'triggered', endpointId: endpoint.id, eventId, chainLabel: endpoint.chainLabel });
  } else {
    ctx.audit.record('webhook', 'WEBHOOK_FAILED', 'webhook-endpoint', endpoint.id, {
      eventType,
      eventId,
      chainLabel: endpoint.chainLabel,
      error: outcome.error,
    });
    deliveries.record({
      endpointId: endpoint.id,
      eventType,
      eventId,
      receivedAt: Date.now(),
      status: 'failed',
      reason: outcome.code,
      chainOk: false,
      chainError: outcome.error,
    });
    ctx.json(res, 200, { status: 'failed', endpointId: endpoint.id, eventId, chainLabel: endpoint.chainLabel, error: outcome.error, code: outcome.code });
  }
}
