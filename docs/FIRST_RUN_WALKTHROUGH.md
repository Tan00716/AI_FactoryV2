# First-Run Walkthrough — verified 2026-10-12 (Batch 11-1)

An end-to-end check of the new-user story: a fresh server over a fresh
SQLite file, driven **only through the HTTP API**, no developer
intervention. Automated as
`apps/server/tests/first-run-walkthrough.test.ts` (run it with
`npm run demo:e2e`; requires a prior root `npm run build`). Three boots
of the real compiled server share one temp DB file. Test body ≈1.3s,
full invocation ≈6.5s, three consecutive runs green; the server suite
stays 83/83.

## The script and what actually happened

| # | Step (HTTP only) | Result |
|---|---|---|
| 1 | `GET /api/health` | 200; `stepIntents` and `operations` sections present, both `store: "sqlite"`, zero leftovers on a fresh DB |
| 2 | `POST /api/projects`, `POST /api/agents`, `POST /api/tasks` | 201s; task starts `TODO` |
| 3 | `POST /api/requirements` (REQ-001 v1) → `POST /api/tasks/:id/evidence` (`plan`, `requirementId` + `requirementVersion: 1`) → v2-transition to `PLANNING` pinning `REQ-001@1` | Evidence row records the pin `REQ-001@1`; transition 200 |
| 4 | `POST /api/requirements/REQ-001/versions` (`CORRECTION`, rationale patch) → v2-transition to `IN_PROGRESS` pinning `REQ-001@2` → `POST /api/requirements/REQ-001/compatibility` → retry | First attempt **422 `STALE_EVIDENCE`**, DB untouched; after the explicit compatibility declaration the retry is **200** — the Batch 7/8 chain works over real HTTP |
| 5 | `POST /api/approvals` (deploy to production, HIGH, task-bound) → `POST /api/approvals/:id/decision` (`approved`, `decided_by: human`) | `PENDING` → `APPROVED`; the decision auto-attaches `approval` evidence with `payload.verdict = APPROVED` (it later satisfies the `PENDING_PROD` gate) |
| 6 | Restart with `FACTORY_RUNTIME_TOOLS=echo` → `POST /api/runtime/runs` (script whose first step calls `echo`) → poll run | Run `COMPLETED`; `tool_result` evidence for `echo` with `ok: true`; after shutdown the intent is readable from the DB file as `EXECUTED` with a result hash |
| 7 | Stage walk `IN_PROGRESS → … → OUTCOME_VERIFICATION` (evidence + attestations per gate) → `DONE` → `GET /api/projects/:id/final-report` | All v2 gates pass, incl. review independence (human acceptor ≠ implementer) and the approval gate. DONE itself needs a detour — see F1. Final report matches the script's own bookkeeping exactly: tasks 1 (DONE 1, open 0), evidence 11 (sealed 1, with requirement pin 1), approvals 1 (approved 1), **AOCR 100%** (1/1), `contentHash` present (sha256) |
| 8 | Plain restart, same DB file | Project/task/evidence all present, task still `DONE`, plan pin and the smoke test's `SEALED` status intact; final-report counts identical; audit contains `STARTUP_INTERRUPTED_INTENTS`, `STARTUP_OPERATION_RECONCILE`, `FINAL_REPORT_GENERATED`; the §32 audit hash chain verifies (`AuditLog.verify()` → `ok`) over the file after all three boots |

## Findings (by severity)

**F1 — High: the v2 lifecycle cannot be completed over HTTP.**
`POST /api/tasks/:id/v2-transition` to `DONE` is refused by design —
the engine requires `finalize()` (§20.1: completion predicates +
`final_seal` commit atomically) — but no HTTP route exposes `finalize`
or the `REQUEST_COMPLETE` intent. An API-only user dead-ends one step
before DONE. The working path is the v1 endpoint
`POST /api/tasks/:id/transition` (the Board's engine), which this
walkthrough used. Costs of the detour: no completion-predicate check,
`final_seal` stays 0, and within the same process the v2 mirror keeps
showing `OUTCOME_VERIFICATION` while the DB says `DONE` (a restart
re-seeds the mirror from the DB and the views agree again).
*Fix direction: expose a finalize route on the v2 service that takes a
completion snapshot assembled from server-side facts.*

**F2 — Medium: requirements and §16 compatibility declarations are
process memory, not data.** The `RequirementManager` behind
`/api/requirements` is an in-memory singleton. After a restart the
requirement versions are gone: registering evidence with a pin then
400s ("unknown requirement version"), and a task caught mid-STALE-gate
across a restart can only proceed after an operator recreates the
requirement, its versions, and the compatibility declarations in the
new process. Evidence rows themselves (and their recorded pin strings)
are durable. This walkthrough keeps the requirement lifecycle inside
the first boot and registers step-7 evidence without pins.
*Fix direction: back the manager with the SQLite store, like every
other registry.*

**F3 — Medium: v2 transitions do not seal the evidence they consume.**
`WorkflowEngineV2` supports an `onSealEvidence` hook; the server's
`V2TransitionService` does not wire it. After the full v2 walk, the
final report shows `sealed: 1` of 11 — only the smoke test, sealed by
the v1 DONE hop. The other ten gate-consumed records stay `DRAFT`,
and DRAFT evidence remains mutable via `EvidenceEngine.update` — a
record a Gate already judged can still be edited after the fact,
which cuts against the §42 immutability story.
*Fix direction: wire `onSealEvidence` to `EvidenceEngine.seal` in the
service.*

**F4 — Low: run records are process memory.** `GET
/api/runtime/runs/:id` reads a module-level `Map`; after a restart the
run record is gone (404), even though its step intents and tool
evidence side effects are durable in SQLite. A user who restarts
cannot retrieve a past run's record.

**F5 — Low (by design, worth knowing): the final-report `contentHash`
covers `generatedAt`.** It identifies one generated instance, not the
content, so it legitimately differs on every generation — including
across the step-8 restart, where all counts reproduce exactly but the
hash does not. Compare counts, not hashes, when checking report
reproducibility.

## Not covered by this walkthrough

- The token-on configuration (`FACTORY_API_TOKEN` set): the script
  runs unauthenticated loopback, matching the other server e2e tests;
  the token gate itself is covered by `auth.test.ts`.
- The desktop UI: this is an API-level walkthrough only.
- A real-model run: HTTP runs use the scripted StubAdapter by design;
  the Codex live loop remains pending the postponed device login.
