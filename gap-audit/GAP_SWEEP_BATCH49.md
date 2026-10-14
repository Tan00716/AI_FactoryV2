# Gap sweep — Batch 49 (2026-10-14)

Zero product-code changes in the audit itself; the two fixes below are the
batch's product work, each read-first and test-pinned. Baseline `52b8413`.

## (a) Open-gap inventory, sorted by sellability impact

Read from `docs/KNOWN_LIMITATIONS.md` (full), `docs/FIRST_RUN_WALKTHROUGH.md`
(F1–F25), `gap-audit/SELLABLE_REVERIFY_BATCH46.md` and
`gap-audit/SPEC_COVERAGE_BATCH31.md`.

### Hard-blocked (Tan / environment — no code-side path)

1. Codex device login → true turn E2E (Tan postponed 2026-10-12).
2. Non-Codex model adapters still stub (needs providers).
3. Windows/macOS packages + code signing (needs machines + Tan cert purchase).
4. Desktop true human click-through acceptance (needs human).
5. License / pricing / distribution channel (Tan decision).
6. GitHub CI `workflow` scope (Tan).
7. MCP SSE/HTTP/OAuth transports (environment).
8. No real isolation Host (infra).
9. Production attestation signing keys (Tan key decision).
10. Windows tool probing (Windows machine).
11. Remote DB driver / merge-queue multi-machine M2 (infra + Tan decision).
12. No test-prod environment (canary/gray/fault-injection/24h soak).
13. AT-001–AT-064 formal acceptance (process).

### Open, code-side, deliberately NOT done (with reason)

- **Board still on v1 engine.** An honest migration needs the Board to
  supply v2 gate inputs: every v2 edge requires `requirement-pinned`
  (the route falls back to the seeded pin, so that one is satisfiable),
  but `PLANNING→IN_PROGRESS` needs `budgetOk`, `IN_PROGRESS→CODE_REVIEW`
  needs candidate-digest/confinement/lease attestations, and several
  edges need evidence — all fail-closed without caller input. A hard
  cut would be "always fall back to v1" fake wiring (the documented
  reason). Real fix = Board UI collects gate inputs; needs UI design +
  human click verification. Out of scope for this batch.
- **`db.query` tool stays DENY.** Deliberate layering: the tool contract
  and the HTTP broker surface are separate on purpose
  (`apps/server/src/routes/db.ts` header, Batch 29). Not a gap.
- **`mcp.call` definition-only.** Deliberate: "MCP tools arrive via
  registered MCP servers (§34), not as factory builtins; this definition
  only fixes the category in the taxonomy" (`packages/tools/src/builtins.ts`).
- **Startup reconcile is report-only** (`STARTUP_INTERRUPTED_INTENTS`,
  `STARTUP_OPERATION_RECONCILE`). Deliberate: disposition stays with the
  upper layer; auto-recovery would be a product decision with blast radius.
- **F20** (brute-force counter cleared by successful loopback auth) is a
  documented product rule working as designed, not a bug.
- **env-error HTTP positive path** still does not exist. Deliberately not
  manufactured: the Batch-44/45 stance stands — no registered server tool
  throws env errors, and adding a tool whose purpose is to make the
  trigger fire would be manufacturing reachability.

### Open, code-side, FIXED this batch (the two picks)

**Pick 1 — F14 (Medium): `budget-exceeded` had no deterministic HTTP trigger.**
The default stepFn completes at the first EVALUATE (~6 phases), so the
fixed 40-step budget was unreachable over HTTP. Fix:
`POST /api/runtime/runs` and `POST /api/runtime/runs/:id/resume` accept
an optional `budgets` object (`{ maxSteps?, timeMs?, maxRetries? }`),
resolved per-request by the exported `resolveRunLoopBudgets()` and
threaded to both the `AgentLoop` and the manifest's `budgetLimits.loop`
snapshot (the Batch-15 no-drift invariant, now per-request).
Validation is fail-closed → 400 `INVALID_BUDGETS` (non-object, unknown
key — a likely typo like `maxsteps` is never silently ignored,
non-positive-integer). With `budgets: { maxSteps: 3 }` the caller sets a
real enforced limit and the run genuinely exceeds it → `BUDGET_EXCEEDED`
→ 'budget-exceeded' emission over pure HTTP: the first deterministic
HTTP trigger for this §81 reason. No default behavior change (operator-
gated route; defaults still `RUN_LOOP_BUDGETS`).
Pinned by `apps/server/tests/runtime-run-budgets.test.ts` (11/11).

**Pick 2 — builtin tool definitions pre-registered at server boot (small).**
`GET /api/tools` returned `[]` until an operator hand-registered all 16
definitions via `POST /api/tools/register`, even though the server ships
the catalog (`createBuiltinToolRegistry()`). Fix: the tools route now
boots with `registerBuiltinTools(new ToolRegistry())` — metadata only;
execution still flows through the implementation gate (definition-only →
DENIED), the server runner and capability checks, so "not implemented"
can never become a fake success. No existing test touched `/api/tools`
(the matrix test uses its own registries), so no regressions by
construction; verified by the suite below.
Pinned by `apps/server/tests/tools-builtin-preregister.test.ts` (1/1).

## Verification (this batch's work, main tree)

- Server package `tsc`: 0 errors.
- Root `npm run build`: 0 `error TS`.
- `apps/server/tests/runtime-run-budgets.test.ts`: 11/11.
- `apps/server/tests/tools-builtin-preregister.test.ts`: 1/1.
- Full main-line verification (npm test / server suite / desktop tsc /
  smoke:boot) left to the batch closeout on the settled tree.

## Files changed (uncommitted)

- `apps/server/src/routes/runtime.ts` — `resolveRunLoopBudgets()`,
  `RunLoopBudgets`, `ExecuteRuntimeRunDeps.budgets`, both manifest sites,
  both route handlers, header doc.
- `apps/server/src/routes/tools.ts` — pre-register builtins.
- `apps/server/tests/runtime-run-budgets.test.ts` — new (11).
- `apps/server/tests/tools-builtin-preregister.test.ts` — new (1).
- `docs/FIRST_RUN_WALKTHROUGH.md` — F14 rewritten as closed (Batch 49).
