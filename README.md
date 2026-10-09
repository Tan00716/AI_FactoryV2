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
| `npm test` | Build all domain packages, run 102 unit tests (`node --test`) |
| `npm run demo` | Evidence-chain demo: task TODO → DONE with a gate **denial** in the middle |
| `npm run demo:qa` | QA-loop demo: test FAIL → classify → fix → rerun → PASS |
| `npm run build` | TypeScript build (core, db, server) + Vite production bundle |
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
  (project tree · AI org · skills), center tabs (task board §85 simplified ·
  **Git panel** · **QA panel** · **Approvals panel** · editor placeholder),
  bottom (AI activity from audit log · terminal/tests/logs stubs).
  Create-task modal, task detail with evidence list + transition buttons.
- **Git engine** (§34): full git CLI wrapper, `task/<id>-<slug>` branch workflow,
  PR create/merge records, branch protection (direct push to main → 403),
  `code_change`/`merge` evidence auto-attached, every mutation audited.
- **QA engine** (§36–§38): QA Lead + dynamically created specialists, 11 test
  categories, TAP-parsing shell runner, 6-class failure classifier, repair loop
  with owner assignment and regression rerun, `qa_result` evidence.
- **Approvals** (§45, §69): approval lifecycle with expiry, per-tool approval
  levels, `POST /api/approvals/evaluate` policy check, approvals panel with
  risk badges; prod gate requires granted `approval` evidence.
- **Electron main process**: `electron/main.ts` (spawns backend, opens window).
- **Tests**: 102 unit tests, all passing (`npm test`).
- **Demos**: `npm run demo` walks TODO → DONE with a mid-run denial;
  `npm run demo:qa` shows FAIL → classify → fix → PASS.

## Placeholders / not implemented

- **Monaco editor** (§65): center "Editor" tab is a placeholder panel.
- **Terminal** (§64): bottom tab is a stub (no xterm.js).
- **Agent runtime / model router / Codex** (§24–30): no real LLM calls; agents are
  registry entries. Transitions are triggered manually via UI/API.
- **CI/CD engine, sandbox, MCP, skills, memory, knowledge** (§18–23, §31–33,
  §39–40, §46–56): schema tables exist for some (`runs`, `artifacts`), logic not built.
  (Git, QA, and approvals engines are now implemented — see above.)
- **Policy engine runtime enforcement** (§43): approval levels evaluated per
  action; no global policy file loader yet.
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
  apps/server/src/{index.ts,routes} # node:http API + modular route handlers
  apps/desktop/{src,electron}       # React UI + Electron main
  scripts/dev.mjs                  # dev launcher (backend + vite)
  data/factory.db                  # created on first run (git-ignored)
```
