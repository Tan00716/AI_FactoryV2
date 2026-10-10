# @ai-factory/model-router

Provider-independent model router — spec **§30 (Model Router)**, with provider
profiles from **§28 (Codex Integration)** and plan-usage rules from
**§29 (ChatGPT Plan Usage)**.

## What it does

`route(request)` maps a task to a routing decision:

```ts
{ primary: ModelRef, fallback: ModelRef, emergency: ModelRef, reason: string }
```

Deterministic rules (see `src/router.ts`):

1. **Hard constraints** filter the catalog first: `privacy: 'sensitive'` → local
   models only; `needsVision` → vision-capable only; `requiredTools` →
   tool-capable only; `contextNeeded` → context window large enough.
2. **Shared-pool exhaustion (§29)** — if `currentUsage.usedPct >= 100`, the
   primary is chosen from local models whenever one is eligible.
3. Remaining candidates are **scored** (task-type fit, reasoning need,
   complexity, latency/cost prefs); stable sort keeps ties deterministic.
4. `fallback` = next-best; `emergency` = `local-private` when eligible,
   else `fast-classifier`, else last resort. `reason` records every rule that
   fired.

Seed catalog (`src/catalog.ts`): `fast-classifier`, `code-coder`,
`reasoning-architect`, `vision-capable`, `local-private`.

## §29 — the shared 5h pool (please read)

For ChatGPT Plus/Pro plan usage, OpenAI documents a **single shared five-hour
usage limit across participating apps using the ChatGPT plan**. Creating more
agents does **not** multiply the allowance — ten agents do not get ten pools.

Consequences enforced in this package:

- `getAccountStatus()` (stub, `src/profile.ts`) returns the §29 shape the UI
  must display: connected account, plan, usage status, reset info, auth status.
- The router reads `RouteRequest.currentUsage.usedPct` and prefers
  local/fallback models when the pool is exhausted, instead of pretending each
  AI Employee has its own allowance.

## §28 — provider profiles

`ProviderProfile.kind` is one of `chatgpt-oauth | api-key | local | other`.
The platform must never force the entire deployment onto an API key; the
router itself is provider-independent (see the runtime adapters in
`@ai-factory/runtime`).

## Build / test / demo

```bash
npx tsc -p tsconfig.json
node --test dist/tests/*.test.js
node dist/demo/router.demo.js
```
