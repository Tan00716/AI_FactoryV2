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

---

# Second edition — new capability chains (Batch 21-4, verified 2026-10-13)

The Batch 11 walkthrough above only exercised the core v2 loop. This
second walkthrough re-runs the new-user story on the Batch 20 tree
(`6eadd28`), covering the chains that landed in B12–B20. Automated as
`apps/server/tests/first-run-walkthrough-b21.test.ts`, run with
`npm run demo:e2e-new` (requires a full workspace `npm run build`
first — see F6). Two boots of the real compiled server share one
temp SQLite file with a SIGKILL between them. Three consecutive runs
green (~6.4s each); the Batch 11 script still passes unchanged on the
same tree.

## The script and what actually happened

| # | Step (HTTP only) | Result |
|---|---|---|
| W1 | `GET /api/health` | 200; `outbox` and `secrets` sections present |
| W2 | `POST /api/projects`, `/api/agents`, `POST /api/tasks` with `authorizationStatus: 'DRAFT'` | 201s; task starts `DRAFT` on the authorization axis |
| W3 | `POST /api/runtime/runs` on the DRAFT task | **403 `TASK_NOT_AUTHORIZED`**, zero run records created |
| W4 | `request-dispatch` → `dispatch` (`via: 'HUMAN'`) → same run request | `DRAFT → WAITING → AUTHORIZED`; run **202**, completes `COMPLETED` with a real `echo` `tool_result` |
| W4b | requirement v1 + plan evidence pinned `REQ-001@1` → `v2-transition` to `PLANNING` | 200 — a genuine v2 engine commit, which is what feeds the outbox |
| W5 | `GET /api/runtime/runs/:id/checkpoints[/latest]` | 200; checkpoints readable |
| W6 | `GET /api/tasks/:id/outbox` | 200; persisted events with `to: 'PLANNING'` (engine shape + `eventType` since Batch 22 — see F7) |
| W7 | `PUT /api/secrets/walksecret` → `GET` metadata → `POST /api/exec` with `secretEnv` | PUT/GET never carry the value; `printenv` output redacted (`***`), sentinel absent |
| W8 | `POST /api/terminal/sessions` → `POST :id/input` → `GET :id/stream` (SSE) → `DELETE` | 201; `echo w21-terminal` output streamed back over SSE (base64 frames); session closed |
| W9 | `POST /api/backup/schedules` (interval) → `POST :id/run` → `GET /api/backups` | 201; manual run produced a backup, listed |
| W10 | `POST /api/worktrees` (real temp git repo) → `GET` list → `POST :id/release` | 201; a real `git worktree` allocated, then released |
| W11 | `POST /api/mcp/register` (stdio, `credentialRefs: ['walksecret']`) → `GET :id/trust` → `POST :id/trust/approve` → `POST /api/mcp/install` → `POST /api/mcp/review` (approved) → `POST /api/mcp/launch` (`node -e`, `secretEnv`) → `GET launches/:id/logs` → `POST launches/:id/stop` | 201/200/200/202/200/**201**; install pends review by design (202), the review completes it, the launch injects the declared secret and the logs carry no value |
| W12 | `POST /api/pipelines` → `POST :id/deploy` (`PROD`) → approval decision | Deployment parks at `AWAITING_APPROVAL` with a real approval ticket; decision recorded |
| — | **SIGKILL**, same DB file | — |
| W13 | `GET /api/tasks/:id` | `authorizationStatus` still `AUTHORIZED` |
| W14 | `GET /api/tasks/:id/outbox` | events intact, same count as boot A |
| W15 | `POST /api/pipelines/:id/approve` (`approvalId`) | 200; deployment **SUCCEEDED** — rebuilt from the persisted spec |
| W16 | `GET /api/backup/schedules`, `GET /api/backups` | schedule and backup both listed |
| W17 | `GET /api/worktrees` | record persisted as `RELEASED` (archived, not deleted) |
| W18 | `GET /api/mcp/servers/:id/trust`, `GET /api/mcp/launches` | trust decision persisted; launch table honestly empty (process memory) |
| W19 | `GET /api/audit?limit=1000` + `AuditLog(fdb.audit).verify()` over the file | all expected actions present (`TASK_DISPATCH_REQUESTED/DISPATCHED`, `APPROVAL_REQUIRED`, `DEPLOYMENT_REHYDRATED`, `DEPLOY_RESUMED`, `DEPLOY_SUCCEEDED`, `BACKUP_SCHEDULE_CREATED`, `WORKTREE_ALLOCATED/RELEASED`, `MCP_SERVER_LAUNCH`, `SESSION_INPUT`, `SECRET_SET`); hash chain verifies |

No product-code changes were needed: every failure hit during
development of the script was a wrong assumption in the script
itself (response shapes, the install→review→launch ordering, the
trust-approve body fields). Findings below are F6+ in the Batch 11
tradition.

## Findings (second edition)

**F6 — Medium (build/test infrastructure, not product code).**
Partial workspace rebuilds can leave `dist/` inconsistent across
packages: rebuilding only `@ai-factory/server` produced a
`dist/mcp-persistence.js` calling `registry.setSink()` while
`packages/mcp/dist` predated the method — the real server then
crashed at boot with exit code 1 (`TypeError: registry.setSink is
not a function`). A full `npm run build` resolves it; the product
source is correct. The sharp edge is that root `npm test` never
executes the server suite (it runs package `dist` tests only), so
nothing in the standard gate catches a dist skew that breaks
`node dist/index.js`. *Fix direction: e2e scripts must always
full-build first (`demo:e2e-new` now builds mcp+db+worktrees+server);
consider a CI boot-smoke of the compiled server.*

**F7 — Low: the outbox read surface and the DB column speak
different vocabularies.** `GET /api/tasks/:id/outbox` returns the
engine's `OutboxEvent` shape (`{taskId, from, to, by, at, intent}`);
the `WORKFLOW_TRANSITIONED` / `WORKFLOW_FINALIZED` event types exist
only in the `outbox_events.event_type` column. An HTTP consumer
cannot see the durable event type the DB stores. Harmless today
(the engine shape carries the same facts), but the two surfaces
should agree if the outbox gains external consumers.

**F7 resolved (Batch 22).** `eventTypeOf` is now exported from
`packages/db` (the single source of the rule the column is written
with), and `V2TransitionService.outboxView` adds `eventType` to each
HTTP event — a deterministic projection of `intent`, not a second
stored fact, so the HTTP value and the DB column cannot drift.
Pinned by tests at both layers (`packages/db/tests/outbox.test.ts`
rule↔column agreement; `apps/server/tests/v2-outbox.test.ts` HTTP
shape including the `WORKFLOW_FINALIZED` finalize event).

---

# First-Run Walkthrough, third edition — verified 2026-10-13 (Batch 30-3)

Extends the second edition with the B21–B29 "data plane" chains: the
database broker (`/api/db/*`), build SBOM, SBOM retention, and MCP
launch persistence. Automated as
`apps/server/tests/first-run-walkthrough-b30.test.ts` (run with
`npm run demo:e2e-v3`; requires a prior root `npm run build`). Two boots
of the real compiled server (boot A → SIGKILL → boot B) share one temp
DB file, a temp build work root, a temp `FACTORY_SBOM_DIR`, and hermetic
`FACTORY_SECRETS_DIR`. 1/1 green on the first run; the failure chains
are walked, not described.

## The script and what actually happened

| # | Step (HTTP only) | Result |
|---|---|---|
| D1 | `GET /api/db/connections` | 200; `factory` registered at boot, `environment: dev`, `kind: sqlite` |
| D2 | `POST /api/db/query` (`factory`, `SELECT …`) before any policy | **403 `PRIVILEGE_DENIED`**, reason names the missing least-privilege policy — execution is opt-in, never open |
| D3 | `POST /api/db/connections` (`analytics`, staging, postgres) → `PUT …/policy` (`read`, `*`) → `POST /api/db/query` | **503 `NO_ENGINE`**, reason says the broker refuses to pretend — the refusal is about the engine, not privilege |
| D4 | `PUT /api/db/connections/factory/policy` (`read`, [`tasks`]) → whitelisted `SELECT` → named-param `SELECT :v AS v` → `SELECT` on `audit_logs` | 200 `OK` with real rows; param binds and returns; **403 `PRIVILEGE_DENIED`** off-whitelist |
| D5 | `POST /api/db/runbooks` (template `task-ids-by-title`, slot `title`) → `POST /api/db/runbooks/run` | 201, then 200 `OK` — broker executes the registered template text, never an interpolated string |
| B1 | project → task → `POST /api/git/pr` → `POST …/merge` on a real repo with a lockfile | build record `NOT_EXECUTED → SUCCEEDED` with a real 64-hex digest; `sbomRef` under `FACTORY_SBOM_DIR`, file really on disk, CycloneDX 1.5, contains `left-pad@1.3.0` / `@scope/right-pad@2.0.1`, and the `ai-factory:sbom:provenance` property stating declared-deps-only semantics |
| R1 | `POST /api/retention/evaluate` (no policy) → `PUT /api/retention/policies` (`sboms`: days 3650, keepCount 1000, deleteOrphans false) → evaluate again | 0 candidates both times; the live SBOM stays referenced and the file is still on disk after the dry run — **nothing was deleted, only evaluated** |
| M1 | `POST /api/mcp/register` → `…/trust/approve` (`HIGH`, `AUTO`) → `POST /api/mcp/install` → `POST /api/mcp/launch` (sleeper) | 201s; `GET /api/mcp/launches?history=true` shows the sleeper `RUNNING` |
| M2 | SIGKILL → boot B → `GET /api/mcp/launches`, `GET /api/mcp/launches?history=true`, `GET /api/mcp/servers/w30sleeper@1.0.0/trust` | live table honestly empty; sleeper `ORPHANED` with the "fate is unknown" note; trust decision still approved |
| B2 | build record re-read from the DB file | still `SUCCEEDED`; `sbomRef` file still on disk |
| A1 | `GET /api/audit?limit=2000` + `AuditLog(fdb.audit).verify()` over the file | actions present: `DB_CONNECTION_REGISTERED`, `DB_BROKER_DENIED`, `DB_BROKER_NO_ENGINE`, `DB_BROKER_EXECUTED`, `DB_RUNBOOK_REGISTERED`, `DB_RUNBOOK_EXECUTED`, `BUILD_SUCCEEDED`, `RETENTION_POLICY_UPDATED`, `MCP_SERVER_LAUNCH`; the bound-param sentinel appears **nowhere** in the audit dump; hash chain verifies |

## Findings (third edition)

**F8 — Low (already-known semantic, no product-code change needed).**
The retention `evaluate` report counts candidates per category, not
files — the `sboms` category aggregates the per-file candidacy into a
count with `sampleIds`. An operator auditing exactly *which* files are
at risk must also read the per-category evaluation detail. Same shape
as every other category; consistent, just not file-enumerating.

**F9 — Low (CLOSED in Batch 31).** The background build runner's
queue is FIFO and asynchronous: the walkthrough polled the DB file for
the build record rather than the HTTP surface, because there was no
`/api/builds` read route in the product. Batch 31 added the read-only
builds surface (`GET /api/builds` + `GET /api/builds/:id`, viewer-readable;
see `apps/server/tests/builds-read.test.ts`, which watches a real build
land over pure HTTP).

## Walkthrough (fourth edition, Batch 36)

`apps/server/tests/first-run-walkthrough-b36.test.ts` — the B31–B35
governance + persistence chains, real server, temp DB, one SIGKILL.
Run with `npm run demo:e2e-v4`.

| Chain | What is walked | What the run asserts |
|---|---|---|
| P1 | `POST /api/pipelines` (QUEUED, 12 stages) → honest mid-run row-shape write → SIGKILL → boot B → `GET /api/pipelines/:id`, `POST …/run` | in-flight pipeline **INTERRUPTED** (never RUNNING), in-flight stage INTERRUPTED, `/run` → 409 `PIPELINE_NOT_REHYDRATABLE` — the persisted record is a record, not an execution |
| B1 | merge on a real repo → poll `GET /api/builds?prId=` (pure HTTP) → `GET /api/builds/:id` | build lands `SUCCEEDED` over HTTP only, real 64-hex digest; the walkthrough F9 gap stays closed |
| A1 | `POST /api/authority/directives` (mgr-a BLOCK) → (mgr-b ALLOW) → `GET /api/authority/targets/task/:id` → resolve via manager → resolve via owner | equal-rank incompatible directives open `AUTHORITY_CONFLICT` (OPEN) and pause the target; **same-rank escalation is refused (400)**; a strictly-higher owner resolves and the pause lifts |
| D1 | `POST /api/workforce/employees` (covering taskScope) → (empty taskScope) | 201 within scope; 403 `grant-exceeds-task-scope` under an empty scope, and the refusal is audited as `TASK_SCOPE_CEILING_DENIED` |
| G1 | `POST /api/delegations` → `…/activate` (ACTIVE); `PUT /api/gates/definitions/…` → `POST …/evaluate`; `POST /api/workforce/proposals`; `POST /api/disputes` (no-evidence verdicts) | delegation ACTIVE; gate verdict **PASSED** with `evidence_source: caller-supplied`; proposal decision recorded (201); dispute **ESCALATED** with an escalation id |
| R1 | `POST /api/projects` (§6.1 fields) → `PUT /api/projects/:id/knowledge` → bad category | full record persisted (`organization_id`, `lifecycle_state`); knowledge upsert 200; unknown category → 400 |
| P1/G1/R1 (boot B) | re-read everything after the SIGKILL | delegation **INTERRUPTED** (mutation 409), gate definition + PASSED evaluation survive, proposal history + escalation survive, §6.1 record + knowledge entry survive |
| A2 | `GET /api/audit?limit=2000` + `AuditLog(fdb.audit).verify()` | actions present: `PIPELINE_REHYDRATED`, `BUILD_SUCCEEDED`, `AUTHORITY_DIRECTIVE_REGISTERED`, `AUTHORITY_CONFLICT_DETECTED`, `AUTHORITY_CONFLICT_HUMAN_RESOLVED`, `TASK_SCOPE_CEILING_DENIED`, `EMPLOYEE_CREATED`, `DELEGATION_CREATED`, `DELEGATION_INTERRUPTED_ON_RESTART`, `GATE_EVALUATED`, `SELF_MODIFICATION_PROPOSED`, `PROJECT_KNOWLEDGE_UPSERTED`; hash chain verifies |

## Findings (fourth edition)

**F10 — Low (test-harness note, same as the pipeline test header).**
The mid-run pipeline chain is not a pure-real kill: `/run`'s stage
handlers complete in milliseconds, so a true SIGKILL cannot land
mid-run over HTTP. The script writes exactly the row shape a mid-run
kill would leave (through the same table columns the server's own
write-through writes) and kills — the hydrate-and-demote logic is real,
the row shape is honestly labeled a simulation in the file header.
A pure-real QUEUED chain (create → kill → still QUEUED, `/run` 409s) is
also walked in the same script.

**F11 — Low (read-view note, no product-code change).**
While the process lives, `GET /api/pipelines/:id` prefers the live
in-memory record — a direct look at the DB file may show different
statuses than the HTTP surface. An operator watching a running
pipeline over HTTP always sees the live view; the persisted view only
becomes authoritative after a restart. This is the designed "live
records win on id clashes" convention, not drift.

**F12 — Low (honest boundary, no product-code change).**
The authority-conflict registry is in-memory (same as `/api/disputes`):
an OPEN conflict that survives a SIGKILL is lost. The walkthrough
resolves the conflict *before* the kill on purpose — an operator must
know that un-resolved conflicts do not survive a restart. The pause
state of an un-resolved conflict is the known §8.1 gap item.

**F13 — Info (walkthrough hygiene).**
The walkthrough's covering task scope was first written too narrow
(`permission:filesystem.read` only) and the real `Walk Engineer`
template requested six permissions — the server's 403 named exactly
which permissions exceeded the scope. The error is the documentation:
the scope contract is enforced, not approximated.

## Walkthrough (fifth edition, Batch 41)

`apps/server/tests/first-run-walkthrough-b41.test.ts` — the B37–B40
chains, real server, temp DB, in-process legs against the real compiled
packages (never mocks). Run with `npm run demo:e2e-v5`.
v4 (B31–B36) remains the authority for the governance chains; v5 covers
B37–B40 only.

| Chain | What is walked | What the run asserts |
|---|---|---|
| M1 | in-process: `StdioMcpConnector.launch` + `performHandshake` against the real `@modelcontextprotocol/server-filesystem` (via `MCP_TEST_REAL_SERVER` or npx) | real initialize → negotiated version ∈ `CLIENT_PROTOCOL_VERSIONS`, `tools/list` non-empty with `read_text_file`, `tools/call` returns the real probe file content. No server in this environment → LOUD diagnostic skip of this leg only (the walkthrough continues), never a faked handshake |
| S1 | `POST /api/projects` → task → `POST /api/git/pr` → `POST …/merge` → poll `GET /api/builds?prId=` → `GET /api/audit?limit=2000` | build lands `SUCCEEDED` with a real 64-hex §40 digest; the audit log shows `BUILD_SANDBOXED` (bwrap available) **or** `SANDBOX_UNAVAILABLE` (honest fallback) — environment-adaptive |
| A1 | `GET /api/builds/:id` → read `attestationRef` file → `verifyDevAttestation`; in-process `attestationKeyFromEnv({})` | attestation verifies; subject digest == the build's real §40 digest; predicate plaintext `devOnly: true`; no key → `attestationKeyFromEnv()` is null (honest absence, no second boot needed) |
| T1 | `POST /api/agents` → `POST /api/runtime/runs` (unknown-tool script) → `GET /api/needs-human?status=open`; `POST /api/pipelines` → `POST …/deploy` (PROD, no risk signals) → `GET /api/needs-human?status=open` | repeated-failure: run `ESCALATED`, upgrade `reason: 'repeated-failure'`, `recipient: null`, `requiredDeciderLevel: 'operator'`, `contextJson.reasonCode == 'LOOP_STAGNATION'` (machine code, not message). high-risk-deployment: PROD parks on approval, ticket `risk_level == 'HIGH'` (assessed, not hardcoded), upgrade `reason: 'high-risk-deployment'`, `recipient: null`, `requiredDeciderLevel: 'manager'`. budget-exceeded: honest skip (F14) |
| E1 | in-process: `runCommandPipe(['/nonexistent-binary-…'])`, `assertSandboxAvailable('/nonexistent/bwrap-…')` | `MissingBinaryError`, `code == 'ENV_BINARY_MISSING'`; `SandboxUnavailableError`, `code == 'ENV_SANDBOX_UNAVAILABLE'` — real throws, no mocks |

## Findings (fifth edition)

**F14 — Medium (honest gap in HTTP reach, no product-code change).**
`budget-exceeded` has no deterministic HTTP trigger: the runtime route's
default stepFn returns `COMPLETE` at the first `EVALUATE`, so every HTTP
run finishes in ~6 steps and can never reach `maxSteps: 40`. The emission
code path (`buildRunUpgradeRecord`/`emitRunNeedsHuman`) is real and
package-tested (`runner-reason-code.test.ts` 4/4); the walkthrough does
not fake a trigger. If a future route lets callers stretch runs (custom
step functions, pause/resume marathons), this leg should be re-walked.

**F15 — Low (environment, no product-code change).**
The M1 leg depends on reaching the npm registry (npx) or a local
`MCP_TEST_REAL_SERVER`. In this environment the registry TLS fails
(`_WRONG_VERSION_NUMBER` through the egress proxy), so the leg loud-skips
with a diagnostic and the walkthrough continues. The skip contract mirrors
`packages/mcp/tests/real-handshake.test.ts` (`serverNeverCameUp`); a live
server that answers wrongly would be a real failure, not a skip.

**F16 — Low (environment-adaptive assertion, no product-code change).**
The S1 sandbox assertion accepts either `BUILD_SANDBOXED` or
`SANDBOX_UNAVAILABLE` — availability is an environment property (bwrap
installed + functional), not a test promise. In this environment bwrap is
absent, so the honest fallback path is what the walkthrough exercises.

**F17 — Info (walkthrough hygiene).**
The attestation null path is pinned in-process (`attestationKeyFromEnv({})`
→ null) instead of booting a second server without the key. The contract
under test is the key-absent branch of the real function, not server
startup behavior.

**F18 — Info (edition scoping).**
v5 deliberately does not re-walk the B31–B36 governance chains (v4's
P1/B1/A1/D1/G1/R1/A2). Editions are cumulative across files, not
replacements — `demo:e2e-v4` remains the authority for those chains.

## Walkthrough (sixth edition, Batch 43)

`apps/server/tests/first-run-walkthrough-b43.test.ts` — the B41–B42
§81 chains, real server, temp DB, pure HTTP, zero mocks. Run with
`npm run demo:e2e-v6`. The server boots with `FACTORY_API_TOKENS` set
(the S1 leg needs real 401s); every leg call carries the admin token.
v4 remains the authority for the B31–B36 governance chains and v5 for
the B37–B40 chains; v6 covers B41–B42 only.

| Chain | What is walked | What the run asserts |
|---|---|---|
| P1 | `POST /api/workforce/employees` (empty `taskScope`) → 403 ×3 by one granter → `GET /api/needs-human?status=open`; a single denial by another granter first | single denial emits nothing; 3 denials → exactly one OPEN `policy-violation` (`source: 'policy-denial:<granter>'`, `recipient: null`, `requiredDeciderLevel: 'operator'`, `detailJson.granter`/`denialCount` correct). The honest-wording narrative is NOT in the persisted record — finding F19 |
| S1 | 1× wrong Bearer → 401 → read; then 10× wrong Bearer back-to-back → read | single 401 emits nothing; 10× → exactly one OPEN `security-issue` (`source` starts with `'auth-bruteforce:'`, `recipient: null`, `requiredDeciderLevel: 'admin'`, detail names the counted fact). Phase ordering matters — finding F20 |
| R1 | `PUT /api/secrets/:name` (metadata only) → 3× `POST /api/exec` (`printenv` + `secretEnv` injection) → `GET /api/audit?limit=2000` → `GET /api/needs-human?status=open` | each output redacted (no sentinel, `***` marker); ≥3 `SECRET_REDACTED_HIT` detection events; event payloads never carry secret content; exactly one OPEN `security-issue` (`source` starts with `'redaction-monitor:exec:'`, `recipient: null`, `requiredDeciderLevel: 'operator'`) |
| Q1 | `POST /api/requirements` → 3× `POST /api/requirements/:id/ac-refinement` → `GET /api/needs-human?status=open` → 4th refinement | exactly one OPEN `requirement-ambiguity` (`source: 'requirement-refinement:<id>'`, `recipient: null`, `requiredDeciderLevel: 'manager'`); 4th refinement → 409 `REQUIREMENT_REFINEMENT_PAUSED` (the circuit breaker is real, not decorative) |

## Findings (sixth edition)

**F19 — Medium (honest wording does not survive persistence; no product-code change in this walkthrough).**
The Batch 41/42 builders pass an honest narrative to `needsHuman()`
(e.g. "The policy held on every attempt — no elevation occurred"), but
`NeedsHumanDbRecord` has no `detail` column and only
`buildBruteForceUpgradeRecord` copies its narrative into `detailJson`.
The policy-violation, redaction, and requirement-ambiguity builders
persist only structured fields (granter/denialCount, source/counts,
requirementId/refinementCount) — the API-visible record never states
the crucial qualifier. A human reading `GET /api/needs-human` sees
`reason: 'policy-violation'` with no in-record statement that no
violation actually occurred. Recommended fix (for a product batch, not
this walkthrough): include `narrative` in `detailJson` for the three
builders, mirroring the brute-force precedent.

**F20 — Low (walkthrough ordering, documented product rule).**
A successful admin authentication from the loopback IP clears the
brute-force counter ("legit login clears"). The S1 leg therefore does
its single-401 probe and read first, then runs a full fresh 10-denial
attack with no read between attempts. This is the documented detector
rule working as designed, not a bug — but any future leg that mixes
reads into an attack phase will silently reset the count.

**F21 — Info (walkthrough hygiene).**
`GET /api/audit` returns a bare array (newest first), not
`{records: […]}`. The v6 `auditRecords` helper accepts both shapes
(v5's `auditActions` already did); future legs should not assume the
envelope.

## Walkthrough (seventh edition, Batch 46)

Walks the Batch 43–45 links, single test, pure HTTP, zero mocks (the
E1-package leg runs the real compiled `@ai-factory/runtime` in-process,
also zero mocks). Run with `npm run demo:e2e-v7` (builds
mcp/tools/db/worktrees/employee-factory/runtime/cicd/security/secrets/requirements/server
first — the test imports the compiled runtime dist). v4 remains the
authority for the B31–B36 governance chains, v5 for the B37–B40 chains,
v6 for the B41–B42 §81 chains; v7 covers B43–B45 only.

| Chain | What is walked | What the run asserts |
|---|---|---|
| N1 | `POST /api/workforce/employees` (empty `taskScope`) → 403 ×3 by one granter → `GET /api/needs-human?status=open` | exactly one OPEN `policy-violation`; the persisted `detailJson.narrative` contains the honest qualifier ("The policy held on every attempt — no elevation occurred") — the Batch 44 F19 fix, visible through the read API |
| K1 | temp project tree (working files + `.ai/`) → `POST /api/projects` with its `path` → `POST /api/backup` → tamper one backed-up copy → `POST /api/restore/project-files` | manifest `scope` is `'factory-database+project-files'` (honest: files were actually collected); manifest lists `projects/<id>/src/index.ts` and `projects/<id>/.ai/config.yaml`; tampered backup → 422 and the live project tree is untouched (validation precedes any write) |
| E1(a) | in-process: default stepFn, zero custom stepFn — a tool throwing `MissingBinaryError` 3×; then a tool throwing a plain `Error` 3× | env tool → run `escalated`, `reasonCode` `LOOP_STAGNATION`, `stagnationSignature` `ENV_BINARY_MISSING` (the Batch 45 narrow passthrough); plain error → signature stays `tool:<name>:fail` (masking preserved for ordinary tools) |
| E1(b) | `POST /api/agents` → `POST /api/projects` → `POST /api/tasks` → `POST /api/runtime/runs` (script calls a nonexistent tool 3×) → poll to terminal → `GET /api/needs-human?status=open` | run `ESCALATED`; exactly one upgrade for that run, `reason: 'repeated-failure'`; zero `irrecoverable-env-error` (the env gate does not false-positive; the HTTP positive path still does not exist — Batch 44/45 boundary, pinned as code by the tripwire test) |

## Findings (seventh edition)

**F22 — Low (backup collection trusts the project record's `path`).**
`POST /api/projects` accepted `path` as a plain string — no absolute-path
check, no existence check, no containment check (`apps/server/src/index.ts`
passed `String(b['path'] ?? '')` straight into the row). `createBackup`
then resolved and walked whatever directory that field pointed at (bounded
only by the default exclusions and the 512MiB total cap). The restore side
*does* have `..` containment checks, but the collection side would happily
read an unrelated tree (e.g. a record pointing at `/etc`) into the backup
directory. In open (unauthenticated) mode any API caller could plant such a
record. Not a walkthrough artifact — a real product gap.

**Fixed in Batch 47.** Three layers, all in `apps/server/src/routes/backup.ts`
(path policy) + the `POST /api/projects` handler (`apps/server/src/index.ts`):
(1) record-creation gate — a non-empty `path` must be absolute, exist, be
a directory, and stay under the operator-configured root
(`FACTORY_PROJECTS_ROOT`, default `<db dir>/projects`); refusals carry
explicit codes (`PROJECT_PATH_NOT_ABSOLUTE` / `_NOT_FOUND` /
`_NOT_DIRECTORY` / `_OUTSIDE_ROOT`), containment checked before existence
so the code can never serve as an existence oracle; empty path stays legal
(no local working dir). (2) collector defense in depth — `createBackup`
skips rows whose path escapes the root and records them in
`manifest.skippedProjects` (`reason: 'path-outside-root'`), so even a row
planted before the gate (or written straight to the DB) cannot pull an
unrelated tree into a backup. (3) restore defense in depth —
`restoreProjectFilesFromBackup` refuses to write into a live directory
outside the root (same recorded reason). Dirty-data walk of the dev DB
(Batch 47): exactly one row, the seeded demo `MyApp`
(`C:\AIProjects\MyApp`) — no planted rows; the seed is now a recorded
skip rather than a silent one. Pinned by
`apps/server/tests/project-path-validation.test.ts` (6/6).

**F23 — Info (walkthrough hygiene).**
The v7 test imports the compiled `@ai-factory/runtime` dist for the E1(a)
leg, so `demo:e2e-v7` must build `@ai-factory/runtime` before running the
test (its chain does, mirroring v6). A future leg that needs more package
imports must extend the demo chain the same way — the test fails loudly
with a resolve error otherwise, not silently.
