# AI Factory Advanced Features Guide (0.2.0)

> For users already comfortable with the basic flow: MCP, Plan mode,
> slash commands, hooks, permission tiers, Headless CLI, session resume
> & checkpoints, web search, multimodal input, plugins, PR review —
> plus the hardening waves: command palette, task scheduler, code index,
> notification center, metrics dashboard, one-tap offline, auto-backup,
> task templates, audit export, multi-project, quality gates, repo map,
> session isolation, OS sandbox, permission rules, @ context providers,
> shadow checkpoints, team inspections, batch changes, realtime collab,
> coverage visualization, ignore files, problem matchers, security scan,
> migration recipes, impact analysis, egress firewall, scope lock,
> design mode, DB time travel, auto-update, flaky-test detection,
> benchmark regression stats, Local History, devcontainer, mutation
> testing, sweep.yaml, editor/terminal widgets.
> Quick start: [USER_GUIDE.md](USER_GUIDE.md);
> known limitations: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
> 中文版：[ADVANCED_FEATURES.md](ADVANCED_FEATURES.md).

## 1. MCP: connect external tools — and expose yourself

**What**: MCP (Model Context Protocol) is the universal plug for AI
tools. AI Factory can **connect outward** (use an external MCP server's
tools in its own agents) and **be connected to** (act as an MCP server
for external agents like Claude Code / Codex).

**Connecting an external MCP server** (MCP tab):

1. Open the "MCP" tab → add a server, pick a type:
   - `stdio`: a local command (e.g. `npx -y @modelcontextprotocol/server-filesystem`)
     with arguments;
   - `http`: a remote URL (stateless Streamable HTTP per the 2026-07-28
     revision; legacy HTTP+SSE is deprecated and no longer supported).
2. Servers that need login use OAuth 2.1: authorize in the browser as
   prompted; tokens are stored in the encrypted vault **isolated by
   issuer** (one server's token is invisible to others).
3. Once connected, the server's tools appear in your agents' tool list.

**Exposing yourself as an MCP server** (for external agents):

```bash
# Build the server first, then start the stdio bridge
# (it is a thin forwarder — auth still happens server-side)
node apps/server/dist/mcp-serve.js
```

Configure the external agent (e.g. Claude Code) like this:

```json
{ "command": ["node", "/path/to/ai-factory/apps/server/dist/mcp-serve.js"],
  "env": { "PORT": "3100", "AI_FACTORY_TOKEN": "<your API token>" } }
```

Six tools are exposed: `factory_list_tasks`, `factory_create_task`,
`factory_get_task`, `factory_knowledge_search`, `factory_read_file`,
`factory_write_file`. The MCP panel has a master switch — when off,
external calls are refused with an explicit error.

**Honest boundaries**: OAuth against a real remote MCP service needs a
real authorization round-trip; the bridge does no auth itself and
forwards your token — don't expose it to the public internet unless the
server requires tokens.

## 2. Plan mode: plan first, act only on your nod

**What**: like Codex plan mode. The agent writes a plan first (what,
why, acceptance criteria per step) and only executes after you approve;
no approval, no action.

**How**:

1. "Plan" tab → new plan (or `/plan` in chat, see §3).
2. Read it → "Approve" or "Reject" (rejections take a reason).
3. After approval, hit "Execute"; execution is bound by the permission
   tiers in §5.

Plan approvals go through the Approvals channel: the record carries the
plan's sha256, who approved, and which version — verifiable in the audit
chain, no take-backs.

## 3. Slash commands: type `/` in the top bar

The top bar has a command box; typing `/` autocompletes:

| Command | Does |
|---|---|
| `/help` | Lists all available commands |
| `/plan …` | Starts a plan quickly (enters Plan mode) |
| `/review …` | Reviews the current diff (see §11) |

Custom commands: add them in the server's `slash-commands.json` with
`{args}` / `{args:N}` placeholders. Commands are just shortcuts —
genuinely risky actions still go through approvals.

## 4. Hooks: gatekeepers before and after tool calls

**What**: like Codex/Claude hooks. Your deterministic scripts
(`sh -c`, arguments via stdin JSON) run **before** a tool call
(PreToolUse), **after** it (PostToolUse), and on **stop** (Stop).

**How** (Hooks panel):

1. New hook: pick the event (PreToolUse / PostToolUse / Stop), the
   matching tool, and the script. Hit "dry-run" first to check output.
2. If a PreToolUse script **vetoes**, the call is blocked (403
   `HOOK_VETO`) and audited — the agent gets a "vetoed by hook" result,
   never a silent failure.

**Honest boundaries**: hooks are deterministic scripts, not AI
judgment; the Stop hook currently only fires on plan finish — the real
agent-loop stop point isn't wired yet (out of scope, later work).

## 5. Permission tiers: four tiers × three states

**What**: like the Codex/Claude permission model. Each agent has a tier:

| Tier | Can do |
|---|---|
| read | Read-only: tasks, files, audit |
| write | + write files, edit tasks |
| exec | + run commands, call tools |
| admin | + change permissions and config |

Each rule also has a state: `auto` (allow), `ask` (ask you first),
`deny` (refuse). The most specific matching rule wins; ties resolve
`deny > ask > auto`; no matching rule defaults to `ask` (fail-closed —
better one question too many than one silent action).

Combined with approvals "strictest wins": if permissions say yes and
approvals say no, approvals win; `deny` is never overridden. Configure
in the "Permissions" tab.

## 6. Headless CLI: run without opening the UI

**What**: like `claude -p` / `codex exec`. Pipe a sentence in, run a
task without the UI — made for CI and scripts.

```bash
# Option 1: --prompt
npm run headless -- exec --prompt "fix the typos in the README"
# Option 2: pipe (stdin is read automatically when it is not a TTY)
echo "fix the typos in the README" | npm run headless -- exec
# Machine-readable
npm run headless -- exec --prompt "..." --json
# With an image (see §9)
npm run headless -- exec --prompt "describe this image" --image ./shot.png
```

Exit codes: 0 success / 1 operation failed / 2 usage error · timeout ·
interrupted. The token comes from `--token` or the `FACTORY_API_TOKEN`
env var (same origin as the server; the CLI never prints it).

**Honest boundaries**: it runs the server's adapters; under the stub
adapter a run "succeeds" but is exactly as smart as the stub (real
models — see the honest boundaries in USER_GUIDE).

## 7. Session resume & checkpoints: roll back anytime

**What**: like `codex resume` and Claude's Esc-Esc rewind. Sessions are
persistent; checkpoints are one-click rollback.

- "Session" tab: pick a session → "Resume" — you get the task state
  and each run's restore point back, and continue.
- "Create checkpoint": snapshots **session state + code diff** together.
  Messed up? Hit "Rollback": a `pre-restore` safety checkpoint is taken
  first (so rollback itself is reversible), then the session is
  restored and `git apply` rewinds the code. If `git apply --check`
  fails, **nothing moves** (fail-closed — better untouched than half).

Same in the CLI: `ai-factory sessions list|create|attach|resume <id>`,
`ai-factory checkpoint create|list|restore`.

Note: the code part of a checkpoint is the `git diff` of **tracked
files only** (untracked new files excluded); oversized diffs are
truncated with an explicit marker.

## 8. Web search: agents can look things up

**What**: a `web_search` tool for agent runs.

- Works out of the box: default Bing RSS, no key needed. For production,
  configure a Brave / Tavily key (vault `search.brave.key` /
  `search.tavily.key`, or `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY`
  env vars — vault wins).
- `GET /api/search/providers` lists configured providers (keys never
  exposed).
- Enable for agents: add `web_search` to the server env var
  `FACTORY_RUNTIME_TOOLS` (opt-in, off by default; `network.access`
  grant).

**Honest boundaries**: search results are **untrusted external
content** — they pass through `sanitizeUntrusted()` and are quarantined
as DATA before entering prompts (injection defense); Bing RSS is
personal/non-commercial only — get a key for commercial use.

## 9. Multimodal input: paste images for the agent

**What**: attach images when creating a task (paste / drag-drop / file
picker all work), with thumbnail previews, ≤10 MiB each, max 8; failures
are loud, never silently swallowed.

Images are stored server-side (`POST /api/tasks/:id/attachments`) and
bound to the task. Headless: `--image` (see §6).

**Honest boundaries (important)**: both adapters currently declare
`vision: false` — the prompt only **names** the images ("2 images
attached") and never pretends to "see" them. The bytes are stored and
retrievable, but real vision needs a capable real model (user-side).

## 10. Plugins: locally-installed capability packs

**What**: a plugin = a directory + `plugin.json` (name / version /
permission declarations / capabilities: skills, slash commands, hooks,
MCP servers). Install from a **local directory** in the "Plugins" tab:

1. Hit "Install", enter the plugin directory path.
2. Install-time validation: manifest schema, permission declarations
   shown to you, path jail (nothing may be written outside the plugin
   directory), symlinks rejected; any failure **rolls everything back**.
3. Afterwards: enable / disable / uninstall — exact inverses; every
   step audited.

Skills arriving via plugins still pass the security scan (§74); a
high-risk skill without your manual approval rolls the install back.
**No remote plugin marketplace** (ecosystem decision); the manifest
reserves the extension block.

## 11. PR review: comment right in the diff

"Git" panel → PR list → open a PR:

1. Read the structured diff (per file / hunk, click a line number to
   jump).
2. Write inline comments on any line (sanitized before storage —
   injection defense).
3. Hit "Approve" / "Request changes" / "Comment".

Reviews are **record-only**: the review state shows in the PR detail for
human judgment and **does not block merge** (changing merge semantics
was deemed too risky and left alone).

## 12. Command palette: Cmd+K (hardening wave 1)

**What**: a global command palette (like VS Code's Cmd+K / Ctrl+K).
No mouse needed: fuzzy-type to jump to any tab, task, or agent,
or create a task outright.

**How**: press Cmd+K (Ctrl+K on Windows/Linux) anywhere, type,
↑↓ to pick, Enter to run.

**Honest boundaries**: it's just a shortcut — everything you jump to
still obeys permission tiers and approvals. No bypasses.

## 13. Local task scheduler: self-built 5-field cron (hardening wave 1)

**What**: a self-contained server-side scheduler (zero dependencies):
cron expressions (5 fields: minute hour day-of-month month weekday)
or fixed intervals, firing jobs (backups, checks, test runs).

**How**: `POST /api/schedules` with
`{name, kind: 'cron'|'interval', cronExpr|intervalMs, job}`;
invalid expressions are rejected with 400, never silently swallowed.

## 14. Code index: codeindex (hardening wave 1)

**What**: a symbol-level search engine for the project: it indexes
functions, classes, and exported symbols plus their reference graph —
the shared foundation for @ references, the repo map, and impact
analysis.

**How**: indexing is incremental (files with unchanged mtime+size are
reused); the two-tier ignore gate sits at the index entry point
(see §33) — ignored files are invisible to both indexing and queries.

**Honest boundaries**: references are heuristic symbol-name matches
(same-name symbols add noise), not compiler-grade semantics — the
impact report says so explicitly.

## 15. Notification center (hardening wave 1)

**What**: one inbox for every async event: hook vetoes, security-scan
blocks, egress-firewall blocks, backup completions — severity-graded,
HIGH pinned to the top.

**How**: the bell icon in the top bar; filter by type/severity.
A notification only records what happened — the handling action
(e.g. allowlisting a blocked host) lives in its own panel.

**Honest boundaries**: notifications are not an approval channel;
anything needing your nod goes through the Approvals tab.

## 16. Metrics dashboard (hardening wave 1)

**What**: the "Metrics" tab: a live board of the server's `/stats`
operational metrics (task counts, agent counts, QA failures,
deployments), refreshing every 5s.

**Honest boundaries**: these are server self-reported metrics — a
sampled view, not APM. Each tile labels its data source.

## 17. One-tap offline (hardening wave 2)

**What**: a top-bar kill switch: flip it and all external network
egress stops (web search, remote MCP, webhooks) — the big red button
against code exfiltration.

**How**: one click on the top-bar toggle; the env var
`FACTORY_NETWORK_OFFLINE=1` forces offline regardless (config wins
over the switch).

**Honest boundaries**: it's binary — all-off or all-on. For
"allow npm but nothing else" granularity, use the egress firewall
in §38.

## 18. Auto-backup & retention (hardening wave 2)

**What**: the Ops tab's backup panel: one-click manual backups plus
scheduled automatic backups. Retention only ever deletes `scheduled`
auto-backups (keeping the newest N); manual and pre-restore backups
are never auto-deleted.

**How**: enable auto-backup and set the keep count in the backup
panel; a restore first takes a pre-restore safety snapshot, so the
rollback itself is reversible.

**Honest boundaries**: retention only prunes automatic backups;
manual ones are exempt. (A soak once caught a real bug wrongly
deleting a manual backup — fixed, with a regression test.)

## 19. Task template library (hardening wave 2)

**What**: "create from template" when making a task: recurring task
shapes (goal, acceptance criteria, constraints) saved as templates,
applied in one click. Three seed templates ship on first boot.

**How**: new-task dialog → "from template"; templates live in
`AI_FACTORY_DATA_DIR/task-templates.json` and are editable.

**Honest boundaries**: a template fills in fields, it doesn't do the
work — no auto-execution.

## 20. Audit compliance export (hardening wave 2)

**What**: one-click audit-chain export: a time range exported as CSV
or JSON, with snapshot metadata (format, range, record count) carried
in response headers — for compliance/audit use.

**How**:
`GET /api/audit/export?format=csv|json&from=<ISO>&to=<ISO>`;
the CSV is pure RFC4180, Excel-ready.

## 21. Multi-project (hardening wave 2)

**What**: one server manages many projects: project list, per-project
isolation of tasks/knowledge/audit views, one-click switching in the
top-bar project switcher.

**How**: create/switch projects in the left "Project" panel; every
tab filters by the current project.

**Honest boundaries**: isolation is at the data-ownership/view
level; execution-level isolation is §25's OS sandbox.

## 22. lint/test quality gates (third wave, part 1)

**What**: CI-style quality gates: run lint, run tests, run coverage;
any failing step blocks (blockOnFailure), results go to the audit
chain.

**How**: configure gates in the "Inspections" tab; test runs can emit
coverage reports (see §32), with an optional "block on coverage
drop".

**Honest boundaries**: gates run the project's own lint/test
commands — we do the running and judging, not the writing.

## 23. AST repo map: repomap (third wave, part 1)

**What**: an AST-level map of the repository: file → symbol →
reference graph, a static "code tour" for agents.

**How**: agents pull it automatically through the @ context
providers; nothing to configure by hand.

**Honest boundaries**: heuristic parsing (not a full compile);
same-name symbols add noise; dynamic imports/reflection are
invisible.

## 24. Worktree session isolation (third wave, part 1)

**What**: every session gets its own git worktree: agents edit code
in isolated worktrees, never stepping on each other; merge or discard
at the end.

**How**: worktrees are allocated automatically when a session is
created; the Git panel shows each session's worktree state.

**Honest boundaries**: this isolates the *workspace*, not the OS
(that's §25).

## 25. OS sandbox tiers (third wave, part 1)

**What**: three OS isolation tiers for command execution: read-only,
workspace-write, and off — implemented with bwrap (Linux).

**How**: pick a tier in the exec config; **fail-closed**:
read-only/workspace-write require a working bwrap, otherwise
execution is refused rather than silently downgraded. The response
honestly reports the tier actually applied.

**Honest boundaries**: when bwrap is unavailable we'd rather refuse
than fake isolation; this is directory/syscall-level isolation, not
a VM.

## 26. allow/ask/deny permission rules (third wave, part 1)

**What**: a rule layer beside §5's four permission tiers: glob/action
rules, each allow/ask/deny; the most specific match wins, ties go to
deny.

**How**: configure `.ai-factory/permissions.json` in the Permissions
tab; rule changes are audited.

**Honest boundaries**: rules govern *our* tool surface; your own
manual actions are unrestricted.

## 27. @ context providers (third wave, part 2)

**What**: `@` references in chat for code/issues/file trees: @open
(open a file), @tree (directory tree), @problems (problem list),
code_search (code search) and more — feeding precise context to the
agent.

**How**: type `@` in the chat box for autocomplete; the two-tier
ignore hard-exclusion applies here too — referencing an ignored file
is explicitly refused, never silent.

**Honest boundaries**: @problems diagnostics come from internal
parsers like the problem matchers (§34), not from an LSP.

## 28. Shadow git checkpoints (third wave, part 2)

**What**: Cline-style sidecar checkpoints: a bare git object store
snapshotting the workspace at file level (the workspace itself need
not be a git repo), with one-click undo.

**How**: "create checkpoint" in the session/task panel; restores
first take a pre-restore safety snapshot; design-mode write-backs and
DB time travel reuse it as their undo foundation.

**Honest boundaries**: file-level snapshots, not semantic ones;
oversized/binary files are skipped per policy and clearly marked.

## 29. Team quality gates: inspections (third wave, part 2)

**What**: the "Inspections" tab: a configurable checker set
(style/hygiene/security), with profiles, baselines (pre-existing
issues baselined — only new ones block), and trend panels.

**How**: pick a profile and run checks in the inspections panel;
the security scan (§35) is one checker category here.

**Honest boundaries**: checkers are deterministic rules, not AI
review; a baseline manages honest debt, it doesn't erase it.

## 30. Batch changes (third wave, part 2)

**What**: the "Batch" tab: change many repos at once — define steps
(shell/recipes), run them across the repo registry, watch progress
and results on one board.

**How**: new batch job in the batch panel, pick repos, write steps,
execute; a single repo is just the special case.

**Honest boundaries**: steps are deterministic; migration recipes
(§36) are its "semantic" sibling.

## 31. CRDT realtime collaboration (third wave, part 2)

**What**: the "Collab" tab: realtime multi-client co-presence (CRDT),
so two people can look at the same board/task view without
conflicts.

**How**: join a room from the Collab tab; the shared package builds
dual-format (CJS+ESM), the browser uses ESM.

**Honest boundaries**: MVP grade — shared-state sync works; fancier
conflict resolution and permission granularity are still ahead.

## 32. Test coverage visualization (second round, part 1)

**What**: like Coverage Gutters: quality-gate test runs can emit
lcov/cobertura/V8 coverage reports; the "Coverage" tab renders
per-line coloring, file-tree aggregate badges, and trend curves.

**How**: enable "emit coverage report" in the gate; inspect gaps in
the coverage panel; optional "block on coverage drop"
(blockOnCoverageDrop).

**Honest boundaries**: the data comes entirely from the project's
own test command output — we don't instrument anything; high
coverage ≠ strong assertions.

## 33. Two-tier ignore files (second round, part 1)

**What**: like Cursor: project-root `.ai-factory/ignore` (hard
exclusion — invisible to all AI features) plus
`.ai-factory/indexing-ignore` (not indexed, but explicitly
referenceable).

**How**: create the two files in the project root (glob syntax);
codeindex, repomap, @ providers, search, and backup all pass one
shared gate; hits are explicitly labeled "ignored" in the UI, never
silent.

**Honest boundaries**: this governs *our* tool surface, not the OS —
other tools can still read those files.

## 34. Problem matchers (second round, part 1)

**What**: like VS Code problemMatcher: declarative regexes in
`.ai-factory/problems.json` turn any command output
(build/test/scheduled jobs) into clickable
"file:line:column:message" entries in the Problems panel. Built-ins:
$tsc/$eslint/$go/$node-test/$vitest.

**How**: browse entries in the bottom Problems panel, click to jump;
the panel has a "test matcher" dry-run box — paste output, see the
parse instantly.

**Honest boundaries**: regexes misfire on non-standard output;
multi-line stacks are best-effort; this is not an LSP.

## 35. Unified security scan (second round, part 1)

**What**: like Amazon Q's security scan: three categories in one run —
hardcoded secrets (20 pattern families), SAST (14 high-precision
rules: SQL concatenation, XSS sinks, command injection, path
traversal…), and a dependency CVE denylist (15 entries, snapshot
2026-10-20).

**How**: run it as a checker in the Inspections tab; serious findings
can block the quality gate and raise notification-center alerts;
results enter the audit chain.

**Honest boundaries**: pattern matching has false positives/negatives —
not a certified audit; CVE coverage depends on snapshot freshness.

## 36. Deterministic migration recipes (second round, part 1)

**What**: like Amazon Q /transform: 10 built-in npm/TS recipes
(dependency upgrades, package renames, deprecated-API swaps):
pick a recipe → review the plan → execute on a new branch →
auto build+test verification.

**How**: the "Recipes" tab: pick a recipe, review the (editable)
plan, approve, execute; a 409 drift refusal stops a write when the
file changed mid-flight.

**Honest boundaries**: deterministic parts only; anything a recipe
can't cover is explicitly listed as "unhandled" for human review.

## 37. Change impact analysis (second round, part 2)

**What**: like Augment: see the blast radius *before* merging — a
reverse-reference graph over codeindex/repomap computes direct and
transitive downstream plus an API contract diff (export symbol
add/remove/change).

**How**: "Run impact analysis" in the Git panel's PR review, or
`POST /api/impact/analyze`; the quality gate offers
`impact.failOnBreaking` (default off — advisory, never blocking).

**Honest boundaries**: heuristic advice, not proof: same-name
symbols add noise, dynamic dispatch/reflection is invisible; when
analysis can't run it's audited, never blocking.

## 38. Egress firewall allowlist (second round, part 2)

**What**: like Copilot coding-agent allowlists: the middle ground
between one-tap offline (§17) and fully open. Three-layer config in
`.ai-factory/egress.json` (global/project/task); a rule is a domain
(including subdomains) or a URL prefix; deny always wins.

**How**: configure rules in the Project panel; blocked calls are
audited as `EGRESS_BLOCKED`, raise HIGH notifications, and are
listed in the log; a dry-run box tests whether a URL would be
blocked.

**Honest boundaries**: only enforced on the exits we control (web
search, remote MCP); default off = nothing blocked, nothing logged;
loopback is always allowed.

## 39. Task-scoped edit lock (second round, part 2)

**What**: like bolt.new: when creating a task, draw the fence —
"only these files may change" (`scope: {include, exclude}` globs),
hard-enforced at the tool layer against out-of-scope writes.

**How**: fill "allowed dirs / excluded dirs" in the new-task dialog
(presets available); out-of-scope writes get 403 `SCOPE_LOCKED`
plus a `SCOPE_VIOLATION` audit; scope can be adjusted mid-task
(adjustments are audited); runs get a post-hoc diff re-check.

**Honest boundaries**: it constrains task-attributed writes; your
own manual edits in the editor are unrestricted (by design).

## 40. Visual Design Mode (second round, part 2)

**What**: like v0 Design Mode: in the "Design" tab, click an element
in the preview and visually edit Tailwind styles (five dimensions —
background/text color, font size, padding, margin — plus copy),
written back to source deterministically; right-click "Go to Code"
jumps from pixels back to code.

**How**: click an element in the design panel → edit in the property
panel → write back; a shadow checkpoint is mandatory before writing
(no checkpoint, no write); a 409 `DESIGN_DRIFT` refusal fires if the
file changed mid-flight.

**Honest boundaries**: DOM→source mapping is heuristic — failed
mappings say so and never force a write; only common Tailwind
conventions are covered; the whole `dirname(DB_PATH)` tree is a
control-plane no-write zone.

## 41. DB time travel + dev/prod isolation (second round, part 2)

**What**: like Replit: when a shadow checkpoint is created, the
project's declared SQLite DB gets a WAL-checkpointed atomic snapshot
bound to the same checkpoint id; projects declare dev/prod data
sources, and tasks only ever touch dev by default.

**How**: browse snapshots in the Changes panel; restore writes dev
only (double-confirmed, with an automatic pre-restore safety net);
promote is the *only* prod write path (explicit + confirmed +
`DB_PROMOTE` audit); dev==prod configs are refused outright.

**Honest boundaries**: SQLite only in this phase; snapshots cap at
100MB by default — oversize/symlink cases record a skip reason,
never silently.

## 42. Auto-update + changelog (third round, part 1)

**What**: like VS Code's auto-update. The server-side `updates.ts` is the
deterministic core: it parses the update feed, compares versions, and
decides "is there a newer release" — the actual download/install goes
through `electron-updater` 6.8.9 in the desktop main process
(`autoDownload=false`: nothing downloads until you click it).

**How**: the center "Updates" tab (UpdatePanel): view version status and
trigger a manual check; the feed URL comes from `FACTORY_UPDATE_FEED_URL`
(empty by default = no checks, and the UI says so plainly — "update
source not configured"); `FACTORY_UPDATE_CHECK_INTERVAL_MS` defaults
to 6 hours (min 1 minute), `FACTORY_UPDATE_AUTO_CHECK=false` disables
automatic checks. A new release writes an `UPDATE_AVAILABLE` audit entry
and pushes a notification-center alert. Checks go through the egress
firewall (a blocked feed fails loudly as `egress-blocked`).

**Honest boundaries**: the server only *checks* — it never downloads or
installs binaries; hosting the update feed is a Tan-side deployment
decision, and by default there is none.

## 43. Flaky-test detection (third round, part 1)

**What**: like Google Test's flaky labels: `flaky.ts` parses TAP and
`FlakyHistoryStore` (`flaky-history.json`) accumulates per-test history;
within the lookback window (default last 10 runs, minimum 3 data points)
a pass/fail mix marks the test flaky; a test that always fails is
always-failing.

**How**: `POST /api/flaky/record` posts TAP text to record;
`POST /api/flaky/runs` runs the given test files on the server
(TMPDIR wrapper + `--test-reporter=tap`, files jailed); the Problems
panel has a flaky-failures section; the quality gate offers
`rerunFlakyOnce` (default off): when on, a failed test gets one extra
run for quarantine annotation — but **the original verdict never
flips**, and a flaky test is never auto-passed.

**Honest boundaries**: a short window can mislabel, so `minRuns`
floors it at 3; skips count as neither pass nor fail; the gate linkage
is annotation-only.

## 44. Benchmark regression statistics (third round, part 1)

**What**: Criterion.rs-style statistics: mean/median/approx 95% CI
(z=1.96) — "sample set vs sample set", where only non-overlapping
confidence intervals count as a significant regression (conservative
`significantSlowdown`). `--runs n` (default 1) repeats each case n
times and aggregates: latencies are statistically merged, and a pass
requires every run to pass.

**How**: `npm run benchmark -- --runs n`; in regression reports, a
latency regression is only a warning (wall-clock timings are
environment-sensitive) — only a success regression (pass→fail) fails
the CI gate.

**Honest boundaries**: latency detection is conservative, so minor
regressions can slip through; the success criterion is strict —
one failed run is a regression.

## 45. Local History: snapshot on every save (third round, part 1)

**What**: like JetBrains Local History: a save hook in `routes/files.ts`
writes a timestamped snapshot on every save, under
`AI_FACTORY_DATA_DIR/local-history/<workspace>/<file>/`.
Configurable caps: 50 snapshots per file by default
(`FACTORY_LOCAL_HISTORY_MAX_SNAPSHOTS_PER_FILE`), 1MB per snapshot
(`FACTORY_LOCAL_HISTORY_MAX_SNAPSHOT_BYTES`), 100MB per workspace
(`FACTORY_LOCAL_HISTORY_MAX_WORKSPACE_BYTES`); over-limit saves get an
explicit `skipped-*` status (too-large/unchanged/disabled/error) —
never silent; `FACTORY_LOCAL_HISTORY_DISABLED=1` turns it off entirely.

**How**: browse and restore from the history drawer in the editor;
restore needs explicit confirmation, and the current content is saved
as a `pre-restore` snapshot first — so a restore is itself undoable.

**Honest boundaries**: only saves through the file API are covered;
identical content isn't re-snapshotted (`skipped-unchanged`); trimmed
snapshots say why.

## 46. Reproducible dev environment: devcontainer (third round, part 1)

**What**: `DevEnvSpec` in `packages/qa/src/devenv.ts` is the single
source of truth with two derived renderings: `renderDevcontainer()` →
`devcontainer.json`, `renderSetupStepsYaml()` → the Copilot Setup Steps
YAML — unit-tested byte-identical so the two never drift. Templates live
in `.devcontainer/`, not in `.github/workflows/` (deliberate, matching
the current no-`.github/`-in-commit policy).

**How**: `docs/dev-environment.md` documents the full contract (schema
shape, extension-id format, `npm run` script existence, fail-closed on
unparseable input); to enable Copilot cloud agents, copy the yml to
`.github/workflows/`.

**Honest boundaries**: file correctness is verified, but no real
container pull-up was run; enabling Copilot Setup Steps is Tan's call
(the template is ready whenever he wants it).

## 47. Mutation testing (third round, part 2)

**What**: like StrykerJS: the layer beneath coverage — "are your
assertions strong enough?" The new `@ai-factory/mutation` package has
7 text-level mutation operators (arithmetic/comparison/boundary/
boolean-flip/logic) with a tokenizer that skips strings, comments, and
template literals; mulberry32 seeded sampling is fully reproducible
(default 50 mutants, per-file cap 10, hard cap 200 per run); mutants
execute in a scratch copy and **never touch the real tree**, with
per-mutant timeouts; verdicts are killed/survived/timeout/invalid,
score = killed/(killed+survived).

**How**: `POST /api/mutation/run` (background, 202) →
`GET /api/mutation/runs/:id` to poll → `GET /api/mutation/latest`;
the quality gate offers `mutation.report` (default off): it attaches
the report summary as an annotation only — never triggers a run, never
blocks; the Problems panel has a mutation-testing section.

**Honest boundaries**: whole-repo exhaustive mutation isn't supported —
sampling only; template-literal interpolation is out of scope in v1;
syntactically invalid mutants count as `invalid` and don't pollute the
score; generics like `<T>` can legitimately produce invalid mutants.

## 48. sweep.yaml automation convention (third round, part 2)

**What**: like Sweep: a `.ai-factory/sweep.yaml` in the project
declaratively maps external events (issues, alerts…) to task templates.
`loadSweepConfig`: a missing file is not an error; bad YAML/bad version
fails the whole file closed with line numbers; a single bad rule lands
in `invalidRules` while the rest keep working. `matchSweepRules` is
fully deterministic: priority descending, then document order.
`buildLaunch` passes every event value through
`sanitizeUntrusted(declared external)`.

**How**: `GET /api/sweep/config` shows rule summary + validation status;
`POST /api/sweep/dry-run` matches without creating anything;
`POST /api/sweep/ingest` proposes a task:
`authorizationStatus=WAITING_HUMAN_DISPATCH`, creator=`sweep`,
audit `SWEEP_TASK_PROPOSED` — it lands in the Dispatch panel for a
human to confirm or reject (a sweep badge marks its creator column).

**Honest boundaries**: it's a convention, not a live integration —
there is no webhook receiver; direct GitHub webhook wiring is a
Tan-side networking decision and is deliberately not built; proposed
tasks never auto-run — a human always signs off.

## 49. Editor/terminal experience widgets (third round, part 2)

**What**: R3-T9 editor widgets: Monaco's built-in stickyScroll
(`enabled` + `maxLineCount: 10`) with a header checkbox switch
persisted in localStorage (`ai-factory.editor.stickyScroll`, on by
default); `FILE_NESTING_RULES` file nesting (`package.json`→lock
files, `*.ts`→`.d.ts`/`.test.ts`/`.spec.ts`/`.stories.ts`…) grouped in
the same directory with chevron expand/collapse. R3-T10 terminal widget:
a DOM status bar under xterm — short session id, working directory,
exit code, connection state; polled every 5 seconds, with one-click
reconnect when disconnected/closed.

**How**: toggle sticky scroll in the editor header; expand nesting
groups in the file tree; glance at the terminal status bar, and hit
reconnect when it drops.

**Honest boundaries**: a PTY can't report per-command exit codes, so a
live session honestly shows "—" for exit code (never faked) — the real
exit code appears only when the session ends.

---

*Version 0.2.0 (2026-10-18). Supplemented 2026-10-21: hardening waves
(1/2), third wave (parts 1/2), second round (parts 1/2) — §12–§41;
supplemented 2026-10-21: third round (parts 1/2) — §42–§49.
中文版见 ADVANCED_FEATURES.md。*
