# Walkthrough index (Batch 65)

One line per walkthrough edition below; each edition is cumulative
across files, not a replacement — `demo:e2e-v4` remains the authority
for the B31–B36 governance chains, v5 for B37–B40, v6 for B41–B42 §81,
v7 for B43–B45, v8 for B47, the audit-chain legs for B52–B56, the
usability/response-shape legs for B58–B61, and the invariant-coverage/
gap-closure legs for B62–B65. Every edition runs the real compiled
server (fresh temp SQLite, hermetic `FACTORY_SECRETS_DIR`) over pure
HTTP, zero mocks, unless the row says otherwise.

| Edition | Batch | Chains | Verification | Key findings |
|---|---|---|---|---|
| v1 (first edition) | 11 | 8 steps (health → final report → restart) | test body ≈1.3s, full invocation ≈6.5s, 3 consecutive green; server suite 83/83 | F1–F5 |
| v2 (second edition) | 21 | W1–W19 (authorization axis, outbox, secrets/exec, terminal SSE, backup schedules, worktrees, MCP stdio lifecycle, pipelines, SIGKILL) | 3 consecutive green (~6.4s each); v1 script still passes unchanged | F6, F7 (F7 closed B22) |
| v3 (third edition) | 30 | D1–D5 (db broker), B1 (build SBOM), R1 (retention), M1–M2 (MCP persistence), B2, A1 (audit hash chain) | 1/1 green first run; failure chains walked, not described | F8, F9 (F9 closed B31) |
| v4 (fourth edition) | 36 | P1 (pipelines), B1 (builds read), A1 (authority conflicts), D1 (task-scope ceiling), G1 (gates/delegations/proposals/disputes), R1 (project records), A2 (audit) | `npm run demo:e2e-v4`; one SIGKILL | F10–F13 |
| v5 (fifth edition) | 41 | M1 (real MCP handshake), S1 (sandboxed build), A1 (dev attestation), T1 (needs-human repeated-failure + high-risk-deployment), E1 (env errors in-process) | `npm run demo:e2e-v5`; T1 budget-exceeded honestly skipped (F14) | F14 (closed B49), F15–F18 |
| v6 (sixth edition) | 43 | P1 (policy-violation), S1 (auth brute-force), R1 (redaction monitor), Q1 (requirement-ambiguity) | `npm run demo:e2e-v6`; auth mode (`FACTORY_API_TOKENS`) | F19 (closed B44), F20, F21 (closed B46) |
| v7 (seventh edition) | 46 | N1 (narrative survives persistence), K1 (backup project files + tamper-422), E1(a) (env-code passthrough, package-level), E1(b) (HTTP negative control) | `npm run demo:e2e-v7` (11-package build chain), 1/1 ×3 | F22 (closed B47), F23 |
| v8 (eighth edition) | 48 | P1(a/b/c) (F22 path-policy gate + live-DB-plant threat model), M1(on) (enqueue-only 202), M1(off) (old sync behavior) | `npm run demo:e2e-v8`, 1/1 ×4; two server boots | F24, F25 |
| redaction leg | 49 | R1–R4 (cross-chunk redaction over terminal SSE: split value, prefix-overlap pair, exactly-once marker, audit events) | 1/1 ×3; 2 detection events — below escalation threshold, no needs-human noise by design | F26, F27 |
| §81 full-trigger sweep | 50 | S1–S8 (all eight §81 triggers; S8 = honest negative control at Batch 50 — flipped to positive in Batch 75, see F28; sweep S8 leg asserted in-file in Batch 80) | 1/1 ×3 (~3.4s each) at Batch 50 (7 OPEN rows, no env-error row); Batch 80: tally 8/8 (9 OPEN rows — the positive leg adds one repeated-failure) | F28, F29 |
| escalation leg | 51 | E1–E4 (4 detection events ≥ threshold → exactly 1 OPEN security-issue with honest narrative) | 1/1 ×3 (~7s each) | F30, F31 |
| audit-chain leg | 52 | A1–A2 (chain integrity: reverse API array to append order → verify → `ok:true`, `legacyCount:0`; 2nd `node:sqlite` connection tampers a middle record → `brokenAt` pinpoints it; key finding: no HTTP verify endpoint — server is writer, operator is verifier) | 1/1 ×3 | F32–F34 |
| verify endpoint (operator) | 53 | `GET /api/audit/verify`: server-side genesis-anchored full-chain verify → `{ok, verifiedCount, legacyCount, brokenAt?}`; `?limit`/`?offset` → 400 `AUDIT_VERIFY_NO_PAGINATION` (fail-closed); `viewer → 403`, `operator → 200` | contract test 4/4 ×2 (intact, tamper, pagination refusal, role gating) | F33 (closed B53) |
| audit-chain verify leg | 54 | V1–V3 (endpoint → `ok:true`; mid-chain DB tamper → `ok:false` + `brokenAt` at the midpoint index; `?limit=1` → 400) | 1/1 ×3 (~2s each); detection-not-prevention, unchanged | F35–F37 |
| audit-chain watch leg | 56 | A–C (healthy boot → 0 OPEN; tamper + reboot → exactly 1 OPEN `security-issue` via the boot-time check; reboot while still broken → still 1; `WATCH=0` + tamper → 0 OPEN with broken-chain control) | 1/1 ×3 (~9s each); real server boot path, not module-level tick | F39–F40 |
| usability-fix screenshot leg | 58 | real Electron+Xvfb + vite dev renderer + real compiled server: NeedsHuman empty state ("当前没有 OPEN 的升级记录" + honest §81 trigger list); QaPanel `orgErr` red pill (network-layer fetch patch on `/qa/org`, component code untouched); Approvals row-level busy **blocked** — a real bug crashed the panel on real approval data | real-machine PNGs, 2/3 verified; black-screen crash captured as evidence | F41 |
| AppImage main-window screenshot | 58 | `linux-unpacked` boot under xvfb (no FUSE on this machine, so the unpacked tree, not the `.AppImage` itself): CDP page target verified as the **built dist** renderer (`file:///…/app.asar/apps/desktop/renderer/index.html`, not vite dev); main window + backend healthy + real audit events | 1 real PNG (1439×871) | F42, F45, F46 |
| ApprovalsPanel response-shape fix | 58-5 | root-cause fix for F41: `RawApproval` + `toApprovalItem()` snake_case→camelCase mapping on all 5 paths (`id←approval_id`, `requestedBy←requester`, `riskLevel←risk_level`, `requiredApprover←required_approvers.join(', ')`, `status` + `INVALIDATED`); `(a.evidenceIds ?? []).length` guards; `ApprovalsErrorBoundary` in the same file | desktop tsc 0; real server response shape re-verified (exactly 20 snake_case keys, no `evidenceIds`/`agentId`) | F41 (closed B58), F43 |
| response-shape compatibility audit | 59 | all 38 desktop panels read against real server responses (20+ GET endpoints probed with seeded data): 1 more real bug of the F41 class — QaPanel whole-tree crash on failed QA runs (`summary={error}` passes the `{run.summary && ...}` guard, `categories.map` on undefined); fixed server-side (failure summary normalized to success shape + `error` field) and panel-side (red pill + `?? []`); other 37 panels clean | desktop tsc 0, server tsc 0 | F44, F48 |
| QA failure-path leg | 60 | A–C (failed QA run → server writes the normalized failure summary: `TMPDIR` under a regular file = deterministic ENOTDIR at the auto-fix step; summary is the success shape with zeros/empty arrays + non-empty `error` naming the qa-run dir, `Array.isArray(categories)` holds, record retrievable via `GET /api/qa/runs/:id`; success control → auto-fix applies, verdict PASS, no `error` key; key-set relationship pinned: failure keys = success keys + `error`); real server boot path, pure HTTP | 1/1 ×3; pins the F44 server-side fix (the panel's `categories.map` contract) | F49 |
| packaged full Electron walkthrough | 61-2 | `NODE_ENV=production` Electron (main.ts packaged path: `loadFile` + backend spawn), renderer from the compiled dist (`apps/desktop/renderer -> dist` temp symlink): (a) `PORT=32111` — `apiPort` injected via `loadFile(..., { query: { apiPort } })`, page URL `…/index.html?apiPort=32111`, `defaultApiBase()` → `http://localhost:32111/api`, full dashboard renders, no "Cannot reach" banner, no Offline; (b) race simulation (kill backend + `location.reload()`) → red banner with the *parsed* API_BASE (`http://localhost:32111/api`, not the old hardcoded 3100) + ● Offline; restart backend → banner cleared, ● Running, dashboard re-renders with new events (~2s retry) | 3 real PNGs, all viewed; both 60-5 fixes verified in the real packaged path | F50 |
| desktop interaction walkthrough | 61-4 | remaining interaction gaps closed on a real machine (Electron+Xvfb+vite dev+real server, real `executeJavaScript` handlers + screenshots): Board drag (synthetic HTML5 drag through React's real `onDragStart`/`onDrop`) of an IN PROGRESS card to CODE REVIEW → gate toast "⛔ 门禁拒绝（缺证据）" + real `WORKFLOW_TRANSITION_DENIED` in AI Activity (server 422 `GATE_DENIED` pre-verified via curl, UI consistent); real QA run (default unit category) → verdict PASS, attempts=3 (attempt 1 `PRODUCT_FAILURE` → auto-fix → attempts 2/3 pass), no red pill; Approvals regression (real HIGH approval) → panel renders Pending(1) + three buttons, no crash | 4 real PNGs, all viewed; Board/QA/Approvals interaction evidence | F51 |
| INV coverage sweep | 62-3 | all 35 SPEC_V2 invariants read+grepped against tests/walkthroughs: 24 pinned, 11 real gaps (G1–G11, prioritized G9>G8>G6>G10) | sweep document `gap-audit/INV_COVERAGE_SWEEP.md`; honest yardstick: pinned by a test or a walkthrough, never by code existing | F52 |
| `/api/projects` shape normalization | 62-2 | F48 close: desktop-side `RawProject` + `toProject()` snake_case→camelCase mapping, single normalization point in `api.projects()`; server untouched (snake_case is the §6.1 native contract — renaming it would be a breaking API change) | desktop tsc 0; real server response shape verified; projects tests 16/16 | F48 (closed B62) |
| pre-send prompt secret scanning | 63-2 | G9/INV-26: `scanForSecrets` wired into `runner.ts` `defaultStepFn` before `tracker.consumeModelCall()` and `adapter.invoke` — secret in prompt → fail-closed `adapter:secret-in-prompt`, adapter never called, model-call budget unconsumed; deterministic retry → `LoopStagnation` escalation (not silent retry) | new test 2/2 ×3; runtime package 176/176; error text carries the signature only, no secret values | F53 |
| exec-confinement walkthrough | 63-3 | G8/INV-15: A agent+legal command → 403 `CONFINEMENT_UNAVAILABLE` + `EXEC_DENIED` audit, zero `EXEC_RUN`; B human+same command → 200; C agent+`rm -rf /` (deny-pattern) → still `CONFINEMENT_UNAVAILABLE` — confinement check precedes the policy check | 1/1 ×3; real compiled server, pure HTTP; honest boundary: `UnverifiedBackend.verifyConfinement()` always `verified:false` — no real OS isolation on this host | F54 |
| RunManifest version pins | 63-4 | G6/INV-10: `RunManifestVersionPins` (employee/organization/policy/requirement versions) recorded at run creation (both `POST /runs` and resume); db migration for pre-pin rows (`NULL` = not recorded, never fabricated) | build 0; `npm test` 2520/2520 (+3, arithmetic 2517+3 verified); smoke:boot OK | F52 |
| auto-governance walkthrough | 64-2 | G10/INV-28: `evaluateAutoGovern` pure policy fn + `VersionRegistry` (idempotent disable, effect records kept); `autoGovern` executes disable/fallback-migrate/downgrade; `advance` `auto-govern` step writes `AUTO_GOVERNANCE_APPLIED` audit; healthy case → 0 decisions; failing case → 3 decisions + migrate to v0; v1 pinned case stays; new case activating v2 → 422 `DISABLED_VERSION`; observations carry `version` tags so old failures don't disable new versions (caught by a test) | walkthrough 1/1 ×3 (real compiled server, pure HTTP, `$HOME` temp dir); auto-governance 16/16, loop 6/6; evaluation package 118/118 ×3 | F56 |
| small-gaps trio | 64-3 | G1/INV-03 board drag: only `POST /transition` changes state (bare status/stage writes → 400, mixed writes ignored, illegal jump → 422 + `WORKFLOW_TRANSITION_DENIED`); G2/INV-05 git broker: broker deny → 403 `GIT_BROKER_DENIED`, zero side effects (no queue entry, target tip byte-identical); G5/INV-09 product authority: proposals filed `WAITING_HUMAN_DISPATCH`, unauthorized run → 403 `TASK_NOT_AUTHORIZED` | 5/5 ×3, 2/2 ×3, 1/1 ×3 (real compiled server, pure HTTP; zero product-code changes) | F60, F61 |
| data-export / release / finding / QA-gate | 64-4 | G11/INV-30: non-local model call records an explicit `data_export` evidence event before `adapter.invoke` (local exempt; unknown provider → `'unknown'` fail-safe, never silently assumed local); G7/INV-11: `Release.requirementRef` + deploy Gate 2b — fail-closed on pin mismatch without a compatibility statement (`RELEASE_EVIDENCE_MISMATCH` / `RELEASE_COMPATIBILITY_DECLARED` audits); G3/INV-07: `TaskManager.reportFinding()` — evidence required, `TODO` + `WAITING_HUMAN_DISPATCH`, never directly AUTHORIZED; G4/INV-08: `QaCreationGate` opt-in policy gate (deny → `GovernanceError`, zero registration) | 5/5, release +7 (49/49), task-dispatch +4 (12/12), org +5 (12/12); package tscs 0 | F57, F58, F62 |

## Findings index (F1–F68)

Status: `closed` = fixed and pinned by tests; `open` = still true today
(includes by-design and environment notes); `hygiene` = process note, no
fix expected.

| # | Level | Status | One-liner |
|---|---|---|---|
| F1 | High | closed (B12) | v2 lifecycle cannot complete over HTTP — no finalize route; detour via v1 transition (no completion-predicate check, `final_seal` stays 0). Fixed Batch 12: `POST /api/tasks/:id/v2-complete` added (now in `routes/v2-transitions.ts`) — finalize predicate + `final_seal` in one commit |
| F2 | Medium | closed (B12) | requirements and §16 compatibility declarations are process memory, lost on restart. Fixed Batch 12: `SqliteRequirementStore` landed (`requirements` / `requirement_versions` / `requirement_links` / `promotion_holds` / `evidence_compatibility` tables), server rehydrates from it |
| F3 | Medium | closed (B12) | v2 transitions do not seal the evidence they consume (`onSealEvidence` unwired). Fixed Batch 12: server wires `onSealEvidence` → `EvidenceEngine.seal` on v2 transition commit (now in `routes/v2-transitions.ts`) |
| F4 | Low | closed (B12) | run records are process memory (`GET /api/runtime/runs/:id` 404s after restart). Fixed Batch 12: `SqliteRuntimeRunStore` landed (`runtime_runs` table), records written through on create/evidence/final |
| F5 | Low | open | final-report `contentHash` covers `generatedAt` — compare counts, not hashes |
| F6 | Medium | open | partial workspace rebuilds can leave `dist/` inconsistent; full `npm run build` resolves |
| F7 | Low | closed (B22) | outbox read surface vs DB column vocabulary mismatch — fixed with exported `eventTypeOf` + deterministic projection |
| F8 | Low | open | retention `evaluate` counts candidates per category, not files |
| F9 | Low | closed (B31) | no `/api/builds` read route — added read-only builds surface |
| F10 | Low | open | mid-run pipeline chain uses honestly-labeled row-shape simulation (real SIGKILL can't land mid-run) |
| F11 | Low | open | `GET /api/pipelines/:id` prefers the live in-memory record; persisted view authoritative only after restart |
| F12 | Low | closed (B75) | authority-conflict registry persisted (Batch 75): directives+conflicts upserted to SQLite, OPEN conflicts survive restart |
| F13 | Info | hygiene | scope contract is enforced, not approximated (server's 403 names the missing permission) |
| F14 | Medium | closed (B49) | `budget-exceeded` had no deterministic HTTP trigger — `budgets: {maxSteps,timeMs,maxRetries}` added, fail-closed |
| F15 | Low | open | M1 leg needs the npm registry (loud skip in this environment) |
| F16 | Low | open | sandbox assertion is environment-adaptive (`BUILD_SANDBOXED` or honest `SANDBOX_UNAVAILABLE`) |
| F17 | Info | hygiene | attestation null path pinned in-process instead of a second boot |
| F18 | Info | hygiene | editions are cumulative across files, not replacements |
| F19 | Medium | closed (B44) | honest narrative did not survive persistence — now `detailJson.narrative` on all 8 builders |
| F20 | Low | open | documented product rule: a legit login clears the brute-force counter (phase ordering matters) |
| F21 | Info | closed (B46) | `GET /api/audit` bare array pinned as the formal contract (tripwire test) |
| F22 | Low | closed (B47) | backup collector trusted the project record's `path` — 3-layer fix (record gate + collector defense + restore defense) |
| F23 | Info | hygiene | demo chains that import package dists must build them first (loud resolve failure otherwise) |
| F24 | Info | hygiene | live DB plant relies on the server being idle; stop-plant-restart is the deterministic fallback |
| F25 | Info | hygiene | parallel walkthroughs share the 24xxx–44xxx random port pool; collisions fail boot loudly |
| F26 | Info | hygiene | metadata-only contract = absence of a `value` key, not string containment |
| F27 | Info | hygiene | `GET /api/audit` rows are camelCase (`entityType`/`entityId`) |
| F28 | Info | closed (B75) | S8 flip point implemented (Tan decision "A A A", 2026-10-15): operator-gated `envErrorSignal` on `POST /api/runtime/runs` makes `irrecoverable-env-error` deterministically reachable over HTTP; fail-closed 400 `INVALID_ENV_ERROR_SIGNAL`, audited `RUNTIME_ENV_ERROR_SIGNAL_USED`, record qualified as declared-not-observed |
| F29 | Info | hygiene | auth-mode walk ordering: brute-force leg's 10 bad requests must be back-to-back |
| F30 | Info | hygiene | escalation threshold counts detection *events*, not summed hit totals |
| F31 | Info | hygiene | escalate-once-per-pattern; window-expiry reset covered by package unit tests |
| F32 | Info | open | must verify in append order (`ORDER BY ts, rowid`), not API newest-first order — feeding the raw `GET /api/audit` array to `verifyAuditChain` yields `brokenAt:0` on an intact chain; the walk reverses first |
| F33 | Info | closed (B53) | pagination truncates genesis: `limit` smaller than the chain length misreports `brokenAt:0` (probe-confirmed) — closed by `GET /api/audit/verify`, which anchors at genesis and refuses pagination outright (`?limit`/`?offset` → 400 `AUDIT_VERIFY_NO_PAGINATION`) |
| F34 | Info | hygiene | audit-chain leg's second-connection tamper write is timing-adjacent (server idle between HTTP calls); the 10-attempt lock retry is hygiene, never triggered in practice |
| F35 | Info | open | verify leg runs in default (no-token) auth mode; the role axis is pinned by the contract test (`viewer → 403`, `operator → 200`) — a viewer session sees the server's 403 surfaced verbatim, not a fabricated result |
| F36 | Info | closed (B55) | `GET /api/audit/verify` is point-in-time, not a watch — but continuous attestation (periodic verify + alert) is now default-on via the in-process audit-chain watch (F38): boot-time check + 60s tick (`apps/server/src/audit-chain-watch.ts`, `FACTORY_AUDIT_CHAIN_WATCH=0` opts out), `AUDIT_CHAIN_VERIFY_FAILED` + exactly one §81 security-issue on a break (B56 walkthrough A–C pinned: healthy silent, tampered → 1 OPEN, no storm); the endpoint itself remains point-in-time by design, still detection-not-prevention |
| F37 | Info | hygiene | `brokenAt` is an append-order (genesis-anchored) index, not API newest-first order (F21); joining `brokenAt` against the raw array without reversing points at the wrong record |
| F38 | Info | closed (B55) | F36's 'operator policy choice' is now the server default: periodic in-process `audit.verify()` (60s, `FACTORY_AUDIT_CHAIN_WATCH_INTERVAL_MS`) raises one §81 `security-issue` on a break (`AUDIT_CHAIN_VERIFY_FAILED` + `NEEDS_HUMAN_RAISED`, dedup by open list); silent on success; `FACTORY_AUDIT_CHAIN_WATCH=0` opts out — default-on because detection-not-prevention means nothing unless detection runs |
| F39 | Info | hygiene | watch walkthrough boots the real compiled server process (not just the exported tick function): slower (~9s) but exercises the boot-time check that ships, plus SIGTERM handling and port rebinding |
| F40 | Info | hygiene | the WATCH=0 leg keeps a broken-chain control (`GET /api/audit/verify → ok:false`) so '0 OPEN' means the opt-out, not a failed tamper |
| F41 | High | closed (B58) | ApprovalsPanel whole-tree crash on real approval data: the panel's `createApprovalsApi` invented a camelCase `ApprovalItem` contract with zero mapping; `GET /api/approvals` returns the manager's native snake_case `Approval` (`approval_id`, `requester`, `risk_level`, …); `a.evidenceIds.length` on `undefined` → TypeError → no error boundary → the whole React tree unmounts (black screen). The B57-3 'zero 404 dead buttons' audit only checked endpoint existence, never response-shape compatibility; tsc cannot catch a type assertion |
| F42 | Info | hygiene | the AppImage main-window screenshot is the first packaged-renderer screenshot (built dist, verified by CDP page target `file:///…/app.asar/apps/desktop/renderer/index.html`) — distinguishable from the vite-dev screenshots of earlier legs |
| F43 | Info | closed (B59) | post-fix real-machine walkthrough for F41: no more crash (panel renders mapped fields), row-level busy captured ("处理中…", all three buttons disabled, network-layer delay 2.5s, component code untouched), full approve→decided loop with real audit events (`APPROVAL_DECIDED`, `APPROVAL_EVIDENCE_ATTACHED`); the 58-2 'black screen after 20s' phenomenon is gone; `ApprovalsErrorBoundary` never triggered |
| F44 | High | closed (B59) | QaPanel whole-tree crash on failed QA runs (same class as F41): `loop.execute` throws → server wrote `record.summary = { error: message }`; the panel's `{run.summary && ...}` guard lets an `{error}` object through → `run.summary.categories.map` on `undefined` → no error boundary → whole tree down. Fixed on both ends: server failure summary now matches the success shape (`total/passed/failed/skipped: 0`, `categories: []`, `failures: []`) plus an `error` field; the panel renders a red pill 「⚠ QA run 异常失败：…」 and guards `categories`/`failures` with `?? []` |
| F45 | Info | hygiene | this machine's `/tmp` is a 512MB tmpfs (474M used): AppImage staging needs ~2GB and heavy SQLite writes fail with `ERR_SQLITE_ERROR disk I/O error` — reroute to `$HOME`; environment constraint, not build-code rot |
| F46 | Info | hygiene | no FUSE on this machine (`libfuse.so.2` missing): the `.AppImage` binary itself cannot execute here; the `linux-unpacked` tree runs the same bundled code — recorded as a boundary, not a product defect |
| F47 | Info | hygiene | SIGKILL of the packaged main process leaves its spawned backend child reparented (main.ts's `window-all-closed` `backend?.kill()` only fires on normal exit): kill the backend child by exact PID too |
| F48 | Low | closed (B62) | `/api/projects` returned snake_case bare rows (`created_at`, …) while the desktop `Project` interface only read `id`/`name`/`description`/`path` — closed by the desktop-side `RawProject` + `toProject()` mapping: `Project` is now an explicit camelCase contract (`createdAt`/`updatedAt`, defensive `status` fallback), all consumers go through the single `api.projects()` normalization point; server untouched (snake_case is the §6.1 native contract) |
| F49 | Info | closed (B60) | QA failure-path leg pins the F44 server-side fix end to end: with `TMPDIR` under a regular file (a real, deterministic environment failure), `POST /api/qa/runs` fails at the auto-fix step (`ENOTDIR` naming the `qa-run-<id>` dir) and the run record's summary is exactly the success shape (`total/passed/failed/skipped: 0`, `categories: []`, `failures: []`) plus a non-empty string `error` — key set = success keys + `error`; the record is retrievable via `GET /api/qa/runs/:id`; `Array.isArray(categories)` holds (the panel's `categories.map` contract, the exact thing that crashed the tree pre-fix). Success control (normal `TMPDIR`): auto-fix applies, verdict PASS, no `error` key. Test-hygiene note: `node --test` exports `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID`, which makes the QA loop's spawned `node --test` children refuse to run ("recursively within a test file") — the walkthrough boots its servers without those vars (production never has them); env hygiene, not a mock |
| F50 | Info | closed (B61) | 60-5 fixes verified in the real packaged path: `apiPort` query injection via `loadFile` works (`PORT=32111` → fully rendered dashboard, no Offline); race simulation (kill backend + reload) → red banner with the *parsed* `API_BASE` (`http://localhost:32111/api`, not the old hardcoded 3100) + ● Offline; restart backend → banner cleared, ● Running restored (~2s retry); the packaged path no longer assumes port 3100 or mount-once success |
| F51 | Info | closed (B61) | remaining desktop interaction gaps closed on a real machine: Board drag (IN PROGRESS→CODE REVIEW) → gate toast "⛔ 门禁拒绝（缺证据）" + real `WORKFLOW_TRANSITION_DENIED` (UI consistent with server 422 `GATE_DENIED`); real QA run → verdict PASS, attempts=3 (attempt 1 `PRODUCT_FAILURE` → auto-fix → attempts 2/3 pass), no red pill; Approvals regression → panel renders, no crash (approve→decided loop already walked in 59-2) |
| F52 | Info | closed (B64) | SPEC_V2 invariant coverage sweep (`gap-audit/INV_COVERAGE_SWEEP.md`): 24/35 pinned by tests/walkthroughs, 11 real gaps G1–G11 — all closed by Batch 64 (G9→63-2 secret scanning, G8→63-3 exec-confinement, G6→63-4 version pins, G10→64-2 auto-governance, G1/G2/G5→64-3 trio, G11/G7/G3/G4→64-4) |
| F53 | Info | closed (B66) | G9 follow-up done: run-trace desensitization landed — `recordTrace` (`loop.ts`) and `harness.trace()` now pass through `redactText` (`@ai-factory/events`), so `api_key = "…"`, `password = "…"`, `token = "…"` are masked in trace notes (4/4 tests; end-to-end runAgent with a tainted goal shows no secret bytes in the full trace, pre-send fail-closed still fires with 0 adapter calls). Boundary: bare high-entropy strings without key prefixes are not caught (best-effort); the adapter-path fail-closed scan remains the hard guarantee; git-commit secret scanning still out of scope |
| F54 | Info | open | G8 honest boundary: `UnverifiedBackend.verifyConfinement()` always returns `verified:false` — this host has no real OS isolation; what the walkthrough pins is the *refusal*, not a sandbox claim (no-universal-isolation-host is a known hard gate) |
| F55 | Info | hygiene | Batch 63 shared-worktree incident: 63-4 ran `git stash -u` on the shared main tree (repeating the B39/B43 iron-rule violation) to check a test-count arithmetic, sweeping up sibling work — recovered byte-identical via `git checkout stash@{0}` / `stash@{0}^3` (63-3's file rebuilt, SHA-256 identical; `.github/workflows/ci.yml` reset to untracked), zero files lost; lesson nailed into AGENTS.md — every spawn brief must restate the no-stash rule |
| F56 | Info | open | G10 honest boundaries: `downgrade-autonomy` is decided and recorded in the admission trail, but actually rewriting the autonomy store is the autonomy layer's job (the evaluation package doesn't cross-package write, and the server doesn't pretend to execute it); observation thresholds (1 failure → disable, 2 consecutive → downgrade) are documented engineering choices, not spec numbers |
| F57 | Info | closed (B66) | G4 wiring done: project policy store landed (`packages/employee-factory/src/project-policy.ts` — `DEFAULT_FACTORY_POLICY`, `QA_CREATION_POLICY`, `FactoryPolicyStore` per project key with default fallback); server wires it via `RouteContext.factoryPolicyStore?`, and `routes/qa.ts` passes the gate at both `ensureQaLead`/`createQaSpecialist` creation points (`GovernanceError` → 403 `governance:true`) — wiring tests 5/5. Boundary: the default policy is permissive by design (doesn't break existing QA flows); tightening values is a per-deployment product decision, the store is the handle for it |
| F58 | Info | hygiene | G11 honest boundary: `DATA_EXPORT` is an evidence-level audit record, not an approvals-package authorization ticket; a real pre-send export authorization ticket needs approvals integration (follow-up item) |
| F59 | Info | hygiene | this machine has no `/dev/null` (`mknod` blocked by the container) — a regular file stands in (625 bytes and accumulating, not auto-discarded) so git works; environment issue, unfixable from here |
| F60 | Info | hygiene | G2 mechanics boundary: build-runner's git subprocess is downstream mechanics of a broker-authorized merge decision — gating it again would be double-gating the same decision (noted in the test file header) |
| F61 | Info | closed (B75) | G5 honest boundary: v1 `POST /transition` didn't check the §17.2 axis (Board still runs on v1); Tan decided 2026-10-15 21:15 +08 (decision card "A A A") to add the check. Fixed B75: the v1 handler now refuses non-AUTHORIZED tasks with 403 `TASK_NOT_AUTHORIZED` (the G5 gate shape from `POST /api/runtime/runs`; legacy rows read AUTHORIZED so the default path is unchanged); regression test `v1-transition-authorization.test.ts` A/B/C/D (legacy default 200 / WAITING → 403 row untouched / REVOKED → 403 / human dispatch re-authorizes → 200). Board drag UX: an unauthorized task's drag now shows a dedicated "⛔ 未授权（§17.2）…请先在 Dispatch 页签完成派发" toast (was the generic 流转失败 toast); documented in KNOWN_LIMITATIONS (§17.2 entry, Batch 75) |
| F62 | Info | hygiene | G7 honest boundary: the compatibility statement is caller-provided — the system records and audits it (`RELEASE_COMPATIBILITY_DECLARED`), never verifies its truth |
| F63 | Medium | closed (B66) | `/api/profiles` (Agent leaderboard) 404'd forever: the server's own documented route (`routes/evaluation.ts` lines 7–8: `GET /api/profiles`) with a working handler was blocked by its own `inScope` gate (only放行 `/api/evaluations`, `/api/proposals`, `/api/loops`); the Evaluation panel showed a permanent red "Not found" banner (caught — no tree crash, but the leaderboard could never load). Fixed B66 (6 lines: `PROFILE_PREFIX` constant + gate放行 — the server's own contract, zero contract change, zero desktop changes); regression test `evaluation-profiles-gate.test.ts` 2/2 × 3 rounds (A: `/api/profiles` → 200 with a `profiles` array; B: unknown id → the handler's own 404 text, not the generic one); B67-2 verified the fix inside the packaged build (red banner gone, leaderboard renders 「暂无画像数据。」) |
| F64 | Medium | closed (B68) | BottomPanel stale 「审计日志加载失败：Failed to fetch」 pill: the 67-2 packaged walkthrough spotted the small error pill while audit rows scrolled normally. Root cause (68-2): startup race — the renderer polls before the spawned backend is up, so the initial non-silent `load(false)` set `err`; subsequent silent `load(true)` polls succeeded but never cleared it (`if (!silent) setErr(null)`), leaving the pill stuck forever. Fixed B68 (6 lines, desktop only, server untouched: unconditional `setErr(null)` on success / `setErr(...)` on failure; `silent` now only guards the loading spinner, no longer the error state). Verified B69-2 on real Electron: backend down → pill appears with 0 rows; backend back → pill gone after one 5s silent poll, 17 audit events scroll (the pre-fix permanent residue no longer occurs); B70-2 confirmed zero residue on the normal packaged startup path (the race is intermittent, not guaranteed). Desktop has zero test infra — no repo regression test was added; honestly stated, not pretended |
| F65 | Medium | closed (B69) | ApprovalsPanel stale error banner — same class as F64: `refresh().then(setItems)` never cleared `error`, so a startup-race `setError("Failed to fetch")` left a permanent `{error && <div className="banner err">}` on the panel. Fixed B69 (4 lines, desktop only, server untouched: `.then((items) => { setItems(items); setError(''); })` — `act()`'s post-decision `.then(refresh)` benefits too). Desktop error-state-machine sweep (69-3): 31 `setErr`/`setError` files read + the 8 polling panels' refresh logic reviewed — the others (ActivityPanel, DashboardPanel, EventsPanel, ModelsPanel, NotificationsBell, OpsPanel, App.tsx bootError, TaskDetail, BottomPanel) all clear the error on success; no other instance of this pattern found |
| F66 | Info | hygiene | SPEC_V2 §58 migration-map compliance check (71-2): the 135-entry v1.0→v2.0 table fully walked — all actionable migration entries compliant, 0 real deviations (v1.29 quota sharing pinned shared-not-per-agent; v1.76 sandbox upgrade verbatim in `isolation.ts`'s header comment; v1.126 zero agent-builder references; §52.4 v1 data migration implemented in `migrate-v1.ts`/`migrate-import.ts`; v1.12/v1.109–118 state-machine migration with honestly-labeled lossy points). AT-001–AT-064 still NOT_RUN — the honestly recorded hard gate, not a hidden deviation |
| F67 | Medium | open | Windows final Setup exe cannot be produced on this Linux host: `electron-builder --win --publish never` builds the NSIS payload 7z (109MB) fine, but the final exe assembly needs `wine` (uninstallable here — apt unreachable, container network limits), so the emitted 230KB Setup exe is an unusable stub. All three platforms ship unsigned with zero cert config (Windows OV/EV cert, Apple Developer ID + notarization — all Tan's decisions, never decided for him); macOS DMG is impossible on Linux (no `hdiutil`/`sips`); `npm run dist:win` lacks `--publish never` (CLI workaround only, tracked config untouched — noted, not changed). A real Windows machine (Node 24 + `npm run dist:win`) and a real Mac are required for final installers |
| F68 | Info | closed (B70) | packaged-panel bug-hunt (70-3): 27/27 center tabs clicked in the freshly rebuilt AppImage (`linux-unpacked/`, with the B68/B69 fixes verified inside the asar bundle first) — zero tree crashes, zero error boundaries, zero 「Failed to fetch」 pills, zero 「Not found」 banners. Two flags investigated and ruled non-bugs: Agents' 「Organization graph invalid / graph has no root」 is the honest empty state (guided 「No org nodes yet — add the root below」 UX with the Add node form below); Models' 「degraded」 is just an AVAILABILITY cell value, not an error banner. Side confirmations: Evaluation leaderboard 「暂无画像数据。」 (66-3 fix effective in the new package), Approvals panel no stale banner (69-3 fix effective), Report panel assembles a full report live (6 tasks / 8 evidence / sha256 hashes), Terminal PTY connects for real. Honest uncovered: token mode (walked token-less), the real `.AppImage` binary itself (no FUSE — F46), human clicks (CDP synthetic) |

---

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

**F12 — Low (closed, Batch 75).**
The authority-conflict registry is now durable: every registry mutation
(register / supersede / override / attach / resolve) is upserted to the
`authority_directives` / `authority_conflicts` tables by the server
(write-through; a persist failure is audited as
`AUTHORITY_CONFLICT_PERSIST_FAILED` but never rolls back the response —
the decision happened, the row is the record of it). At boot the rows
are loaded into a fresh registry (silent hydrate — no audit events, no
`onConflictOpened` re-emission, so the §81 'ai-disagreement' upgrade is
raised exactly once, when the conflict opens). OPEN conflicts hydrate
as-is and pause their targets again; RESOLVED conflicts hydrate as
read-only history. Both tables are new in Batch 75, so old DB files get
them via `CREATE TABLE IF NOT EXISTS` on open — no column migration.
The walkthrough still resolves the conflict before the kill — now as a
demonstration of the resolve path, not a workaround for lost state.

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

**F14 — Medium (honest gap in HTTP reach; CLOSED in Batch 49).**
`budget-exceeded` had no deterministic HTTP trigger: the runtime route's
default stepFn returns `COMPLETE` at the first `EVALUATE`, so every HTTP
run finished in ~6 steps and could never reach `maxSteps: 40`. The emission
code path (`buildRunUpgradeRecord`/`emitRunNeedsHuman`) was real and
package-tested (`runner-reason-code.test.ts` 4/4); the walkthrough did
not fake a trigger. **Batch 49 fix:** `POST /api/runtime/runs` and
`POST /api/runtime/runs/:id/resume` now accept an optional `budgets`
object (`{ maxSteps?, timeMs?, maxRetries? }`, fail-closed validation →
400 `INVALID_BUDGETS`), resolved per-request by `resolveRunLoopBudgets()`
and threaded to both the `AgentLoop` and the manifest's
`budgetLimits.loop` snapshot (the Batch-15 no-drift invariant, now
per-request). With `budgets: { maxSteps: 3 }` the caller sets a real,
enforced limit and the run genuinely exceeds it → `BUDGET_EXCEEDED` →
'budget-exceeded' emission over pure HTTP — the first deterministic HTTP
trigger for this §81 reason. Pinned by
`apps/server/tests/runtime-run-budgets.test.ts` (11/11: unit resolver +
HTTP positive path + manifest honesty + fail-closed validation +
defaults-unchanged regression + resume-path validation). If a future
route lets callers stretch runs (custom step functions, pause/resume
marathons), this leg should be re-walked.

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

## Walkthrough (eighth edition, Batch 48)

Walks the Batch 47 links, single test, pure HTTP, zero mocks (the P1-plant
leg writes one row straight into the live DB via `node:sqlite` — not a
mock, but the F22 threat model itself: a row that predates the
record-creation gate or was written straight to the DB, bypassing HTTP
validation). Two server boots: Server A with `FACTORY_MERGE_DRAIN=0` (plus
`FACTORY_PROJECTS_ROOT`), Server B with the default env. Run with
`npm run demo:e2e-v8` (same 11-package build chain as v7 — the test needs
no new package imports, only node builtins). v4 remains the authority for
the B31–B36 governance chains, v5 for the B37–B40 chains, v6 for the
B41–B42 §81 chains, v7 for the B43–B45 chains; v8 covers B47 only.

| Chain | What is walked | What the run asserts |
|---|---|---|
| P1(a) | `POST /api/projects` with planted paths: `/etc`, `<root>/../etc`, `relative/path`, `<root>/does-not-exist-b48` | each → 400 with its own explicit code (`PROJECT_PATH_OUTSIDE_ROOT` / `PROJECT_PATH_OUTSIDE_ROOT` / `PROJECT_PATH_NOT_ABSOLUTE` / `PROJECT_PATH_NOT_FOUND`); no record is written for any of them |
| P1(b) | a real tree under the operator root → `POST /api/projects` with its `path` | 201 — the gate is a policy, not a blockade |
| P1(c) | create a second in-root project (201), then live-plant its path to `/etc` via a direct DB write while the server runs → `POST /api/backup` | 201; `manifest.scope` stays `'factory-database+project-files'` (the good tree is still collected); no manifest entry under `projects/<planted>/` — `/etc` was never walked; the planted row is *recorded* in `manifest.skippedProjects` with `reason: 'path-outside-root'`, never silent |
| M1(on) | real git repo (feat branch merges cleanly onto main) → `POST /api/git/pr` → `POST /api/git/merge-queue` with `FACTORY_MERGE_DRAIN=0` | 202 + `drainPending: true`; entry stays `QUEUED` (drain never ran on this instance); a `MERGE_QUEUE_ENQUEUED` audit record carries the deferral (`drainPending: true`, `reason: 'FACTORY_MERGE_DRAIN=0'`) |
| M1(off) | same git setup on Server B (default env) → `POST /api/git/merge-queue` | 201, no `drainPending` field on the default path, entry `MERGED` — the old synchronous behavior is untouched |

## Findings (eighth edition)

**F24 — Info (walkthrough hygiene: live DB plant relies on the server being idle).**
The P1(c) leg plants a row with a direct `node:sqlite` autocommit write
while the child server holds the DB open. This works (verified during
development — no lock contention, since the server holds no open
transaction between HTTP calls), but it is timing-adjacent: a write that
lands mid-transaction would throw `SQLITE_BUSY` instead of failing an
assertion. If this leg ever flakes, the deterministic alternative is
stop-plant-restart (stop the server, plant, reboot, then run the backup) —
the threat model is identical either way.

**F25 — Info (parallel-batch port pressure).**
During development one probe hit `ECONNREFUSED` because a sibling batch's
server was already on the randomly chosen port — the 24xxx–44xxx random
port range is shared by all concurrently running walkthroughs and tests.
The boot loops treat a collision as a boot failure (loud), never as a
misread assertion. As parallel batches multiply, a wider or coordinated
port scheme would reduce flaky boot retries.

## Walkthrough: redaction leg (Batch 49)

The v1–v8 series never covered secret redaction; Batch 48 made the
terminal SSE stream cross-chunk safe (`createCrossChunkRedactor` in
`packages/secrets/src/broker.ts`, wired per-SSE-subscription in
`apps/server/src/routes/terminal.ts`). This leg
(`apps/server/tests/first-run-walkthrough-redaction.test.ts`, single test,
pure HTTP, zero mocks, real server + real pty) drives it end to end:
three real secrets in the hermetic file vault, a terminal session created
with `secretEnv` refs, each secret emitted SPLIT across two pty writes.

Deterministic chunk forcing (no timing luck): one input line runs
`printf '%s' "${VAR:0:12}"; sleep 0.7; printf '%s' "${VAR:12}"` — the halves
are contiguous in the transcript (no shell prompt between them) but arrive
as two separate pty data events 0.7s apart → two separate redactor pushes.
`stty -echo` first, so command lines are not echoed and the marker line can
be asserted exactly-once. A single SSE subscription reads to the
session's `close` event; the handler flushes the held tail BEFORE the close
frame, so the collected text is the complete redacted transcript. The
shell is ended with `exit` (no DELETE — that would 404 the stream's
session record).

| Chain | What is walked | What the run asserts |
|---|---|---|
| R1 | realistic token (`walk-b49-sentinel-<ts>`) split mid-value across two chunks | stream contains zero bytes of the value; `***` present |
| R2 | prefix-overlap pair: short value `walk-b49-pre` is a strict prefix of `walk-b49-pre-longer`; the long one is emitted with the split exactly at the short/long boundary | long value fully redacted; no partial `-longer` tail leaks (the Batch 48 `xxAB\|CDEFyy` leak scenario, live); short value never appears standalone |
| R3 | plain `NORMAL-<marker>` line with echo off | appears exactly once in the collected stream — no duplication, no loss |
| R4 | `GET /api/audit` after the stream closes | ≥1 `SECRET_REDACTED_HIT` events, all `entityType: 'terminal'` + `entityId` = the session; no event carries secret content |

Verified 1/1 three consecutive runs. Observed: exactly 2 redaction
markers (one per emitted secret) and exactly 2 detection events — below
the redaction-monitor escalation threshold of 3, so this leg creates no
needs-human noise by design.

## Findings (redaction leg)

**F26 — Info (walkthrough hygiene: metadata-only means "no `value` key").**
The first draft asserted `!JSON.stringify(putBody).includes(secretValue)`
on `PUT /api/secrets/:name`; it failed on the prefix-overlap secret whose
value equals its name (`walk-b49-pre`) — the metadata legitimately carries
the name. The honest contract (as the b43 walkthrough asserted) is the
absence of a `value` key in the response, not string containment.

**F27 — Info (test hygiene: audit rows are camelCase).**
`GET /api/audit` rows use `entityType`/`entityId` (mapped in
`packages/db/src/db.ts`), not the snake_case DB column names. Adjusted
the R4 assertions accordingly.

## Walkthrough: §81 full-trigger sweep (Batch 50)

Single `it`, pure HTTP, zero mocks, real compiled server over a fresh temp
SQLite file (auth mode — `FACTORY_API_TOKENS=admin:…` — so the brute-force
leg is reachable; every other call carries the admin Bearer). Hermetic:
temp DB + temp `FACTORY_SECRETS_DIR`. Dual-mode: node builtins + fetch,
zero src imports.

| Leg | Trigger | How it is fired over HTTP | What the run asserts |
|---|---|---|---|
| S1 | security-issue | 10 × wrong Bearer on `POST` (back-to-back; no successful admin read between — a login clears the source counter) | exactly 1 OPEN, source `auth-bruteforce:<ip>`, narrative carries "counting fact … not a heuristic classification" |
| S2 | policy-violation | same granter, 3 × `POST /api/workforce/employees` with empty `taskScope` → 403 | exactly 1 OPEN, source `policy-denial:<granter>`, narrative carries "The policy held on every attempt" |
| S3 | requirement-ambiguity | 3 consecutive `POST /api/requirements/:id/ac-refinement` | exactly 1 OPEN, narrative carries "may be ambiguous" |
| S4 | ai-disagreement | `mgr-a` ALLOW then `mgr-b` BLOCK on the same run target (same rank) → conflict OPEN | exactly 1 OPEN, narrative carries "the conflict is structural, not a judgment on either principal" |
| S5 | high-risk-deployment | `POST /api/pipelines/:id/deploy` with no risk signals → assessRisk computes HIGH (unknown → strict) → parked at AWAITING_APPROVAL | exactly 1 OPEN, narrative carries "no deployment was executed — the gate held" |
| S6 | budget-exceeded | `POST /api/runtime/runs` with `budgets: {maxSteps: 3}` → run FAILED / BUDGET_EXCEEDED (Batch 49 F14 deterministic trigger) | exactly 1 OPEN for the run, narrative carries "resource fact" |
| S7 | repeated-failure | script with 4 × unknown-tool calls → stagnation → LOOP_STAGNATION → ESCALATED | exactly 1 OPEN for the run, narrative carries "retry budget was exhausted" |
| S8 | irrecoverable-env-error | Batch 50: **honest negative control** — the server's HTTP surface had no input that could put a stagnation signature into ENV_ERROR_CODES, so the run asserted ZERO records for this reason (see F28). **Batch 75: now HTTP-reachable via the operator-gated `envErrorSignal`** — the positive leg asserts exactly 1 `irrecoverable-env-error` (declared-not-observed) + 1 `repeated-failure` for the signaled run; the negative control holds when the signal is absent | the non-env stagnation from S7 produced exactly one upgrade record and nothing else |

Final tally asserts the OPEN set is exactly the seven fired reasons and
contains no `irrecoverable-env-error` row. (Batch 80: the sweep now
asserts the positive S8 leg in-file — tally is 8/8 over HTTP, 9 OPEN rows
total — the Batch-50 sentence above is the historical snapshot.)

Verified 1/1 three consecutive runs (~3.4 s each; 7 OPEN rows total).
(Batch 80: sweep file 1/1; 59/59 with all ten needs-human test files.)

## Findings (§81 sweep)

**F28 — Info (honest scope: 7/8 fire, the eighth is a pinned boundary).**
The task assumed all eight triggers "might now be HTTP-reachable" after
F14 closed the budget path. Verification says otherwise: no HTTP input on
this server can produce an env-code stagnation signature (Batch 44/45
boundary still holds — default stepFn masks tool codes, only echo/add are
registered, StubAdapter never throws). The sweep asserts the negative
boundary explicitly rather than faking a positive path. If a future batch
adds an HTTP-reachable env signal, this leg is the place to flip S8 to
positive.

**Batch 75 — flipped to positive (Tan's decision "A A A", 2026-10-15).**
`POST /api/runtime/runs` now accepts an optional `envErrorSignal`
(`ENV_SANDBOX_UNAVAILABLE` | `ENV_BINARY_MISSING`). When set, the run's
step function throws the declared env FactoryError on every step, the
loop stagnates on the env code (stagnationLimit 3), escalates, and the
Batch-43 emission block fires — S8 is now a positive trigger. The
footgun risk was named explicitly (an HTTP caller can declare "the
environment is irrecoverable") and Tan chose to build it anyway; the
protections are layered and pinned by tests
(`needs-human-irrecoverable-env-error-http.test.ts`): (1)
operator-gated — the endpoint already requires the operator role
(viewer → 403, unauthenticated → 401); (2) fail-closed validation —
unknown/non-string codes are 400 `INVALID_ENV_ERROR_SIGNAL`, never
silently ignored; (3) every use is audited
(`RUNTIME_ENV_ERROR_SIGNAL_USED`) and stamped on the run manifest's
driver; (4) the emitted record's narrative is qualified as
declared-not-observed ("DECLARED environment error … NOT observed by
probing a real host"), so no reader mistakes it for a measured host
fact. The negative control still holds when the signal is absent, and
the in-process true path (package-level, embedder-injected stepFn) is
untouched.

**Batch 80 — sweep asserts the positive leg in-file.** The S8 positive
leg moved into `first-run-walkthrough-needshuman.test.ts` itself (S8a
negative control retained, S8b operator + `envErrorSignal` →
ESCALATED with declared-not-observed narrative); the sweep tally is now
8/8 over HTTP (9 OPEN rows — the positive leg contributes one
`repeated-failure` alongside the `irrecoverable-env-error`). The
"7/8 fire" header above is the Batch-50 finding snapshot.

**F29 — Info (auth-mode walk hygiene).** The whole walk runs in auth mode;
every call carries the admin Bearer. The brute-force leg must fire its 10
bad requests back-to-back with no successful admin read between them (a
login clears the source counter). Doing S1 first makes the ordering
obvious; any later phase's admin reads only clear an already-spent
counter.

## Walkthrough: redaction → needs-human escalation leg (Batch 51)

Companion to the Batch 49 redaction leg. That leg observed exactly 2
detection events from its session and asserted NO escalation (below the
aggregation threshold) — this leg crosses it. Single `it`, pure HTTP,
zero mocks, real compiled server + real pty. Hermetic: temp DB + temp
`FACTORY_SECRETS_DIR`. Dual-mode: node builtins + fetch, zero src
imports.

One secret goes into the hermetic vault; a terminal session gets it as a
`secretEnv` ref. One input line runs four `printf '%s' "$VAR"` with
shell-side `sleep 0.7` between them, so the four full secret prints are
contiguous in the transcript but arrive as four separate pty data
events → four redactor pushes. With the Batch 48 cross-chunk carry
(`carryLen` = secret length − 1), the first push holds, the next three
each emit a hit, and the stream-close flush emits the last — 4
`SECRET_REDACTED_HIT` detection events for the one session, ≥ the
aggregation threshold (≥3 events in 5 min).

| Leg | What it asserts |
|---|---|
| E1 | ≥3 `SECRET_REDACTED_HIT` audit events for the session (the escalation precondition — asserted, not assumed), entityType `terminal`, never carrying secret content |
| E2 | `GET /api/needs-human?status=open` has exactly one OPEN `security-issue` row from `redaction-monitor:terminal:<sessionId>`, `requiredDeciderLevel: operator` |
| E3 | that row's `detailJson.narrative` carries the honest qualifier ("human judgment needed" — a single hit can be benign, the aggregated pattern is what escalates) and never carries secret content |
| E4 | the SSE stream has zero secret bytes (Batch 48 guarantee holds), redaction markers present, and `NEEDS_HUMAN_RAISED` is audited for the escalation row |

Verified 1/1 three consecutive runs (~7 s each; 4 detection events per
run). Note the trigger is the redaction monitor's own aggregation, not
`budget-exceeded` — it is the second §81 path after S1 whose "repeated
dumping" pattern escalates from detection events rather than a run
terminal state.

## Findings (escalation leg)

**F30 — Info (threshold semantics: events, not hits).**
`RedactionHitAggregator.noteHit` counts detection *events* (one per
`recordRedactionHit` call), not the summed hit totals — a push emitting
2 hits still contributes one event toward the threshold. The walk emits
four separate pty prints (not one big one) deliberately, so the event
count is what crosses 3.

**F31 — Info (escalate-once-per-pattern).** The aggregator's `escalated`
set means a source fires at most once per active pattern — the E2 leg
asserts exactly one OPEN row, and the walk never emits more than one
input line, so no second pattern exists to fire again. Window expiry
resetting (full age-out → may escalate again) is covered by the
package-level unit tests, not this walk.

## Walkthrough: audit-chain integrity leg (Batch 52)

The §32 hash chain (`packages/core/src/audit.ts`: `AuditLog.record`
stamps `prevHash`/`summaryHash`, `verifyAuditChain` re-derives) is the
core "append-only and immutable" invariant, but no walkthrough had ever
verified end-to-end that *tampering is detected*. Single `it`, pure HTTP,
zero mocks, real compiled server over a fresh temp SQLite file. Hermetic:
temp DB + temp `FACTORY_SECRETS_DIR`. Dual-mode: node builtins + fetch +
the real compiled `@ai-factory/core` dist, zero src imports.

| Leg | What it asserts |
|---|---|
| A1 | three real `POST /api/projects` → `GET /api/audit?limit=200` (bare array, newest first — the F21 contract) reversed to append order → `verifyAuditChain` returns `ok:true`, `legacyCount:0`, `verifiedCount` equal to the record count (fresh DB: every record is chained) |
| A2 | one middle record's `details` rewritten *directly in the SQLite file* via a second `node:sqlite` connection — the "attacker with DB access" the append-only design defends against; there is intentionally no HTTP mutation path → re-fetch → `verifyAuditChain` returns `ok:false` with `brokenAt` pinpointing the tampered record's index (found by id, not assumed), and `verifiedCount` equals exactly the records before the break |

Verified 1/1 three consecutive runs. The honest claim is
detection-not-prevention: the chain cannot stop a DB writer; it makes
the tamper evident and locates it.

**Batch 53 update:** this leg's "no HTTP verify endpoint" boundary has
been closed by `GET /api/audit/verify` (operator/admin — see
`requiredRoleFor` in `apps/server/src/auth.ts`). The endpoint verifies
the full chain anchored at genesis server-side and returns
`{ok, verifiedCount, legacyCount, brokenAt?}` (`brokenAt` indexes the
full append-order chain and is present only when `ok` is false).
Pagination is refused, not silently truncated: `?limit=…`/`?offset=…`
→ 400 `AUDIT_VERIFY_NO_PAGINATION` (F33 below is exactly why).
Contract pinned by `apps/server/tests/audit-chain-verify.test.ts`:
intact chain → `ok:true`; a record tampered directly in the SQLite file
→ `ok:false` with `brokenAt` pinpointing the record; pagination →
400; viewer → 403, operator → 200.

## Findings (audit-chain leg)

**F32 — Info (verify append order, not API order).**
`GET /api/audit` returns newest-first (F21 contract) while the chain
commits to append order (`ORDER BY ts, rowid` in the store). A verifier
feeding the raw API array to `verifyAuditChain` gets `brokenAt:0` on a
perfectly intact chain — the walk reverses the bare array first.

**F33 — Info (pagination truncates genesis).**
`limit` smaller than the chain length yields a suffix whose first
record's `prevHash` points outside the window → spurious `brokenAt:0`.
Empirically confirmed with a one-off probe: full chain of 20 records
verifies `ok:true`; `limit=2` on the same DB verifies `ok:false,
brokenAt:0`. **Closed by `GET /api/audit/verify` (Batch 53):** the
endpoint anchors at genesis and *refuses* pagination outright
(`?limit=…`/`?offset=…` → 400 `AUDIT_VERIFY_NO_PAGINATION`) instead of
verifying a truncated window — fail-closed, so no verifier can ever
receive a spurious break. Client-side verifiers still pulling the raw
array must fetch the whole chain (`limit` ≥ total).

**F34 — Info (second-connection write timing).**
The A2 tamper opens its own `node:sqlite` connection while the server is
idle between HTTP calls; a 10-attempt retry on lock failure is in place
because the lock state is timing-adjacent (never hit in practice — the
server holds no long write transactions on `audit_logs`).

## Walkthrough: audit-chain verify leg (Batch 54)

Batch 53 closed F33 by adding `GET /api/audit/verify` (operator/admin):
the server itself verifies its full §32 chain anchored at genesis and
returns `{ok, verifiedCount, legacyCount, brokenAt?}`. This leg is the
first-run proof that the endpoint behaves — single `it`, pure HTTP, zero
mocks, real compiled server over a fresh temp SQLite file. Hermetic:
temp DB + temp `FACTORY_SECRETS_DIR`. Dual-mode: node builtins + fetch +
`node:sqlite`, zero src imports.

| Leg | What it asserts |
|---|---|
| V1 | three real `POST /api/projects` → `GET /api/audit/verify` → 200 `ok:true`, `verifiedCount` ≥ 3, `legacyCount:0`, no `brokenAt` key (the endpoint verifies its own chain, anchored at genesis) |
| V2 | one middle record's `details` rewritten *directly in the SQLite file* via a second `node:sqlite` connection — the "attacker with DB access"; there is intentionally no HTTP mutation path → `GET /api/audit/verify` → 200 `ok:false`, `brokenAt` pinpointing the tampered record's append-order index (found by id via the F21 bare array reversed, not assumed), `verifiedCount` exactly the records before the break |
| V3 | `GET /api/audit/verify?limit=1` → 400 `AUDIT_VERIFY_NO_PAGINATION` — the fail-closed refusal that keeps F33's spurious `brokenAt:0` from ever reaching a verifier |

Verified 1/1 three consecutive runs (each ~2s). The honest claim is
unchanged: detection-not-prevention. The endpoint verifies the server's
*local* chain; it cannot stop a DB writer, it makes the tamper evident and
locates it. Contract also pinned separately by
`apps/server/tests/audit-chain-verify.test.ts` (4 tests: intact,
tamper, pagination refusal, role gating — Batch 53).

## Findings (audit-chain verify leg)

**F35 — Info (operator-role note).**
The walkthrough runs against the server's default auth mode (no tokens),
so V1–V3 don't exercise role gating. That axis is pinned by the
contract test (`viewer → 403, operator → 200`), and the desktop
`OpsPanel` button ("拉取全链验证") inherits the same gating — a viewer
session sees the server's 403 surfaced verbatim, not a fabricated
result.

**F36 — Info (verify is point-in-time, not a watch).**
`GET /api/audit/verify` attests the chain *at call time*. It does not
subscribe, and a tamper seconds after a successful verify goes unseen
until the next call — same boundary as the Batch 52 client-side leg,
now behind one HTTP call. Continuous attestation (periodic verify +
alert) is an operator policy choice, not something the endpoint claims.

**F37 — Info (brokenAt is an append-order index).**
`brokenAt` counts from genesis in append order (`ORDER BY ts, rowid`),
not the newest-first order `GET /api/audit` returns (F21). The endpoint
documents this, and the desktop button's red state quotes the boundary
verbatim — a consumer joining `brokenAt` against the raw array without
reversing will point at the wrong record.

**F38 — Info (periodic watch, default-on).**
F36 left continuous attestation as "an operator policy choice". Batch 55
makes the choice: `apps/server/src/audit-chain-watch.ts` — the server
verifies its own chain in-process every 60s
(`FACTORY_AUDIT_CHAIN_WATCH_INTERVAL_MS`; invalid values fall back to the
default; `FACTORY_AUDIT_CHAIN_WATCH=0` opts out). The tick calls
`audit.verify()` directly, never an HTTP loopback. Silent on success (no
audit spam). On a break it audits `AUDIT_CHAIN_VERIFY_FAILED`
(brokenAt/verifiedCount/legacyCount) and raises one §81 `security-issue`
needsHuman through the existing write-through path (`NEEDS_HUMAN_RAISED`,
or `NEEDS_HUMAN_PERSIST_FAILED` on failure — never throws). Dedup: at most
one OPEN per source, `list('open')` is the authority — a resolved record
re-raises on the next tick while the chain is still broken; no alert storm.
Default-on rationale (documented in the module header): detection-not-
prevention is an honest boundary only if detection actually runs; the check
is cheap (O(n) hashing) and silent when healthy, so fail-closed means on.
Verified: `apps/server/tests/audit-chain-watch.test.ts` 6/6 ×3 consecutive
(healthy silent / tamper raises exactly one with persisted narrative / no
storm / resolve-then-re-raise / builder / interval parsing); plus live boot
checks — tampered DB → 1 OPEN `security-issue` (source `audit-chain-watch`,
severity critical, operator) raised by the boot-time check; healthy DB → 0;
`FACTORY_AUDIT_CHAIN_WATCH=0` → disabled log line, nothing raised.
Boundaries unchanged: still detection-not-prevention; still the local chain
only (no third-party notarization).

## Walkthrough: audit-chain watch leg (Batch 56)

Batch 55 added the periodic self-check (F36): the server verifies its
own chain in-process — once at boot plus a 60s `setInterval` — and
raises one §81 `security-issue` needsHuman when the chain breaks. The
module-level contract is pinned by
`apps/server/tests/audit-chain-watch.test.ts` (6/6), but that test
calls `tickAuditChainWatch` directly. This leg pins the **real startup
path**: the actual compiled server process is booted (the boot-time
check is the same `tickAuditChainWatch` `index.ts` calls at top level),
the DB is tampered out-of-band, and the server is rebooted — pure HTTP,
zero mocks, fresh temp SQLite files
(`first-run-walkthrough-audit-chain-watch.test.ts`, hermetic +
dual-mode, temp `DB_PATH` + `FACTORY_SECRETS_DIR` +
`FACTORY_PROJECTS_ROOT`, no tokens).

| Leg | What the walkthrough does |
|---|---|
| A | healthy DB boot + three real `POST /api/projects` → `GET /api/needs-human?status=open` → **0 items** (the watch is silent on success — no audit spam) |
| B | tamper a middle record via a second `node:sqlite` connection (the "attacker with DB access"; done while the server is up, then stop) → reboot the same DB → boot check raises **exactly 1** OPEN `security-issue` (`source=audit-chain-watch`, `severity=critical`, `requiredDeciderLevel=operator`, honest narrative persisted in `detailJson` — says BROKEN, asks for human judgment, states the append-order index, carries no injected payload) |
| B2 | reboot a third time while still broken → **still exactly 1** OPEN (dedup: `list('open')` is the authority — no storm; `AUDIT_CHAIN_VERIFY_FAILED` written exactly once) |
| C | fresh DB, same tamper, reboot with `FACTORY_AUDIT_CHAIN_WATCH=0` → **0 OPEN** (the watch does not run); control: `GET /api/audit/verify` → `ok:false` on the same DB, proving 0 OPEN is the opt-out, not a failed tamper |

Verified 1/1 three consecutive runs (each ~9s; boots + HTTP only).

Path choice (recorded honestly): this test boots the real server
process rather than calling `tickAuditChainWatch` at module level
because the claimed behavior is "the server self-checks on boot" — the
closest path to the claim is an actual boot. The 60s interval timer is
live with defaults during the test; every assertion is robust to an
extra tick because dedup keeps OPEN ≤ 1 and the failure evidence is
written once (the repeated-boot check in B2 is the no-storm proof on
the real path).

## Findings (audit-chain watch leg)

**F39 — Info (boot-path fidelity note).**
The walkthrough boots `apps/server/dist/index.js` as a child process,
so it proves the boot-time check that ships — not just the exported
function in isolation. Cost: the leg is slower than module-level tests
(~9s vs ~1s) and exercises process startup, SIGTERM handling, and
port rebinding — all real operational surface, which is the point of a
first-run walkthrough.

**F40 — Info (WATCH=0 control).**
C's control leg (`GET /api/audit/verify → ok:false` on the tampered
DB with the watch off) is what makes "0 OPEN" meaningful: without it,
a no-op tamper would be indistinguishable from a disabled watch. Any
future opt-out or flag test for the watch should keep a broken-chain
control assertion.

---

## Walkthrough: usability-fix screenshot leg (Batch 58)

Batch 57-3 audited the desktop for "usable" (36 panels read, 60+ endpoints
grep-verified to exist, 18 files fixed for swallowed errors /
double-submit / misleading empty states) but only ran `tsc` — no
real-machine check. This leg puts the Batch 57-3 fixes on a real
machine: repo Electron binary + vite dev renderer + real compiled
server + xvfb, `--no-sandbox`, fresh temp DB/secrets/projects.

| Leg | What the walkthrough does |
|---|---|
| D1 | NeedsHuman panel: **verified** — "当前没有 OPEN 的升级记录" + honest empty-state copy (the 8 §81 triggers listed, so empty list ≠ disabled mechanism); audit-chain watch is on and healthy, so silence is the correct state |
| D2 | QaPanel `orgErr`: **verified** — an in-page `window.fetch` patch rejects `/qa/org` at the network layer (the component's real `.catch → setOrgErr` path; component code untouched); the panel shows a red pill 「⚠ QA org 加载失败：…」 instead of the old permanent "Loading QA org…"; rest of the panel (Categories, Run QA) renders normally |
| D3 | Approvals row-level busy: **not covered** — blocked by a real bug. A real PENDING approval was created over HTTP (`7bde6eff…`, HIGH, "deploy production", verified in place via `GET /api/approvals`); clicking the Approvals tab waited 20s for the Approve button and instead the whole React tree unmounted (black screen, empty `body.innerText`) |

D3's crash is the walkthrough's real catch, not a gap: see F41.

## Walkthrough: AppImage main-window screenshot (Batch 58)

Batch 57-4 verified the Linux AppImage package boots to a main window +
healthy backend but took no screenshot. This leg launches the
`~/appimage-out/linux-unpacked` tree (Batch 57 product; no FUSE here, so
the unpacked tree, not the `.AppImage` itself) under xvfb with a fresh
`HOME`/`DB_PATH`/`FACTORY_SECRETS_DIR`/`FACTORY_PROJECTS_ROOT` and
captures the main window via CDP `Page.captureScreenshot`.

The CDP page target is `file:///…/linux-unpacked/resources/app.asar/apps/desktop/renderer/index.html` — the **built dist** renderer, not
the vite dev server. That is the key difference from the B51/B52/B54
real-machine screenshots. The screenshot shows the real factory home:
"AI FACTORY" top bar, Project: MyApp, 6 Agents, "本地模式（无令牌）",
"● Running", the full tab bar, the AI ORG tree, SKILLS/MCP/KNOWLEDGE
stub badges, and a live AI Activity stream with real audit events
(`PROJECT_CREATED`, `PROJECT_SEEDED`, `WORKFLOW_TRANSITIONED`).

## Walkthrough: ApprovalsPanel response-shape fix (Batch 58-5) and post-fix walkthrough (Batch 59-2)

The root-cause fix for F41 (desktop only, zero server changes):
`RawApproval` interface + `toApprovalItem()` snake_case→camelCase
mapping applied on all 5 paths (`list/get/request/decide/cancel`,
including the `{ approval }` wrapper on decision/cancel):
`id←approval_id`, `requestedBy←requester`, `taskId←task_id`,
`riskLevel←risk_level`, `requiredApprover←required_approvers.join(', ')`,
`agentId←''` (the server has no such field), `evidenceIds←[]` (the
server only has `evidence_manifest_hash`), `status` extended with
`'INVALIDATED'` (a real server status the panel's union lacked),
`decidedBy←decided_by`, `createdAt←created_at`, `decidedAt←decided_at`,
`expiresAt←deadline`. Defensive guards: `(a.evidenceIds ?? []).length`.
Plus `ApprovalsErrorBoundary` in the same file (no new files): a panel
render failure now shows a red error card instead of taking the whole
tree down.

The post-fix walkthrough (real Electron+Xvfb+vite dev+real server)
closes the 58-2 gap: a real HIGH-risk PENDING approval
(`630313ac…`, "deploy production (b59-2 walkthrough)") created over
HTTP, then Approvals tab → **no crash** (card renders `HIGH`, requester,
task id, approver, three buttons in place); Approve → **row-level busy
captured** (all three buttons "处理中…" disabled; network-layer 2.5s
delay to make the busy state photographable, component code untouched);
decision → Pending (0), History (1), `APPROVED … 10/15/2026, 2:20:15 AM`,
real `APPROVAL_DECIDED`/`APPROVAL_EVIDENCE_ATTACHED` in AI Activity, and
`GET /api/approvals?status=PENDING → []` confirms the queue drained.

## Walkthrough: response-shape compatibility audit (Batch 59)

F41 showed the B57-3 audit's blind spot: endpoint-existence checks do
not cover response-shape compatibility. This audit closes it: all 38
desktop panels were read against real server responses — a real compiled
server seeded with real data (tasks, a HIGH-risk approval, memory
entries, evidence), 20+ GET endpoints probed for their actual JSON keys,
each panel-local type assertion checked, server source cross-confirmed
for variable shapes.

One more real bug of the F41 class was found (see F44): QaPanel
crashed the whole tree on failed QA runs. Fixed on both ends
(`apps/server/src/routes/qa.ts` + `QaPanel.tsx`). The other 37 panels
are clean (spot-verified in place, including `ManagerPanel`'s correct
snake_case use of `QueueApproval`, `OpsPanel`'s `control_epoch` /
`updated_at` snake_case, and `ObservatoryPanel`'s `?? {}` +
`Array.isArray` guards). Residual low risks recorded in F48.

## Findings (usability / response-shape legs, Batch 58–59)

**F41 — High: ApprovalsPanel whole-tree crash on real approval data (closed B58).**
The panel's own `createApprovalsApi` defined a camelCase `ApprovalItem`
contract and asserted it with a type — but `GET /api/approvals` returns
the manager's native snake_case `Approval` (`approval_id`, `requester`,
`risk_level`, `task_id`, … — 20 keys, re-verified by the Batch 58
re-auditor, with no `evidenceIds` and no `agentId`). `a.evidenceIds.length`
on `undefined` threw, and with no error boundary the entire React tree
unmounted — a black screen, no recovery except reload. The B57-3
"zero 404 dead buttons" conclusion only proved endpoints *exist*; a
green `tsc` proved nothing because the mismatch hides behind a type
assertion. This is the class of bug only a real-machine walkthrough
catches.

**F42 — Info (packaged-renderer screenshot).**
The AppImage main-window screenshot is the first screenshot of the
*packaged* renderer — built dist, CDP-verified — rather than the vite
dev renderer used in earlier real-machine legs. Keep this distinction
when citing screenshots as evidence.

**F43 — Info: post-fix walkthrough closes the 58-2 gap (closed B59).**
The 58-5 mapping + guards + error boundary were verified on a real
machine: no crash, correct field mapping, row-level busy ("处理中…",
three disabled buttons), and a complete approve→decided loop with real
audit events. The 58-2 "black screen after 20s" phenomenon is gone;
`ApprovalsErrorBoundary` never triggered, which is the desired outcome
for a safety net.

**F44 — High: QaPanel whole-tree crash on failed QA runs (closed B59).**
`qa.runQa()` → `POST /api/qa/runs` → `loop.execute(factory)` throws →
the server wrote `record.summary = { error: message }` →
`setRun(r)` → the panel's `{run.summary && ...}` guard passes an
`{error}` object → `run.summary.categories.map` on `undefined` →
TypeError → whole tree down. Same failure class as F41 (fabricated
contract + no error boundary), found because the 59-3 audit probed
*response shapes* instead of endpoint existence. Fixed on both ends:
the server's failure summary now matches the success shape plus an
`error` field; the panel renders a red pill and guards with `?? []`.
desktop tsc 0, server tsc 0.

**F45–F48 — Info/low hygiene:** F45 (`/tmp` 512MB tmpfs: reroute AppImage
staging and heavy SQLite work to `$HOME`); F46 (no FUSE: the
`.AppImage` itself cannot execute here, linux-unpacked runs the same
code); F47 (SIGKILL of the packaged main leaves the spawned backend
reparented — kill it by exact PID); F48 (open, low: `/api/projects`
returns snake_case bare rows; the desktop `Project` interface only
reads `id`/`name`/`description`/`path` — silent `undefined` risk if
`project.createdAt` is ever read).

## Walkthrough: packaged full Electron walkthrough (Batch 61-2)

The two 60-5 fixes, verified in the real packaged path instead of the
HTTP+code-logic layer: Electron with `NODE_ENV=production` (so
`electron/main.ts` takes the packaged branch — `loadFile` + spawn the
backend), the renderer loaded from the compiled dist (a temporary
`apps/desktop/renderer -> dist` symlink, removed after the walk), and a
real compiled server on `PORT=32111` over a fresh HOME/DB/secrets tree
(`~/b61-2/`, avoiding the `/tmp` tmpfs).

(a) **PORT=32111**: the page URL was
`file:///.../renderer/index.html?apiPort=32111` — `apiPort` injected via
`loadFile(..., { query: { apiPort: String(API_PORT) } })` works in the
packaged path; `window.location.search = ?apiPort=32111` and
`defaultApiBase()` resolved to `http://localhost:32111/api`. The
dashboard rendered fully (6 active tasks, 1 running agent, AI ORG
tree, real audit events) with **no "Cannot reach" banner and no
Offline**. Boundary noted: an *unpacked-repo* electron's own backend
spawn fails (`resourcesPath` has no server — that layout only exists in
the packaged tree, where 58-3/60-4 already verified the spawn works), so
this walk used a manually started backend.

(b) **Race simulation**: killing the backend and `location.reload()`
faithfully reproduces a mount-time "backend not listening" — the red
banner read **"Cannot reach the local API at
http://localhost:32111/api — is the backend running? (Failed to
fetch)"** + ● Offline. The banner text uses the *parsed* `API_BASE`
(32111), not the old hardcoded 3100 — this incidentally verifies the
60-5 copy fix. Restarting the backend cleared the banner, restored
● Running, and re-rendered the dashboard with fresh audit events — the
2-second retry on `bootError` works. Note: killing the backend *after*
a successful start only produces panel-level "Failed to fetch" pills,
never the App banner — the banner path is mount-time `refresh()`, so
the reload simulation is the faithful race reproduction. A residual
"审计日志加载失败" pill in BottomPanel after recovery is that panel's
own error state, unrelated to the App-level banner fix.

## Walkthrough: desktop interaction walkthrough (Batch 61-4)

The remaining interaction gaps (60-4 only clicked Dashboard/NeedsHuman/
Ops) closed on a real machine: real compiled server (fresh
`~/b61-4/` tree) + vite dev + repo Electron + Xvfb :93, driving real
`executeJavaScript` handlers and `win.capturePage()` screenshots.

- **Board drag**: a synthetic HTML5 drag (dataTransfer stub, through
  React's real `onDragStart`/`onDrop` handlers) moved an IN PROGRESS card
  (`#8a5d5183`) to CODE REVIEW. The gate fired as designed: red toast
  "⛔ 门禁拒绝（缺证据）: Code change artifact (commit/PR) — missing"
  and a real `WORKFLOW_TRANSITION_DENIED` event in AI Activity. The
  server behavior was pre-verified via curl (422 + `GATE_DENIED`) —
  UI and server are consistent.
- **Real QA run** (default unit category): verdict **PASS**,
  attempts=3 — attempt 1 hit the demo sample's deliberate off-by-one
  (`PRODUCT_FAILURE`) → auto-fix → attempts 2/3 passed; no red pill
  appeared, and `QA_RUN_COMPLETED` is in the activity stream. This also
  exercises the F44 fix under success conditions.
- **Approvals regression**: a real HIGH approval (201) created over
  HTTP → the panel rendered Pending(1) with req/task/expiry and the
  three buttons — no crash (post-F41-fix regression confirmation; the
  approve→decided loop was already walked in 59-2).

Boundaries: Linux+Xvfb dev mode, not the packaged AppImage; the drag
is a synthetic event (not a mouse), but it goes through the real React
handlers and the real API; only one card dragged, only the default QA
category run, and Approvals was render-only here (decision loop covered
in 59-2). dbus noise is the usual headless benign output.

## Findings (packaged / interactive legs, Batch 61)

**F50 — Info: 60-5 fixes verified in the real packaged path (closed B61).**
`apiPort` query injection via `loadFile` works — `PORT=32111` gives a
fully rendered dashboard with no Offline. The race simulation confirms
the App banner uses the parsed `API_BASE` (32111, not the old hardcoded
3100) and that the 2-second retry clears the banner and restores
● Running. Both 60-4 findings are now closed end to end: the packaged
path no longer needs the "mount-once" assumption and no longer assumes
port 3100.

**F51 — Info: remaining interaction gaps closed on a real machine (closed B61).**
Board drag → gate toast + `WORKFLOW_TRANSITION_DENIED` (UI matches the
server's 422 `GATE_DENIED`); real QA run PASS with the attempts=3
auto-fix chain and no red pill; Approvals regression shows no crash.
Desktop real-machine PNG evidence is now 24 total (the 9th
sellable-checklist re-verification counted 17 through Batch 60; Batch
61 adds the 3 b61-2 + 4 b61-4 PNGs).

---

## Walkthrough: invariant-coverage / gap-closure legs (Batch 62–65)

The B62-3 sweep read every SPEC_V2 invariant (INV-01–INV-35) against
tests and walkthroughs: 24 pinned, 11 real gaps (G1–G11). Each gap was
then closed with a walkthrough or pinned test in B62–B64; the 10th
sellable-checklist re-verification (B65) independently re-ran the G8
leg. No new walkthrough legs were needed for desktop — the remaining
desktop evidence is the packaged + interaction legs from B61.

**INV coverage sweep (62-3).** `gap-audit/INV_COVERAGE_SWEEP.md`: honest
yardstick — an invariant counts as covered only if a test or a
walkthrough pins it, never because code exists. 24/35 listed with the
pinning test file + one-line evidence each; G1–G11 real gaps with a
priority order (G9 > G8 > G6 > G10, then by verification cost). Spot
checks the sweep asserts: `runner.ts`'s `adapter.invoke` really did
send the prompt unscreened before 63-2, and `loop.ts:268`'s auto-
governance really was a comment-level promise before 64-2.

**F48 close (62-2).** `/api/projects` returns snake_case bare rows
(`created_at`, …); the desktop `Project` interface only read
`id`/`name`/`description`/`path` — safe today, but a future
`project.createdAt` would be silent `undefined` (the F41 class). Fixed
desktop-side (58-5 pattern): the server keeps its §6.1 native snake_case
contract (renaming it would be a breaking API change); the desktop got
`RawProject` (documents the native shape) + `toProject()` with
defensive fallbacks, and `api.projects()` maps every row through it.
Verified against a real server response (the probe's `createdAt`
mapping was a real timestamp) and projects tests 16/16.

**G9 pre-send secret scanning (63-2).** `scanForSecrets` (from
`@ai-factory/memory`) is now called on the assembled prompt in
`defaultStepFn`'s ACT phase, *before* `tracker.consumeModelCall()` and
*before* `adapter.invoke`: a secret in the prompt → fail-closed
`{ ok: false, errorSignature: 'adapter:secret-in-prompt' }`, the adapter
is never invoked and the model-call budget is not consumed. The prompt
is deterministic, so the signature can't be retried away — three
consecutive identical signatures escalate via `LoopStagnation`. The
error text carries only the signature and the spec reference, never
the secret value. Test: 2/2 (secret prompt → adapter called 0 times,
outcome escalated, no secret value in the trace or the escalation
reason; clean prompt → adapter called, outcome completed), runtime
package 176/176. Boundary: the run trace still logs the user's own
task text verbatim (pre-existing user-input logging — full-chain
desensitization is a separate item); git-commit scanning out of scope.

**G8 exec-confinement (63-3).** `apps/server/tests/first-run-
walkthrough-exec-confinement.test.ts`, A–C on a real compiled server
over pure HTTP: A `actor='agent'` + a legal command → 403
`CONFINEMENT_UNAVAILABLE` (message names the unverified confinement),
`GET /api/audit` shows `EXEC_DENIED` (`details.reason =
CONFINEMENT_UNAVAILABLE`), and zero `EXEC_RUN` (the command never
executed); B `actor='human'` + the same command → 200 with correct
output; C `actor='agent'` + `rm -rf /` (a deny-pattern command) → still
`CONFINEMENT_UNAVAILABLE`, not `POLICY_DENIED` — the walk pins the
fail-closed order (confinement check runs before the command-policy
check in `routes/exec.ts`). 1/1 ×3. Boundary, stated in the test file
header: what is pinned is the *refusal*; `UnverifiedBackend.
verifyConfinement()` always returns `verified:false` because this host
has no real OS isolation — proving subprocess-level OS isolation
remains a hard gate.

**G6 version pins (63-4).** `RunManifestVersionPins` (`employee_version`
/ `organization_version` / `policy_version` / `requirement_version`)
are recorded at run creation on both `POST /runs` and resume; a db
migration backfills pre-pin rows (`NULL` = not recorded, never
fabricated). Verified: build 0, `npm test` 2520/2520 (baseline 2517 +
3, arithmetic checked), smoke:boot OK.

**G10 auto-governance (64-2).** `apps/server/tests/first-run-
walkthrough-auto-governance.test.ts` on a real compiled server over
pure HTTP, 1/1 ×3: a healthy case → 0 governance decisions; a failing
case → 3 decisions (disable the failing version, downgrade autonomy,
switch to the approved fallback) with a real `AUTO_GOVERNANCE_APPLIED`
audit; a case pinned on v1 stays on v1; a new case trying to activate
the disabled v2 → 422 `DISABLED_VERSION`. The mechanism: pure
`evaluateAutoGovern` policy fn (deterministic thresholds: ≥1 failure
observation or independent-eval failure → disable-version; ≥2 trailing
failures or independent-eval failure → downgrade-autonomy; disabled
version + approved non-disabled fallback → switch-to-fallback; idempotent
and authorization-free by construction) + `VersionRegistry`
(ACTIVE/DISABLED, POLICY_APPROVAL marks fallback eligibility, effect
records kept on disable). A test-caught fix: observations carry
`version` tags so old failures can't disable a new version. Tests:
16/16 policy fn, 6/6 loop, evaluation package 118/118 ×3. Boundaries:
the downgrade decision is recorded in the admission trail but the
autonomy store itself is not rewritten (the evaluation package doesn't
cross-package write); thresholds are documented engineering choices,
not spec numbers.

**Small-gaps trio (64-3).** Zero product-code changes — pure tests on a
real compiled server over pure HTTP. `board-drag-transition.test.ts`
5/5 ×3: only `POST /transition` changes state — bare `status`/`stage`
writes → 400, `status`/`stage` smuggled next to a legal `to` are
ignored, `GET`/`PUT /transition` are unrouted (404), an illegal jump
(TODO→DONE) → 422 `UNKNOWN_TRANSITION` with the DB row untouched and
`WORKFLOW_TRANSITION_DENIED` in the audit. `git-merge-queue-broker-
gate.test.ts` 2/2 ×3: `FACTORY_GIT_BROKER_ACTIONS=read,branch,commit`
(no merge) → 403 `GIT_BROKER_DENIED` with zero side effects (no queue
entry, target tip byte-identical); the control (default allowlist) →
202 enqueue. `product-authority-default.test.ts` 1/1 ×3: product-direction
proposals are filed `WAITING_HUMAN_DISPATCH` (never silently
authorized); `via=POLICY` without a Rule ID → 400; a waiting proposal
sent to `POST /api/runtime/runs` → 403 `TASK_NOT_AUTHORIZED` with zero
run records; `via=HUMAN` dispatch → AUTHORIZED, then the run returns
202.

**Data-export / release / finding / QA-gate (64-4).**
`runner-data-export.test.ts` 5/5: `dataExportEventFor()` is a pure fn
(local → null, cloud → event with provider/privacy, unknown provider →
recorded `'unknown'` fail-safe); `runAgent` integration — a public+coding
route to `shared:code-coder` → adapter invoked once + exactly 1
`DATA_EXPORT` evidence event; a sensitive route to `local:local-private`
→ adapter invoked once + 0 events. `release.test.ts` +7 (49/49):
`Release.requirementRef` (`REQ-001@2` form, recorded at creation,
never invented), deploy Gate 2b — release pin vs evidence pins
mismatch with no compatibility statement → fail-closed
`RELEASE_EVIDENCE_MISMATCH`; with an explicit statement → allowed +
`RELEASE_COMPATIBILITY_DECLARED`. `task-dispatch.test.ts` +4 (12/12):
`TaskManager.reportFinding()` — evidence required (empty array throws),
`TODO` + `WAITING_HUMAN_DISPATCH`, never directly AUTHORIZED. `org.
test.ts` +5 (12/12): `QaCreationGate` opt-in policy gate —
`enforcePolicy` denial → `GovernanceError` with zero registration;
without a gate the behavior is unchanged. Boundaries: the DATA_EXPORT
event is evidence-level audit, not an approvals authorization ticket;
the compatibility statement is caller-provided (recorded, not
verified); the server `qa.ts` route doesn't pass a policy yet (project
policy store doesn't exist).

**10th sellable-checklist re-verification (65-2).**
`gap-audit/SELLABLE_REVERIFY_BATCH64.md`: 14 items flipped green since
the 9th round (biggest: INV coverage 24/35 → 35/35), 0 new real gaps;
the G8 leg was independently re-run 3/3 (real compiled server, 16.7s).
Verdict: still "working prototype + converging", not a shippable
product — the 13 hard gates are all still on Tan/environment side, and
there is no delegable code-side path left.

## Findings (gap-closure legs, Batch 62–65)

**F52 — Info: SPEC_V2 invariant coverage is now 35/35 (closed B64).** The
B62-3 sweep found 24/35 pinned and 11 real gaps G1–G11; every gap is
closed with code+tests (or pinned tests) by Batch 64: G9→63-2,
G8→63-3, G6→63-4, G10→64-2, G1/G2/G5→64-3, G11/G7/G3/G4→64-4. The
sweep's yardstick stays: pinned by a test or a walkthrough, never by
code existing.

**F53 — Info: G9 honest boundary (open).** The pre-send scan covers the
`adapter.invoke` path and fails closed — but the run trace still logs
the user's own task text verbatim (a pre-existing user-input logging
behavior, separate from the adapter send path), so full-chain
desensitization is a standalone follow-up; git-commit scanning was out
of scope.

**F54 — Info: G8 honest boundary (open).** What the walkthrough pins is
the *refusal*: `UnverifiedBackend.verifyConfinement()` always returns
`verified:false`, and `POST /api/exec` refuses non-human actors before
it ever consults the command policy. There is no real OS isolation on
this host — proving subprocess-level isolation remains a hard gate.

**F55 — Info: Batch 63 shared-worktree incident (hygiene).** 63-4 ran
`git stash -u` on the shared main tree (repeating the B39/B43 iron-rule
violation) to check a test-count arithmetic, sweeping up G9/G6 sibling
work, 63-3's new test file, and the untracked CI workflow file. 63-3
noticed its file missing, found the stash via reflog; recovery was
`git checkout stash@{0} -- <8 tracked>` + `git checkout stash@{0}^3 --
<untracked>`, every file diffed byte-identical against the stash
versions, the CI file reset to untracked, and the stash dropped only
after verification. Zero files lost. The lesson is nailed into
AGENTS.md: every spawn brief must restate the no-stash rule.

**F56 — Info: G10 honest boundaries (open).** `downgrade-autonomy` is
decided and recorded in the admission trail, but the autonomy store
itself is not rewritten — the evaluation package doesn't cross-package
write, and the server doesn't pretend to execute it. The observation
thresholds (1 failure → disable, 2 consecutive → downgrade) are
documented engineering choices, not spec numbers.

**F57 — Info: G4 honest boundary (open).** `QaCreationGate` is opt-in;
the server `qa.ts` route doesn't pass a policy because the project
policy store doesn't exist yet, so server-path auto-creation is still
ungated. The mechanism exists and is pinned by tests; wiring it in is
a follow-up.

**F58 — Info: G11 honest boundary (hygiene).** `DATA_EXPORT` is an
evidence-level audit record, not an approvals-package authorization
ticket; a real pre-send export authorization ticket needs approvals
integration (follow-up). (Batch 80, 2026-10-16: the follow-up landed in
RECORD mode — `packages/runtime/src/export-approval.ts`
(`attachExportAuthorization`) creates a PENDING `data_export` approval
ticket in @ai-factory/approvals BEFORE `adapter.invoke` on the non-local
path, linked bidirectionally with the DATA_EXPORT evidence event
(`evidence.payload.approval_id` → ticket; the ticket's
`APPROVAL_REQUESTED` audit details carry `evidence_id`), plus an explicit
`DATA_EXPORT_AUTHORIZATION_RECORDED` audit event; the call is NOT blocked
and UX is unchanged. Blocking-mode gating remains Tan's product decision
— F58 stays open pending it.)

**F59 — Info: this machine has no `/dev/null` (hygiene).** `mknod` is
blocked by the container, so a regular file stands in (625 bytes and
accumulating, not auto-discarded) to keep git working. Environment
issue, unfixable from here.

**F60 — Info: G2 mechanics boundary (hygiene).** Build-runner's git
subprocess is downstream mechanics of a broker-authorized merge
decision — gating it again would be double-gating the same decision
(noted in the test file header).

**F61 — Info: G5 honest boundary (closed B75).** v1 `POST /transition`
didn't check the §17.2 axis (Board still runs on v1); changing v1 was a
product decision affecting Board UX. Tan decided 2026-10-15 21:15 +08
(decision card "A A A") to add the check — done in B75: the v1 handler
refuses non-AUTHORIZED tasks with 403 `TASK_NOT_AUTHORIZED` (the G5 gate
shape), legacy rows read AUTHORIZED so the default Board path is
unchanged. Board drag UX change: dragging an unauthorized task now
shows a dedicated "⛔ 未授权（§17.2）…请先在 Dispatch 页签完成派发"
toast; documented in KNOWN_LIMITATIONS (§17.2 entry, Batch 75).

**F62 — Info: G7 honest boundary (hygiene).** The compatibility
statement is caller-provided — the system records and audits it
(`RELEASE_COMPATIBILITY_DECLARED`), never verifies its truth.
