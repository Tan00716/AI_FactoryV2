# @ai-factory/webhooks — signed webhook receiver (R7-#5)

External events (git push, heartbeat, external callbacks) trigger
operator-configured `tasks.json` chains through the same runner seam as
a manual `POST /api/tasks/run` — never a second execution channel.
This closes the sweep.yaml gap the round-7 audit found: sweep.yaml
mapped external events to tasks, but there was no receiver, so only
explicit operator actions or cron could ingest events.

## Receiver: POST /api/webhooks/receive

Authentication is HMAC, not the API token: external senders cannot
present a Bearer token, so `index.ts` dispatches this one path before
the API token gate. Every other `/api/webhooks/*` path goes through
the normal gate (GET → viewer, other methods → operator).

Sender contract:

- Headers: `X-AI-Factory-Signature: sha256=<hex>`,
  `X-AI-Factory-Timestamp` (unix seconds), `X-AI-Factory-Nonce`
  (unique per delivery), `X-AI-Factory-Event` (event type),
  optional `X-AI-Factory-Event-Id` (dedup key; defaults to the body
  SHA-256 hash).
- Signed string: `{timestamp}.{nonce}.{rawBody}`, HMAC-SHA256 under
  the shared secret. `signPayload` in `verify.ts` is the canonical
  implementation — senders and tests share it.
- Timestamp window: 5 minutes either way. Older or further-future
  timestamps are `stale-timestamp` (401).

Verification order (the security property):

1. Secret configured? No → 503, fail-closed, never open.
2. Timestamp parse + window (cheap, no secret needed).
3. HMAC, constant-time compare.
4. Nonce replay check — only after a valid signature, so a failed
   signature cannot burn a nonce (DoS shape).
5. Event-id dedup: a repeated event id for the same endpoint returns
   `duplicate` (200) and never re-runs the chain, even with a fresh
   nonce and signature.
6. Endpoint lookup: first enabled endpoint matching the event type
   wins (sweep's first-match-wins, deterministic).
7. Run the endpoint's chain via `runTaskChainByLabel`.

## The secret

One shared secret for all endpoints, from the environment:
`FACTORY_WEBHOOK_SECRET`, or a file named by
`FACTORY_WEBHOOK_SECRET_FILE` (mirroring `auth.ts`). It is never
stored in `webhooks.json`, never echoed in a response, never logged.
Per-sender secrets are deliberately NOT in v1: they would force
endpoint lookup before signature verification, letting an
unauthenticated caller probe which event types are configured
(401 vs 404).

## What the event cannot do

- Choose the chain. The endpoint's `chainLabel` is the allowlist;
  an event body carrying a `chainLabel` field is ignored (proven by
  the smoke script, step 7).
- Pass arguments. The payload is trigger-only and never reaches the
  chain as args — no command injection through events.
- Run anything but a `tasks.json` chain. There is no arbitrary
  command path.

## Management API (behind the API token gate)

- `GET /api/webhooks/endpoints` — list + `secretConfigured` flag.
- `POST /api/webhooks/endpoints` — create (409 on duplicate id).
- `PUT /api/webhooks/endpoints/:id` — replace (used by the panel's
  enable toggle).
- `DELETE /api/webhooks/endpoints/:id` — delete.
- `GET /api/webhooks/deliveries` — delivery ring (newest first).

Endpoints persist in `<AI_FACTORY_DATA_DIR|data>/webhooks.json`
(version-stamped, atomic tmp+rename, fail-closed on corrupt JSON).
Deliveries, dedup, and nonces are process-local rings: a restart
clears them. The signature + 5-minute window still bound replay
across restarts; only the dedup guarantee weakens (a replayed event
id after a restart would re-run — acceptable for a local receiver,
stated here, not hidden).

Audit actions: `WEBHOOK_ENDPOINT_CREATED/UPDATED/DELETED`,
`WEBHOOK_TRIGGERED`, `WEBHOOK_FAILED`, `WEBHOOK_REJECTED`
(reason code only, never signature material), `WEBHOOK_DUPLICATE`.

## Honest boundaries (also rendered in the UI)

- Local receiver only. No public exposure, no GitHub-app wiring.
  Exposing this port publicly is an operator networking decision.
- No fan-out: first enabled match wins; two endpoints on the same
  event type do not both fire.
- No payload passthrough (see above).
- Delivery history is not durable; cross-restart history lives in
  the audit chain, not in the deliveries ring.
- The desktop panel's enable toggle is a replace (PUT), not a
  dedicated endpoint — one less route to audit.
