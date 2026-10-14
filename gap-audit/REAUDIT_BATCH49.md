# Independent re-audit — Batch 49 (baseline `e86b75d`)

Isolated worktree (detached HEAD `e86b75d`, `node_modules` symlinked to main tree, built in the worktree itself). Main tree untouched throughout; worktree removed after.

## Verdict: 0 deviations

All four substantive Batch 49 claims hold. No exaggeration or fabrication found.

## (a) F14 run-budget overrides — HOLDS

- Read the full diff of `apps/server/src/routes/runtime.ts`: `resolveRunLoopBudgets()` fail-closed — non-object/array → 400 `INVALID_BUDGETS`; unknown key → 400 (explicitly calls out the `maxsteps` typo trap); non-positive-integer values → 400. Defaults (`RUN_LOOP_BUDGETS`) untouched when `budgets` absent.
- 400 happens before any run record is created: resolution at ~line 1909 (POST /runs) precedes `runStore.put` at 2034; resolution at ~1686 (resume) precedes `runStore.put` at 1813. In the resume handler, budgets validation also precedes the 404 — as the test claims.
- Manifest honesty: both manifest construction sites (`createResumedRunManifest` and POST /runs handler) snapshot `budgetLimits.loop` from the same resolved `loopBudgets` value that is threaded to `AgentLoop` via `ExecuteRuntimeRunDeps.budgets` — no-drift (Batch-15 invariant, now per-request).
- Default behavior unchanged: `deps.budgets ?? { ...RUN_LOOP_BUDGETS }`.
- Ran `apps/server/tests/runtime-run-budgets.test.ts`: **11/11**, 0 fail (resolver unit 7 + HTTP positive path/manifest/400/default/resume 4).

## (b) Builtin tool pre-registration — HOLDS

- Diff of `apps/server/src/routes/tools.ts` is 10 lines: `registerBuiltinTools(new ToolRegistry())` at boot. Metadata only — `createImplementationGate` untouched, server runner wiring untouched, executor capability/approval checks untouched.
- No existing test touches `/api/tools` with its own registry (matrix tests use own registries), so no regression by construction; full suite numbers come from the batch closeout.
- Ran `apps/server/tests/tools-builtin-preregister.test.ts`: **1/1** — 16 builtins listed, `runtime.echo` executes unregistered, `fs.read` still DENIED/UNSUPPORTED_CAPABILITY.

## (c) Desktop honesty fixes — HOLDS

- Verified desktop type shapes field-by-field against the server source: `ProjectFilesRestoreResult` matches `apps/server/src/routes/backup.ts` `ProjectFilesRestoreResult` exactly (`ok` added, which the server returns as `{ ok: true, ...result }`); `BackupSummary.scope`/`projectFiles` matches the `GET /api/backups` list-item shape (including `projectFiles.projects[].skipped` as a count — consistent with server mapping `skipped: pr.skipped.length`).
- Old false claim removed: BackupPanel no longer says backup is DB-only; rewritten copy matches Batch-45 semantics (project files + `.ai/`, symlinks not followed, exclusions, size limits).
- Restore confirmation UI states the three facts honestly: immediate effect (not staged), `preRestoreDir` rollback point, 422 leaves the live tree untouched.
- needs-human coverage gap documented in `api.ts` comment (no fake UI). No inconsistencies found.

## (d) Redaction walkthrough leg — HOLDS

- Read `apps/server/tests/first-run-walkthrough-redaction.test.ts` (~330 lines): real server + real pty, hermetic (temp DB + temp `FACTORY_SECRETS_DIR`), dual-mode compliant (node builtins + fetch only, zero src imports). Deterministic cross-chunk via `printf '%s' "${VAR:0:12}"; sleep 0.7; printf '%s' "${VAR:12}"` — two pty data events, not timing luck.
- Ran it: **1/1**, 0 fail. Doc section "Walkthrough: redaction leg (Batch 49)" + F26–F27 in place.

## (e) "Deliberately not done" 6 items — ARGUMENTS STAND

Spot-checked against code:
- `db.query` tool DENY: `packages/tools/src/builtins.ts` says "db.query stays definition-only until a host registers…"; `apps/server/src/routes/db.ts` header says "The tool contract and this HTTP surface are separate on purpose."
- `mcp.call` definition-only: documented in `builtins.ts` taxonomy rationale.
- Reconcile report-only: `STARTUP_INTERRUPTED_INTENTS`/`STARTUP_OPERATION_RECONCILE` are classification/report events; disposition stays with the upper layer.
- Board v1: `v2-transitions.ts` exists; the claim is a documented product-gap decision (UI gate inputs needed), not a code-state claim.
- F20: documented product rule.
- env-error HTTP positive path: stance from Batch 44/45 unchanged; not manufacturing reachability is the honest position.

## Environment note (non-product)

First worktree build failed transiently (`grep -c "error TS"` > 0), re-run completed with 0 errors — same flakiness pattern as earlier re-audits (service restart mid-build). Not a product defect.
