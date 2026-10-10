# AI Engineering Factory IDE — Prototype

Runnable prototype skeleton of the **AI Engineering Factory IDE** product spec
(`~/workspace/user/files/AI_factory.txt`). Local-first: React UI + Node.js API
+ SQLite, no cloud, no login.

## Quick start

```bash
cd ~/workspace/ai-factory
npm install
npm run dev        # builds everything, then starts API (:3100) + UI (:5173)
```

Open http://localhost:5173. The backend seeds a demo project (`MyApp`),
a 6-agent AI organization, and 6 tasks on first run (`./data/factory.db`).

| Command | What it does |
|---|---|
| `npm run dev` | Build all + start API (`:3100`) and Vite UI (`:5173`) |
| `npm test` | Build all domain packages, run 636 unit tests (`node --test`) |
| `npm run demo` | Evidence-chain demo: task TODO → DONE with a gate **denial** in the middle |
| `npm run demo:qa` | QA-loop demo: test FAIL → classify → fix → rerun → PASS |
| `npm run demo:cicd` | Pipeline demo: 8 stages → UAT, PROD parks on approval → resume → SUCCEEDED; failed deploy → auto-rollback |
| `npm run demo:skills` | Skills demo: clean install → risky install blocked → discovery → single-skill instruction load |
| `npm run demo:memory` | Memory demo: dedup merge, expiry, confidence decay, verify, lessons from evaluation |
| `npm run demo:projects` | Projects demo: discover → template create → whitelisted exec |
| `npm run demo:review` | Review demo: tainted diff → CHANGES_REQUESTED, clean diff → PASS |
| `npm run demo:release` | Release demo: UAT deploy → PROD denied w/o approval → approved deploy → unhealthy auto-rollback |
| `npm run demo:policy` | Policy demo: override denied → effective policy → YAML validation |
| `npm run build` | TypeScript build (all packages + server) + Vite production bundle |
| `npm run build:electron` | Compile the Electron main process (`apps/desktop/dist-electron/`) |
| `npm run electron` | Launch the Electron shell (needs `npm i -D electron` first — binary not bundled) |

Node ≥ 22 required (uses the built-in `node:sqlite`, no native addons).

## Architecture

```text
apps/desktop            React + TypeScript UI (spec §3 layout)
  ├─ src/components     TopBar · Sidebar (org tree §84) · Board (§85) ·
  │                     BottomPanel (activity/terminal/tests/logs) · CreateTaskModal
  └─ electron/main.ts   Electron main process (spawns local backend)

apps/server             Zero-dependency node:http JSON API (:3100)
  └─ src/index.ts       /api/projects · /api/tasks · /api/tasks/:id/transition ·
                        /api/tasks/:id/evidence · /api/agents · /api/org ·
                        /api/board · /api/audit
  └─ src/routes/        Modular route handlers (each returns true when handled):
                        git.ts (§34) · qa.ts (§36–38) · approvals.ts (§45, §69)

packages/git             Git engine (§34): GitRepo wraps the git CLI (status,
                        diff, branch, checkout, commit, stash, merge, rebase,
                        push, pull, tag, log), task-branch helper
                        (`task/<id>-<slug>`), branch protection (main/master
                        deny direct push), in-memory PR records; commits attach
                        `code_change` evidence, PR merges attach `merge` evidence.

packages/qa              QA engine (§36–§38): QA org on the agent registry
                        (QA Lead + Functional/API/E2E/Regression/Performance/
                        Security specialists), category test runner producing
                        §37 machine-readable results, failure classification
                        (PRODUCT/TEST/ENVIRONMENT/INFRA/AI/UNKNOWN), and the
                        §38 failure loop (classify → owner → fix → rerun →
                        regression). QA runs attach `qa_result` evidence.

packages/approvals       Approval system (§45, §69): request/decide/cancel/
                        expiry lifecycle, tool approval levels (AUTO /
                        AI_REVIEW / HUMAN_APPROVAL / BLOCKED) with policy
                        evaluation, SQLite-backed store (migrates the existing
                        `approvals` table). Granting a prod approval attaches
                        `approval` evidence — the PENDING_PROD → PROD_DEPLOYING
                        gate (§41) requires it.

packages/db             SQLite persistence (node:sqlite), spec §100 core tables:
                        projects · tasks · agents · workflows · runs ·
                        artifacts · evidence · approvals · audit_logs

packages/core           Pure TypeScript domain layer (no I/O — unit-testable)
  ├─ workflow.ts        State machine: §11 default flow + exception states,
  │                     §12 gates (evidence requirements per transition)
  ├─ engine.ts          requestTransition(): agents *request*, engine *decides* (§13, §92)
  ├─ evidence.ts        Evidence engine: DRAFT → SEALED, immutable once a gate
  │                     consumes it (§42 — "evidence beats claims")
  ├─ tasks.ts           Task object (§8) + subtasks + dependency graph w/ cycle
  │                     detection (§60)
  ├─ agents.ts          Agent registry: autonomy levels 0–5 (§17), capability
  │                     permissions (§44 subset), least-privilege role defaults
  │                     (§2.5), org tree builder (§84)
  └─ audit.ts           Append-only immutable audit log (§70)
```

### The core principle, in code

```text
AI requests transition  →  engine checks gate  →  evidence present & verdicts ok?
        │                                                     │
        │ yes: seal evidence, move state, audit               │ no: DENY + list exactly
        ▼                                                     ▼   what is missing
```

Try it live: open a task card in QA → click `→ PENDING_UAT_MERGE` → watch the
denial name the missing `security_report`, attach it, retry, and it passes.

## Implemented (prototype)

- **Workflow engine** (`packages/core`): full §11 state graph (12 happy-path +
  8 exception states), per-transition evidence gates (§12), denial messages
  naming missing evidence, unknown-transition rejection.
- **Task system**: §8 core fields, subtasks, §60 dependencies with cycle detection.
- **Evidence engine**: §42 immutability — sealed evidence throws on update/delete.
- **Agent registry**: §15–17 fields, autonomy 0–5 validation, §44 permission
  subset with least-privilege role defaults, org tree (§84).
- **Audit log**: §70 append-only, no update/delete API.
- **SQLite schema**: §100 core tables (projects, tasks, agents, workflows,
  runs, artifacts, evidence, approvals, audit_logs).
- **REST API**: projects/tasks/evidence/agents/org/board/audit; transition
  endpoint returns `422 + missing[]` on gate denial.
- **React IDE shell** (§3): top bar (project · agent count · status), left rail
  (project tree · AI org · skills), center tabs (task board §85 · **Git panel** ·
  **QA panel** · **Approvals panel** · **CI/CD panel** · **Skills panel** ·
  **Memory panel** · **MCP panel** · **Knowledge panel** · **Evaluation panel** ·
  **Agents panel** · **Orchestrate panel** · editor placeholder ·
  **Stability panel** (§61–63, §71–80, §96–97)), bottom (AI activity from audit
  log · terminal/tests/logs). Create-task modal.
- **Organization 可视化图 (§84)** — `OrgGraph.tsx`: Agents 页签"列表/图谱"切换；
  SVG 树形图 HUMAN→PM→…，节点按状态着色（在线绿/空闲灰/工作中蓝/阻塞橙/
  失败红/暂停紫/归档暗），点击节点详情浮层（可跳转 §87 员工档案），
  支持缩放（40–200%）+ 状态图例。
- **Task Board 完整版 (§85)** — `Board.tsx`: 12 happy-path 列（TODO…DONE）
  + BLOCKED/FAILED 异常列（终态 CANCELLED/REJECTED/ESCALATED 并入 DONE，
  ROLLBACK 并入 FAILED）；卡片显示 ID/优先级/当前 Agent/Agent 数/风险/
  happy-path 进度条/当前门禁所需证据/运行时长；拖拽跨列走
  POST /tasks/:id/transition，多态列（FAILED）按引擎 nextStates 解析合法目标；
  门禁拒绝（422）toast 点名缺少的证据。
- **Task Detail (§86)** — `TaskDetail.tsx`: 点击卡片开抽屉，14 个页签
  概览/时间线/团队/子任务/文件/Diff/测试/QA/安全/CI-CD/部署/证据/Memory/Trace，
  复用 QaPanel/CicdPanel + 审计日志/证据/内存引擎，缺数据显"暂无"；
  概览页可直接发起流转并内联显示门禁拒绝原因。
- **AI Employee Detail (§87)** — `EmployeeDetail.tsx`: 点击 Agent（图谱/列表/
  任务团队）开详情，15 个分区 档案/指令/技能/规则/策略/模型/工具/MCP/权限/
  记忆/知识/当前任务/历史/评估/版本；当前任务可跳回任务详情，评估复用
  /profiles 画像 API，缺数据显"暂无"。
- **Git engine** (§34): full git CLI wrapper, `task/<id>-<slug>` branch workflow,
  PR create/merge records, branch protection (direct push to main → 403),
  `code_change`/`merge` evidence auto-attached, every mutation audited.
- **QA engine** (§36–§38): QA Lead + dynamically created specialists, 11 test
  categories, TAP-parsing shell runner, 6-class failure classifier, repair loop
  with owner assignment and regression rerun, `qa_result` evidence.
- **Approvals** (§45, §69): approval lifecycle with expiry, per-tool approval
  levels, `POST /api/approvals/evaluate` policy check, approvals panel with
  risk badges; prod gate requires granted `approval` evidence.
- **CI/CD engine** (§39–§41, §77): 8-stage pipeline runner (build → smoke) with
  injectable handlers, per-stage logs/artifacts; 4 environments
  (LOCAL/DEV/UAT/PROD) with approval policies (PROD → HUMAN_APPROVAL);
  snapshot-before-deploy with automatic rollback on failure; rollback-capability
  gate refuses PROD deploys with no rollback method; parked deploys mint a real
  approval ticket so the Approvals panel is the human gate; `deployment` /
  `smoke_test` / `ci_result` evidence auto-attached; CI/CD panel (pipeline
  list, stage grid, deploy/approve/rollback).
- **Skills registry** (§47–§49, §74): versioned skills (multi-version
  coexistence, DEPRECATED/RETIRED lifecycle), §74 install-time security
  checklist (HIGH findings → install blocked pending HUMAN_APPROVAL),
  keyword discovery with auditable selection records, single-skill instruction
  loading (§48), per-task exact-version usage log (§49); 8 built-in OFFICIAL
  skills; Skills panel (list, trust badges, discovery demo, SKILL.md viewer).
- **Memory engine** (§54–§58): 5 scopes (employee/project/organization/task/
  system) × 9 entry types; per-entry source/confidence/evidence/verification/
  expiry; dedup-on-write merging, half-TTL confidence decay, auto-expiry;
  `verify()` restores confidence; `lessonFromEvaluation()` turns task-end
  evaluations into Lesson/Failure entries; `memory_entries` SQL table
  (+ `SqliteMemoryStore`); Memory panel (scope tabs, confidence badges,
  write/verify).
- **Model router** (§28–§30): deterministic task→model routing (primary/
  fallback/emergency) with hard-constraint filtering (privacy, vision, tools,
  context) and §29 shared-pool exhaustion handling; provider profiles
  (chatgpt-oauth/api-key/local/other) + account status.
- **Agent runtime** (§24–§27): explicit loop state machine
  (OBSERVE→…→EVALUATE→CONTINUE/RETRY/HANDOFF/ESCALATE/COMPLETE), budgets,
  stagnation detection (same error ×3 → escalate), checkpoint/resume, harness
  (permissions, filesystem boundary, timeouts, evidence sink, tracing);
  provider-independent `RuntimeAdapter` (scripted `StubAdapter`, `CodexAdapter`
  placeholder).
- **Orchestrator** (§92–§95, §21): rule-based task auto-decomposition (4 kind
  templates), dependency-aware priority scheduler, weighted agent selection,
  pure next-action engine, manager/handoff pattern chooser.
- **Employee factory** (§18–§19, §59): template-driven dynamic employee
  creation, full governance (children/depth/total/budget/role/model/tool/
  permission limits), self-modification proposals (auto-approve/deny/
  needs-review).
- **Task squads + org designer** (§20, §14): temporary squads with archive
  semantics, org graph with cycle validation and JSON round-trip; **Agents**
  and **Orchestrate** center tabs in the IDE.
- **MCP registry** (§46, §73): server registration (name/version/tools/
  resources/scopes/permissions/trust/approval-policy), unknown sources
  default BLOCKED, approval-gated install flow (AUTO/AI_REVIEW/
  HUMAN_APPROVAL/BLOCKED), multi-version installs, per project/agent/task
  enablement, five-check pre-call tool gate with usage-version logging;
  MCP panel (list, trust badges, install/review, gate-check demo).
- **Knowledge engine + scout** (§50–§53): 5-level hierarchy
  (GLOBAL→…→TASK) with scope-fallback queries and cross-project isolation;
  8-state lifecycle (DISCOVERED→…→RETIRED) with verification-threshold,
  evaluation-score, and external-approval gates; source credibility tiers
  (§51); publishing returns proposal+notice only — never touches agents
  (§53); 9-stage scout state machine with injectable hooks and retry/skip;
  Knowledge panel (search, detail+lifecycle buttons, add/scout).
- **Evaluation + improvement** (§57–§58): 11 metrics, weighted score with
  hard POOR caps (failed tasks / false-completion > 0.3), incremental
  agent profiles + leaderboard, failure-analysis → Lesson via injected sink,
  improvement proposals with PROPOSED→APPROVED→APPLIED governance (critical
  org rules need human approval, never silent); Evaluation panel
  (run evaluation, leaderboard, proposal approve/reject/apply).
- **Agent communication** (§22): 8 typed primitives (Assignment, ArtifactRef,
  Decision, Report, Evidence, ApprovalRef, Handoff, Event) in a uniform
  envelope over task-isolated channels — no free-form chat; payload
  validation, correlationId chains, exportable task traces.
- **Artifact system** (§23): all 19 types first-class with per-type schemas
  (missing fields named on rejection), seal-immutable semantics, bidirectional
  links, workflow hooks auto-generating artifacts (e.g. TASK_COMPLETED →
  FINAL_REPORT draft), decoupled for core binding later.
- **Projects** (§31–§33): sandboxed `WorkspaceExecutor` (command whitelist,
  cwd confinement, timeout kill, output truncation, audit on allow+deny),
  `discoverProject()` (language/framework/package-manager/test-framework/Git/
  CI/AGENTS.md/skills/MCP detection → ProjectProfile), `createProject()`
  (dir + git init + skeleton + README + `.ai/project.yaml`), 5 templates
  (nextjs-saas, react, python-api, node-api, electron); `/api/projects/*`.
- **Code Review Agent** (§35): 10 deterministic static dimensions (security,
  testCoverage, dependencyChanges, conventions, maintainability, readability,
  correctness, architecture, performance, regressionRisk), verdicts
  PASS/PASS_WITH_WARNINGS/CHANGES_REQUESTED/BLOCK, `reviewGateEvidence()`
  feeds the CODE REVIEW workflow gate; `/api/review`.
- **Environment + Release Manager** (§40–§41, §77): full environment model
  (variables, secret *references* only, healthCheck, rollbackMethod,
  approvalPolicy; PROD → HUMAN_APPROVAL), semver releases with auto
  changelog drafts, deploy gate (env → approval → snapshot → deploy →
  healthCheck → auto-rollback), UAT→PROD promotion; `/api/releases`.
- **Policy engine** (§43, §98–§99): 7-layer hierarchy (Global→…→Tool) with
  upper-layer-wins merging — lower-layer silent overrides are recorded as
  denials, never applied; hand-written YAML subset parser + validators for
  `project.yaml` / `organization.yaml`; `/api/policy`.
- **Permission engine** (§44 full): complete capability list
  (filesystem.*/shell.execute/git.*/database.*/deploy.*/secret.*/agent.*/
  mcp.*/skill.*/workflow.*), `checkCapability()` (unknown → deny,
  `deploy.prod` denied by default, production-write policy override),
  every deny audited.
- **Terminal + Monaco** (§64–§65): xterm.js terminal panel backed by
  whitelist-guarded `/api/exec`; real Monaco editor (offline bundle, no
  CDN) with file tree, per-language highlighting, Ctrl+S save, DiffEditor.
- **AI Change Review UI** (§66): Changes panel listing AI commits on task
  branches (diff summary, reason, tests, evidence links) with
  Accept/Reject/Revert (revert = real `git revert`); `/api/changes`.
- **Security** (§71–§76): `SecretRef` (references only, `toString` → `***`),
  `redactSecrets`/`redactDeep` audit-sink auto-redaction; prompt-injection
  defense (`classifyContent` → INSTRUCTION/DATA/EXTERNAL_CONTENT,
  `checkElevation` never promotes untrusted content); manifest scanner
  (dangerous-script/network/file-access checklist → ALLOW/REVIEW/BLOCK,
  unknown sources default BLOCK); two-tier sandbox (`local`/`strong`) with
  directory-escape interception; `/api/security/*`.
- **Snapshot / Recovery** (§77–§78): sealed file+DB snapshots (restore backs up
  current state first — rollbacks are roll-backable); 12-type failure
  classifier; 8-strategy selector with escalation chains and backoff;
  `RecoveryLoop` orchestration with audit trail; `/api/recovery/*`.
- **Resource management** (§79): six-dimension budgets (time/tokens/
  concurrency/tool-calls/retries/storage/processes), `BudgetExceededError`
  with escalation hook, increase-request approval flow, usage summarizer for
  dashboards, priority-aware FIFO concurrency gate; `/api/resources/*`.
- **Autonomy mode** (§80–§81): assisted/semi/autonomous/full project setting;
  risk-graded action decision matrix; §41 independent prod checklist
  (`verifyProdReadiness` — full mode still refuses without evidence);
  human-escalation triggers; `/api/autonomy/*`.
- **Coordination** (§61–§63): DAG → parallel-batch scheduler with cycle
  detection; file-overlap detection (incl. directory-prefix) with
  warn→coordinate→serialize/partition/merge-test plans; six-kind `LockManager`
  with TTL expiry and globally single-active `deployment:prod` lock;
  `/api/coordination/*`.
- **AI disagreement** (§96–§97): verdict-conflict detection, independent
  adjudication (evidence-weighted heuristic, low confidence → ESCALATED),
  §97 gate enabling independent verification only for security/architecture/
  high-risk-deploy/complex-bug; `/api/disputes`.
- **Stability panel**: IDE center tab covering security scan/redact/classify,
  snapshots, failure classification, budgets/usage, autonomy mode + prod
  readiness, scheduling/overlap/locks, and dispute adjudication.
- **Dashboard** (§83): `packages/dashboard` pure aggregation (status strip:
  活跃任务/阻塞任务/运行中 Agent/QA 失败/最近部署/生产状态/资源用量; metric
  cards: 任务完成数/首过成功率/平均任务时长/平均修复轮数/失败部署数/回滚数/
  人工干预数 — every stat carries its data source; missing data → `null` +
  暂无数据, never invented), `GET /api/stats`, IDE **Dashboard** center tab
  with 5 s polling refresh.
- **Electron main process**: `electron/main.ts` (spawns backend, opens window).
- **Tests**: 918 unit tests, all passing (`npm test`).
- **Demos**: `npm run demo` walks TODO → DONE with a mid-run denial;
  `npm run demo:qa` shows FAIL → classify → fix → PASS;
  `npm run demo:cicd` shows approved PROD deploy + auto-rollback;
  `npm run demo:skills` shows install gate + discovery;
  `npm run demo:memory` shows dedup/expiry/decay/verify;
  `npm run demo:runtime` shows retry-then-pass and stagnation→escalate;
  `npm run demo:orchestrator` shows decompose → schedule → select;
  `npm run demo:factory` shows governed employee creation (approve + deny);
  `npm run demo:mcp` shows register → BLOCK unknown → approve → install → gate;
  `npm run demo:knowledge` shows scout → gated lifecycle → ACTIVE → query;
  `npm run demo:evaluation` shows evaluate → profile → lesson → proposal flow;
  `npm run demo:comms` shows Assignment → Handoff → Report chain + trace;
  `npm run demo:artifacts` shows create → link → seal → hook-generated report;
  `npm run demo:projects` shows discover → template create → whitelisted exec;
  `npm run demo:review` shows tainted diff → CHANGES_REQUESTED → clean diff → PASS;
  `npm run demo:release` shows UAT deploy → PROD denied w/o approval → approved deploy → unhealthy deploy auto-rollback;
  `npm run demo:policy` shows global prod-write ban → project override denied → YAML validation errors;
  `npm run demo:security` shows malicious skill install BLOCKED (score 0/100);
  `npm run demo:recovery` shows pre-deploy snapshot → failure → auto-restore;
  `npm run demo:resources` shows token budget blowout → refusal + escalation;
  `npm run demo:autonomy` shows full-mode prod deploy vetoed by the independent checklist;
  `npm run demo:coordination` shows two coders on one file → serialized + merge gated on tests;
  `npm run demo:dispute` shows Coder PASS vs Reviewer FAIL → independent adjudication.

## Activity center + Run / Trace detail (§67–§68)

- **Activity panel** (desktop `Activity` center tab): realtime stream polling
  `GET /api/activity` (default 3s), merging audit-log records and system-bus
  events; every item is timestamped (§67). Rows carrying a `runId` open the
  **Run Detail drawer**, showing every §68 field: run ID, agent + agent
  version, task, model + provider, start/end time, input refs, tools used,
  commands, files changed, artifacts, errors, retries, handoffs, approvals,
  evidence, trace, final outcome.
- **Credential hygiene**: run detail is passed through `@ai-factory/events`
  `redactSecrets` — any value under a sensitive-looking key
  (password/token/api-key/auth/cookie/…) renders as `***` (§68: "Sensitive
  credentials must never appear in traces").
- Routes: `GET /api/activity?limit=`, `GET /api/runs`, `GET /api/runs/:id`
  (`apps/server/src/routes/activity.ts`).

## System Event Bus (§91)

- **`@ai-factory/events`**: in-memory pub/sub `EventBus`
  (`subscribe`/`emit`, monotonic `seq` + ISO `ts` on every event, retention
  window, subscriber errors never break emission). Mirrors the §91 vocabulary
  verbatim — 29 event types (`EVENT_TYPES`, `isEventType` guard).
- **Server routes**: `GET /api/events?type=&limit=` (newest first, type
  validated), `POST /api/events/emit` (`apps/server/src/routes/events.ts`).
- **Events panel** (desktop `Events` tab): realtime stream with multi-select
  filtering by event type.
- **Real producers** (core actions emitting bus events): task created /
  completed, task workflow transitions, agent created, run started / steps,
  QA completed, CI completed, gate passed / failed (approvals + policy),
  deployment started / completed, rollback started / completed.

## Model Registry UI (§90)

- **Models panel** (desktop `Models` center tab): table of provider / model /
  capability / context / reasoning / cost / latency / availability / fallback,
  filterable by capability and provider.
- Data comes from `GET /api/models` → `registryRows()` in
  `@ai-factory/model-router` — the same capability metadata the router (§30)
  uses for task→model routing, never hard-coded model names.

## Placeholders / not implemented

- **Electron binary**: `main.ts` compiles; launching needs `npm i -D electron`
  (binary download was skipped — see `electron/electron.d.ts` shim note).
- **Packaging** (electron-builder), **login/cloud**, **PostgreSQL**: out of scope.

## Repo layout

```text
ai-factory/
  packages/core/{src,tests,demo}   # domain layer + tests + demo script
  packages/db/src                  # schema.ts · db.ts · seed.ts
  packages/git/{src,tests}         # git CLI wrapper + task branches + PRs
  packages/qa/{src,tests,demo}     # QA org + runner + failure loop + demo
  packages/approvals/{src,tests}   # approval lifecycle + tool policy levels
  packages/cicd/{src,tests,demo}    # pipeline runner + environments + deploy/rollback
  packages/skills/{src,tests,demo}  # skill registry + discovery + security gate
  packages/memory/{src,tests,demo}  # structured memory + confidence lifecycle
  packages/model-router/{src,tests,demo} # deterministic task→model routing
  packages/runtime/{src,tests,demo}      # agent loop + harness + adapters
  packages/orchestrator/{src,tests,demo} # decompose + scheduler + selection
  packages/employee-factory/{src,tests,demo} # governed dynamic hiring
  packages/squads/{src,tests,demo}      # task squads + org designer
  packages/mcp/{src,tests,demo}        # MCP registry + trust/install gates + tool-call gate
  packages/knowledge/{src,tests,demo}  # knowledge hierarchy + lifecycle + scout
  packages/evaluation/{src,tests,demo} # metrics + agent profiles + improvement proposals
  packages/comms/{src,tests,demo}      # structured agent communication primitives
  packages/artifacts/{src,tests,demo}  # 19 first-class artifact types + workflow hooks
  apps/server/src/{index.ts,routes} # node:http API + modular route handlers
  apps/desktop/{src,electron}       # React UI + Electron main
  scripts/dev.mjs                  # dev launcher (backend + vite)
  data/factory.db                  # created on first run (git-ignored)
```
