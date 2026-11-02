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
> testing, sweep.yaml, editor/terminal widgets, pre-send secret scan,
> deterministic refactoring, structural search/replace, TODO tracker,
> dependency advisor, DAP debugger, database browser, HTTP client,
> profiler, terminal history.
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

## 50. Pre-send prompt secret scan (fourth round, part 1)

**What**: fixes a real hole — `scanForSecrets` used to be called only
by MemoryStore.write, while `adapter.invoke` sent prompts to vendors
untouched, so raw secret values could go out the door.
`assertPromptSafe` in `packages/runtime/src/pre-send-scan.ts` sits on
the first line of both `StubAdapter.invoke` and `CodexAdapter.invoke` —
no caller can bypass it. The engine is a 21-family shared table
(`SECRET_PATTERNS` in `@ai-factory/security`, the single source of
truth; `inspections.ts` now just imports + re-exports, zero behavior
change for repo scanning) plus 3 prompt-shaped generic families kept
local to pre-send (`token-assignment`/`secret-assignment`/
`password-assignment`, never in the shared table). Matching is
`matchAll` over every family — fixing a fail-open where a placeholder
in front hid a real key behind it; the redact callback keeps
placeholders intact.

**How**: automatic, no configuration. Two modes via
`setPreSendScanMode` (default `block`): on a hit, block mode writes
audit `PROMPT_SECRET_BLOCKED` + a HIGH notification
("Prompt blocked: …") and throws `PreSendSecretBlockedError`
(names the pattern, never the value); `redact` mode substitutes
`[REDACTED]` and releases the prompt, with audit
`PROMPT_SECRET_REDACTED`. Sinks plug into the audit chain +
notification center via `setPreSendScanSinks` (best-effort: with no
sinks installed the gate still blocks, it just doesn't audit/notify).

**Honest boundaries**: `images` only scans prompt text —
`AdapterInput.images` are descriptors (no bytes), and vision:false
adapters can't see bytes; redact mode sends no HIGH alert (the
operator's explicit leniency choice) but still audits; pure text scan,
zero model keys.

## 51. Deterministic refactoring (fourth round, part 1)

**What**: IDE-style refactoring with preview. The new zero-dependency
`@ai-factory/refactor` package: `tokenizer.ts` (TS/JS tokenizer:
strings/template `${}`/regex-vs-division/private fields/line+column+
depth), `scope.ts` (two-pass scope analysis: functions/arrows/methods/
classes/imports/catch/for, destructuring, TS type annotations,
shadowing), `ops.ts` (4 operations: extract-method/extract-variable/
inline-variable/rename), `diff.ts` (deterministic unified-diff
generator), `types.ts`. Server `routes/refactor.ts`:
`POST /api/refactor/analyze` (read-only preview, returns proposalId +
diff), `POST /api/refactor/apply` (per-item `acceptedIds`; before
writing anything every touched file is re-read and sha256-compared
against the analyze snapshot — any drift fails the whole batch closed
with 409 `REFACTOR_DRIFT`), `GET /api/refactor/proposals/:id`.
The proposal store is in-memory with a 10-minute TTL. The desktop
RefactorPanel goes form → preview (per-item checkboxes + diff) →
apply selected.

**How**: fill the op form in the Refactor panel → review the preview →
tick the items to accept → apply; cross-file renames follow explicit
`otherFiles` only; jail wiring via `setRefactorInspectionRootResolver`.
Audit: `REFACTOR_ANALYZED` / `REFACTOR_APPLIED` /
`REFACTOR_APPLY_REJECTED`.

**Honest boundaries**: the preview diff deliberately doesn't reuse
the shadow-git diff pipeline — shadow-git needs a real checkpoint, and
preview must be side-effect free; extract-method is closure-based and
never synthesizes parameters; escaping return/break/continue is refused
outright; rename resolves by scope; apply is all-or-nothing per request
and proposals die with a restart.

## 52. Structural search/replace (fourth round, part 1)

**What**: search/replace by AST structure, not text. The new
`@ai-factory/ssr` package: `scanner.ts` (character-level state machine:
string/comment/template-literal/regex aware, brace balancing),
`template.ts` (4 built-in templates), `replace.ts`
(`renameInScope`/preview/apply). Server `routes/ssr.ts`:
`GET/POST/DELETE /api/ssr/templates` (template management, writes
audited), `POST /api/ssr/search`, `POST /api/ssr/preview`,
`POST /api/ssr/apply` (audited), `POST /api/ssr/quickfix` (one-click
fix from an inspection hit). `inspections.ts` gains
`setExtraCheckerProvider`; the `ssr-template` checker ships in the
default profile. Desktop: quick-fix buttons in the InspectionsPanel
plus SsrTemplatesManager. Contrast experiment: on same-named variables,
text search hit 6 spots while SSR's scoped rename changed 3 (beta's
same-named `count` and `obj.count` untouched).

**How**: pick a built-in or custom template in SsrTemplatesManager →
search → preview diff → apply; or hit quick-fix directly on an
inspection finding. Jail via setter injection.

**Honest boundaries**: the repomap parser isn't literally reused —
codeindex's extractor doesn't do visibility modifiers or locals, so SSR
has its own extended heuristic scanner; it's heuristic extraction, NOT
a compiler AST (limitations declared at the top of
`packages/ssr/src/types.ts`).

## 53. TODO tracker (fourth round, part 1)

**What**: JetBrains-style TODO tool window.
`apps/server/src/todo-scan.ts` (~300 lines): a deterministic regex
scanning kernel. `DEFAULT_TODO_PATTERNS`: FIXME→error, BUG→error,
HACK→warning, TODO→info (case-sensitive); `validateTodoPatterns`
fails closed — bad regexes are named, patterns matching the empty
string are rejected, no duplicate names, no bad severities, cap 32
patterns; file cap 20,000. Server `routes/todo-scan.ts`:
`GET /api/todos` (config + full scan, viewer),
`GET /api/todos/file` (one file, feeds the editor gutter),
`PUT /api/todos` (custom patterns, operator, audit
`TODO_CONFIG_UPDATED`), `POST /api/todos/reset` (back to defaults,
audit `TODO_CONFIG_RESET`). Desktop: a new TODO tab in the bottom
panel (TodoPanel) plus gutter dots + overview-ruler stripes in the
editor.

**How**: the bottom TODO tab shows the whole-project scan; gutter dots
jump to items; `PUT` custom patterns (session-scoped — a restart
reverts to defaults, and the UI says so). Read paths aren't audited.

**Honest boundaries**: the two-level ignore gate reads
`.ai-factory/ignore` + `indexing-ignore` and **never `.gitignore`**
(real behavior); a TODO inside a string literal matches just like one
in a comment (no string awareness); custom configs are session-scoped.

## 54. Dependency upgrade advisor (fourth round, part 1)

**What**: an offline-first upgrade advisor. The new
`@ai-factory/depscan` package: a self-written semver subset engine
(unsupported atoms — `||`, hyphen ranges, dist-tags — make
maxSatisfying return null, **never guessed**), `advise` builds an
upgrade plan with semver safety grading (major/minor/patch), and the
registry has dual providers (offline snapshot by default; live requires
explicit opt-in and passes the egress gate). The snapshot
`registry-snapshot.json` (2026-10-22, 20 packages: the CVE-blacklist
set plus common ones; every report discloses the snapshot date and
states it lags the real registry — not a substitute for a live query).
Server `routes/depscan.ts`: `POST /api/depscan/advise` (through the
egress gate), `GET /api/depscan/snapshot` (snapshot metadata, viewer);
CVE cross-reference via setter injection reusing inspections'
`BUILTIN_VULNERABLE`. Desktop: a DepscanSection in the Problems panel.

**How**: the Problems panel's dependency section shows the upgrade
plan; the snapshot endpoint lets you check the lag date any time;
opt in explicitly for a live registry lookup (an egress block gives a
clear error).

**Honest boundaries**: the self-written semver covers a subset —
unsupported ranges deterministically return null; the snapshot is a
hand-maintained 20-package set and can't cover the long tail; live
mode goes through the egress firewall, and a deny under default-deny
is fail-closed behavior.

## 55. DAP debugger client (fourth round, part 2)

**What**: a Debug Adapter Protocol client. The new zero-dependency
`@ai-factory/debugger` package (pure node builtins): `framer.ts`
(Content-Length framing), `ws.ts` (hand-written WebSocket client),
`cdp.ts` (minimal CDP client), `launchjson.ts` (launch.json
parsing/normalization), `client.ts` (DebugClient: spawns the adapter,
DAP requests/events, fail-closed), `node-adapter.ts` (DAP↔CDP bridge
child process). Compatible with `.vscode/launch.json`, **Node.js
first**: launch runs `node --inspect=127.0.0.1:0` (loopback), attach is
loopback-only (127.0.0.1 enforced). Server `routes/debug.ts`:
`GET /api/debug/configs`, `POST /api/debug/sessions` (201), `GET`
list/detail, `:id/output` (200-line cap), `:id/breakpoints`
(breakpoints/conditional/logpoints), `:id/{continue,next,step-in,
step-out,pause}`, `:id/{stack,scopes,variables}`, `:id/evaluate`,
`DELETE :id`. Max 8 concurrent sessions (409 beyond); error codes
404/409/410/502/504; audit `DEBUG_SESSION_STARTED`/`STOPPED`/
`BREAKPOINTS_SET`. Desktop DebugPanel: config picker/launch, breakpoint
drafting, stepping, call stack, variables, watch, output polling.

**How**: pick a launch.json config in the Debug panel → launch → set
breakpoints (conditional/logpoints) → step → inspect stack/variables →
evaluate expressions; draft conditional breakpoints/logpoints before
sending.

**Honest boundaries**: Node.js only for now; chrome/python/coreclr/
compound configs are reported unsupported, never silently
reinterpreted; evaluating without a frameId gives an honest 500
dap-error (the desktop passes a frameId); pausing on a `return` line
during step is standard V8 behavior (checking the return value),
reported as-is, not a bug; adapter spawn failure/crashes fail closed.

## 56. Database browser (fourth round, part 2)

**What**: an IDE-style database browser. **SQLite/Postgres first**.
The new zero-dependency `@ai-factory/dbbrowser` package:
`sql-guard.ts` (fail-closed pure function with four verdicts — read:
SELECT/WITH..SELECT/EXPLAIN/read-only PRAGMA; write: INSERT/
UPDATE..WHERE/DELETE..WHERE/CREATE TABLE|INDEX|VIEW/additive ALTER;
destructive: DROP/TRUNCATE/ALTER..DROP COLUMN|RENAME/DELETE|UPDATE
without WHERE — needs a ticket; blocked: multi-statement/ATTACH/VACUUM/
transaction control/unknown), `drivers.ts` (`SqliteDriver` via
node:sqlite; `PostgresDriver` with a hand-written minimal PG wire
protocol: startup + simple query, trust auth, no SSL, no prepared
statements, values as text), `schema.ts` (introspection via PRAGMA /
information_schema; `createTableDdl`; additive-only `diffSchemas` —
deletions are reported, not scripted; `schemaToErGraph` relationship
graph), `browser.ts` (env-scoped connections; `updateRow` re-reads and
verifies per column after write — never "pretends success"). Server
`routes/dbbrowser.ts`: connection registration (sqlite paths jailed
into the data dir, `PATH_ESCAPED` 403; prod registration requires an
existing file or 404s), query console, table editor
(paging/filtering/sorting/row edits), schema diff, DDL generation, ER
graph; destructive statements never run inline:
`destructive/request` (201 ticket) → `destructive/approve` (explicit
`decided_by`) → `destructive/execute` (single-use, 15-minute TTL, bound
to connection + statement sha256, re-classified at execute time).
Audit: `DBB_CONNECTION_REGISTERED/REMOVED/WRITE/ROW_UPDATED/
DESTRUCTIVE_REQUESTED/APPROVED/EXECUTED` (reads aren't audited).
Desktop DbBrowserPanel (new Database tab in the bottom panel).

**How**: register a connection in the Database tab → query console for
read-only SQL → table editor for paged row edits (re-read verified) →
schema diff for additive DDL → the ticket flow for anything
destructive. Prod data is never written directly
(`PROD_WRITE_REFUSED`); the only route is promote via DB time travel.

**Honest boundaries**: the Postgres driver was verified only against
an in-process protocol stub — never against a live Postgres server
(none in this environment), stated in the UI, package header, and
reports; the destructive ticket doesn't reuse `/api/approvals` (the
approval store forces a `task_id` foreign key — the official endpoint
500s without one), so it runs its own audited ticket state machine;
the table editor validates identifiers against the schema and binds
values as parameters.

## 57. HTTP/REST client (fourth round, part 2)

**What**: an `.http`-file HTTP/REST client. The new zero-dependency
`@ai-factory/httpclient` package (hand-rolled node:http/https, no
cookie jar): `parse.ts` (`###` multi-segment blocks, METHOD URL,
headers, body after a blank line, `>` assertions, `@timeout-ms`
directive, comments; fail-closed with line numbers), `envs.ts`
(environment merge: selected environment vars < explicit variables;
`{{var}}` substitution, unknown names left literal), `client.ts`
(default 10s timeout, 5MB response-body cap, **no redirect
following**). Six assertion kinds: `status == 200`, `status-class`
(2xx/3xx/4xx/5xx), `header` (eq/contains), `body-contains`,
`json-path` (exists or eq), `max-time-ms`. Server
`routes/httpclient.ts`: `POST /api/http/run` (parse → env merge →
**every URL through the egress firewall gate** before sending → send →
assert; a blocked request is recorded `blocked:true` while the rest
continue; audit `HTTP_CLIENT_RUN` records only method/host/path/
status), `GET/PUT /api/http/environments`
(`<project-root>/.ai-factory/http-env.json`, jailed + validated).
Desktop HttpPanel (.http editor, environment JSON, per-request
status/timing/assertions/body preview, blocked display).

**How**: write `.http` blocks in the HTTP tab → pick an environment →
send → check per-request assertions and blocked state; environments
live in `.ai-factory/http-env.json`.

**Honest boundaries**: redirects are not followed (3xx reported
as-is); the 5MB body cap records the real `bytes` size; json-path
supports only dot paths + `[n]`, no wildcards; unknown `{{var}}` stays
literal; egress is enforced in the route layer before sending — the
package itself has no gate; a malformed assertion like `> status 200`
fails closed with 400.

## 58. Performance profiler (fourth round, part 2)

**What**: real V8 sampling. The new zero-dependency
`@ai-factory/profiler` package (pure node builtins): `spawn.ts`
(child runs `node --cpu-prof`; on timeout the child gets SIGTERM first
so the profile can flush — if nothing lands, it fails closed with
`no-profile`, never partial data), `cpu.ts` (parses .cpuprofile →
hotspot top-10 by self/total + folded flame tree), `flame.ts` (SVG
flame-graph rendering), `heap.ts` (a `--require` preload that writes a
real `v8.writeHeapSnapshot()` in an exit hook — CJS/ESM, no --inspect
needed; per-constructor count/self-size stats plus snapshot diff for
leak hunting). Server `routes/profiler.ts`:
`POST /api/profiler/cpu` (`{script, args?, timeoutMs?,
sampleIntervalUs?}`), `POST /api/profiler/heap`; jail: 403 escaped/404
missing/400 non-js; timeout capped at 120s (min 1s); audit
`PROFILER_CPU_CAPTURED` / `PROFILER_HEAP_CAPTURED`. The desktop
ProfilerPanel renders the SVG flame graph from **real sampled data**,
not a mockup.

**How**: enter a script in the Profiler panel → CPU sampling shows
hotspots/flame graph → heap snapshots show constructor rankings, and
diffing two snapshots hunts leaks; nonexistent scripts 404 fail-closed.

**Honest boundaries**: the heap table shows self sizes (retained size
isn't computed — the column labels say so); sampling is statistical
(responses carry sampleCount/totalUs); heap scripts must exit on their
own — long-running servers hit the timeout; 120s timeout cap.

## 59. Terminal command history (fourth round, part 2)

**What**: VS Code shell-integration-style command history. The new
zero-dependency `@ai-factory/termhistory` package: `markers.ts`
(marker scanning + rcfile generator + wrapper), `tracker.ts`
(`CommandTracker` state machine: only a full B→C→D→H sequence
records, anything else is discarded), `fuzzy.ts` (subsequence fuzzy
scoring where consecutive runs outscore scattered letters),
`store.ts` (`HistoryStore`:
`<dataDir>/terminal-history/history.jsonl`, JSONL, dedupes
consecutive repeats, skips corrupt lines, compacts over limit). The
OSC 133 marker protocol: A=prompt start, B=input start (PS1 prefix,
re-patched before every prompt), C=command start (DEBUG trap),
D;`<code>`=real exit code, E;`<b64>`=BASH_COMMAND (fallback),
H;`<b64>`=exact input line (`fc -ln -1`). Injection: bash sessions
get a `bash -c` wrapper, the rc text travels via the
`$AF_SHELL_INTEGRATION_RC` env var (env penetrates bwrap), landed as
`--rcfile` under the session's /tmp. Server `routes/terminal.ts`: bash
sessions auto-wrapped (sh skipped → `integrated:false`), commands land
on disk best-effort, `GET /api/terminal/history` (fuzzy,
cross-session), `GET /api/terminal/sessions/:id/commands`
(`integrated` flag + exit codes). Desktop: TerminalPanel writes output
per segment, hangs decorations at C and green/red overview-ruler marks
at D by exit code; the status bar gains ↑/↓ command jumping plus a
history button; a search overlay (grouped, ↑↓/Enter/Esc, Enter inserts
without executing); `terminalHistory.ts` is the line-protocol client
mirror.

**How**: use the terminal normally — bash sessions record
automatically; the history button or search overlay finds commands
across sessions with fuzzy matching, Enter inserts without executing;
`$?` is correctly preserved in the DEBUG trap (verified
D;0/D;1/D;2/D;42, Ctrl+C → D;130).

**Honest boundaries**: history exists for bash only — sh sessions
report `integrated:false`, nothing invented; when H is empty
(HISTCONTROL discarded) the E fallback concatenation is an
approximation; desktop decorations are overview-ruler color bars (no
real-browser visual check in this environment; tsc + unit coverage).
**Closeout found a real regression**: A8's OSC markers broke the
Batch-48 cross-chunk redactor's longest-first decision (marker bytes
split a long secret's two halves, leaking the tail) —
`packages/secrets/src/broker.ts` now matches on an OSC-stripped view
coordinate space (control bytes are zero-width), carry/holdback logic
unchanged, writes map back to raw coordinates; `OSC_MAX_LEN=65536`
bounds pending growth; +3 regression tests.

## 60. Global keybinding system + which-key (fifth round, part 1)

**What**: one keybinding system for every command — each command has an ID (`palette.toggle`, `language.switch`, `go.tab.*`, `bookmark.toggle`, …) with default keys merged with a user layer. When you press a chord-sequence prefix, a which-key popup lists the keys you can press next, so nothing needs to be memorized.

**How**: the Keybindings settings panel lets you search, rebind, delete, and reset per command; conflicts resolve last-binding-wins and the overridden binding is named in the conflict-warning zone, never silently dropped. Chord-sequence timeout defaults to 1s (adjustable 200–5000ms). The configuration persists through the server (`GET/PUT/DELETE /api/keybindings`, plus `/api/keybindings/schema`).

**Honest boundaries**: keybindings only take effect in the desktop app — the server only stores and validates the configuration and has no keyboard context; Monaco's built-in editor keys are never hijacked; unmodified keys are never intercepted inside input fields; `mod` resolves per platform (⌘ on macOS, Ctrl on Windows/Linux).

## 61. Declarative task runner (fifth round, part 1)

**What**: a VS Code tasks.json-compatible task runner — declare build/test/watch tasks in `.ai-factory/tasks.json` and chain them with `dependsOn`. If planning fails, a dependency is unknown, or a cycle is detected, the whole plan is rejected and nothing runs; task output is parsed by registered problem matchers into diagnostics in the Problems panel.

**How**: `GET /api/tasks/list` shows the parsed tasks; `POST /api/tasks/run` runs a chain (a failed/denied/timed-out task stops the chain fail-closed and dependents never execute); `GET /api/tasks/runs` shows the last 20 run records; `PUT /api/tasks` writes tasks.json.

**Honest boundaries**: task commands go through the existing exec security policy (allowlist/deny patterns/control-dir guard) — no new execution channel; `type:"shell"` tokenizes quote-aware and runs directly, it is not `/bin/sh`; per-task timeout defaults to 60s (configurable 1–300s) and output is capped at 2MB. Note: bare `GET /api/tasks` is the legacy project-tasks endpoint; the runner's list is `GET /api/tasks/list`.

## 62. Three-way merge conflict editor (fifth round, part 1)

**What**: a three-pane solver for git merge conflicts — ours/base/theirs aligned side by side (hand-rolled diff3), with per-hunk take-ours / take-theirs / take-both / custom-text; genuinely tricky conflicts are labeled "needs manual review"; a shadow checkpoint is taken before write-back so you can roll back.

**How**: open the Merge panel, pick a repo, see the conflicted files, analyze the alignment, resolve hunk by hunk, then resolve to write back (optional stage, i.e. `git add`). If the file changed after analyze, `409 MERGE_DRIFT` refuses the write — analyze again first.

**Honest boundaries**: diff3 alignment is a heuristic line alignment, not an authority; diff3-style markers (`|||||||`) are explicitly rejected, never misread; staging is only `git add`, never commit/push; binary files, files over 512KB, symlinks, path escapes, and non-git directories are all refused.

## 63. Git blame inline annotations + Timeline (fifth round, part 1)

**What**: inline blame on the current editor line (short hash · author · date), plus a Timeline center panel — a fused git-log × Local-History-snapshot timeline where you can pick two points and diff them as unified diff.

**How**: annotations appear when you open a file; in the Timeline panel pick two points and `/api/timeline/diff` shows the diff; in a non-git directory the timeline only shows snapshots.

**Honest boundaries**: blame and the timeline are snapshots of the request moment; uncommitted lines are labeled "uncommitted" and never attributed; `/api/blame` on a non-git directory returns `409 NOT_A_GIT_REPO`; blame is capped at 2000 lines on large files (`truncated` flag), diffs at 6000 lines / 512KB; snapshot times come from filename epochs while git times are author-time.

## 64. Unicode confusable / invisible character highlighting (fifth round, part 1)

**What**: Trojan Source protection — scans files for bidirectional control characters (9 kinds), zero-width characters (4 kinds), and lookalike confusable characters (a 53-item hand-maintained subset covering Latin/Cyrillic/Greek), with three-color inline highlighting in the editor plus hover showing code point and character name; also exposed as the `unicode-trojan` inspections checker.

**How**: files are annotated automatically when opened; `POST /api/trojan/scan` can scan inline text or a jailed path; `trojan-scan-ignore` suppresses a whole file.

**Honest boundaries**: the confusables list is a 53-item hand-maintained subset, not the full Unicode table; lookalikes only trigger inside mixed-script tokens; U+FEFF is exempted only as a file's first character; annotations only, nothing is auto-rewritten.

## 65. Snippet library (fifth round, part 2)

**What**: trigger-word + Tab-expanding code snippets — `$1`/`${1:default}`/`$0` placeholders with Tab navigation and `${DATE}`/`${TIME}`/`${FILENAME}` built-in variables; grouped by language, 7 read-only built-in snippets, and plugins can contribute via the registry.

**How**: type a trigger word in the editor → the snippet appears in Monaco completion → Tab expands it and jumps between placeholders; the Snippets panel adds/edits/deletes your own snippets (stored in `.ai-factory/snippets.json`); `GET /api/snippets/schema` documents the format.

**Honest boundaries**: expansion is pure text substitution and never executes code; nested placeholders are rejected by validation; unknown `${NAME}` expands to empty rather than guessed; Tab is never intercepted (snippets only appear through completion); manifest-level `contributes.snippets` is not in v1.

## 66. Spell check (fifth round, part 2)

**What**: identifier spell checking — tokenizes by camelCase/underscore and looks words up in a hand-maintained English dictionary subset; wavy underlines with edit-distance suggestions on hover; one-click "add to dictionary" quick fix in the Inspections panel.

**How**: files are annotated when opened; the project dictionary `.ai-factory/spell-dictionary.txt` is managed via `GET/POST/DELETE /api/spell/dictionary`; `spell-check-ignore` suppresses a whole file.

**Honest boundaries**: the dictionary is a hand-maintained subset, not a complete English lexicon; v1 is English only — Chinese word segmentation is explicitly out of scope; ALL-CAPS tokens are skipped as abbreviations (unknown abbreviations are a documented miss class); annotations only, nothing auto-rewritten; project-level checks don't carry suggestions.

## 67. Search editor (fifth round, part 2)

**What**: opens full-project search results as a saveable `.code-search` file — a query header (query/regex/case-sensitivity/glob) plus per-file grouped results that fold and click-through; saved files can be reopened to reproduce the search and re-run to refresh.

**How**: fill in the search panel and "Open in editor" to save under `.ai-factory/searches/`; `POST /api/codesearch/search` searches directly (literal/regex/glob modes).

**Honest boundaries**: results are a snapshot of the query moment — you must explicitly re-run after files change; no index, walks on demand (slower than indexed engines on large trees); default 2000 hits, hard cap 10000, over-limit results flagged `truncated`; binaries/symlinks/oversized files are skipped or honestly flagged.

## 68. Bookmarks (fifth round, part 2)

**What**: line/file/directory bookmarks with alphanumeric mnemonics for instant jumps — 0-9 default to `ctrl+digit`, a-z are bindable; the Bookmarks panel groups by directory and renames/deletes; line bookmarks keep 5 lines of context and re-locate by context within ±300 lines when the file changes.

**How**: `bookmark.toggle` toggles a bookmark on the cursor line (goes through the keybinding system, rebindable); set mnemonics and jump in the panel; `POST /api/bookmarks/toggle` is idempotent; persisted server-side in `AI_FACTORY_DATA_DIR/bookmarks.json`, isolated per project root.

**Honest boundaries**: when no context is found the bookmark is flagged "drifted" and never jumps; renames/deletes are not followed (resolve 404s — delete manually); mnemonics are unique per project root and `ctrl+digit` conflicts go through the keybinding conflict warnings; 500 bookmarks per root; no cross-machine sync in v1.

## 69. Scratch files (fifth round, part 2)

**What**: a project-independent scratch area — create drafts by language with full syntax highlighting; typescript/javascript run with one click through the shared exec safety channel; json/markdown/plaintext are edit-only.

**How**: the Scratches panel creates/renames/deletes/filters by language; `POST /api/scratches/:id/run` runs it; drafts live in `AI_FACTORY_DATA_DIR/scratches/` and survive IDE restarts.

**Honest boundaries**: drafts never enter the project tree (no git/index/snapshots); not audited; running executes arbitrary code and only ever happens on explicit user trigger; scratch content is NOT covered by the pre-send prompt secret scan (the panel warns you — don't paste secrets); only node-whitelisted languages can run; no cloud sync.

## 70. Plugin system and extension API (sixth round, part 1)

**What**: a local subset of the VS Code extension API — local extension install and management, with no cloud marketplace of its own. Extensions live in `<root>/.ai-factory/extensions/<name>/` and can contribute four kinds: commands, panels, checkers, and context providers. Extension code runs in a node:vm sandbox (code generation disabled, no require/process/Buffer/eval; arguments and results cross only as JSON strings), with a permission whitelist of exactly 4 items: commands.execute, panels.contribute, checkers.contribute, providers.contribute.

**How**: the Extensions panel installs/enables/disables/uninstalls; `GET /api/extensions` lists installed extensions (including broken dirs), `POST /api/extensions/install` (inline) and `install-from-dir` (jailed, symlinks refused) install; commands run via `POST /api/extensions/:name/commands/:cmd/run`, providers resolve via `providers/:id/resolve`. Three built-in example extensions cover three kinds: hello-command (command), info-panel (panel), marker-checker (checker).

**Honest boundaries**: v1 implements only an API subset, not the full VS Code extension API; no cloud marketplace, no auto-update; the vm sandbox blocks naive escapes but is not a multi-tenant security boundary, and installing itself requires operator permission; caps: main 256KB, 50 commands, 20 panels/checkers/providers each.

## 71. Git interactive rebase editor + stash management (sixth round, part 1)

**What**: a visual porcelain wrapper around `git rebase -i`, plus visual stash management. Rebase todos support pick/reword/squash/fixup/drop drag-reordering; stash supports view/apply/drop/by-name management. Every rewriting operation takes a shadow checkpoint snapshot first and can roll back; semantic conflicts are not resolved here — they still go through the three-way merge editor.

**How**: reorder todos in the Rebase panel and submit; `GET /api/rebase/todos?repo=&base=` fetches base..HEAD as pick lines, `POST /api/rebase/start` (returns a checkpointId), abort/continue/skip, `POST /api/rebase/restore` restores from the shadow checkpoint; stash via `GET /api/stash` and `POST /api/stash/push|apply|pop|drop`.

**Honest boundaries**: porcelain-level operations only, no filter-branch/filter-repo history rewriting; reword accepts a single line in v1; a conflicted stash pop keeps the entry; when the shadow checkpoint is unavailable the rebase request is refused with 503 — history is never rewritten bare.

## 72. File watching triggers (sixth round, part 1)

**What**: file-change triggers — watch a directory tree, debounce and coalesce changes, then run a tasks.json declarative chain. Rules live in `<root>/.ai-factory/watch.json` (tmp+rename atomic writes) and fire through exactly the same task channel as a manual run; trigger history is an in-process ring (50 entries) while the rules themselves persist.

**How**: the Watch panel (bottom bar) creates rules (glob match, target chain label, debounce ms), enables/disables, and `POST /api/watch/activate` starts all; `GET /api/watch/rules`, `GET /api/watch/triggers` (history), and `GET /api/watch/status` report state.

**Honest boundaries**: triggers only — no incremental compilation; every trigger runs the whole chain; a chain run serializes per rule (a trigger arriving mid-run queues at most one, later ones coalesce into it); watchers live in the server process, so restart requires "start all" to recover; 5000 watched directories fail-closed; more than 200 files in one window coalesce into a burst trigger with a label; recipe apply is never auto-triggered (approval gate).

## 73. Parallel task queue (sixth round, part 1)

**What**: a background task queue — multiple tasks run in parallel or queue, with live status (queued/running/succeeded/failed/cancelled) and per-task cancel. It reuses the fifth-round task runner (tasks.json) execution channel and exec safety policy — no second execution channel; output is parsed through the problem matchers.

**How**: the Queue panel (bottom bar) submits, watches the queue, cancels, and inspects output; `POST /api/taskqueue/submit`, `GET /api/taskqueue/jobs`, `GET /api/taskqueue/jobs/:id/log`, `POST /api/taskqueue/jobs/:id/cancel`, and `PUT /api/taskqueue/config` tune the concurrency cap.

**Honest boundaries**: jobs live only in the server process — queued/running jobs are lost on restart, with no persistent recovery; tasks inside one job run in dependency-topological order serially; parallelism happens between jobs only; default concurrency cap 4 (capped by CPU count logic), configurable 1–32, overflow queues FIFO; the job log is a 512KB sliding window (oldest bytes dropped and marked), not a full transcript; per-job diagnostics cap at 200 entries; cancel kills the whole POSIX process group, degrading on Windows to killing only the direct child.

## 74. Task scheduling / scheduled tasks (sixth round, part 1)

**What**: an increment on the existing scheduler — it can now schedule tasks.json declarative chains, adding a task-runner job type, once-only schedules, and overlap skipping. Schedules persist in `AI_FACTORY_DATA_DIR/schedules.json` and survive restarts; per-schedule recentRuns records cap at 50; cron is parsed in UTC, stated twice — in the API (`cronTimezone: 'UTC'`) and in the UI.

**How**: the Schedules panel creates cron/interval/once schedules (four job types), pauses/resumes/triggers-now/deletes/views run history; `POST /api/schedules` creates, `GET /api/schedules/:id/runs` lists records (newest first); a once schedule parks itself after firing, and creating one in the past is refused.

**Honest boundaries**: fires only while the server runs — no system-level daemon; misses are never caught up (only recorded as missed); cron granularity is 1 minute minimum, interval 60 seconds minimum, sub-minute intervals are out of v1; when the previous run has not finished, the slot is recorded as skipped (SCHEDULE_SKIPPED audit + run record), never queued or piled up; a bad root or missing label only records a failure, never crashes; an unwired task-runner job fails closed and never executes.

## 75. Rules file tiered management UI (sixth round, part 2)

**What**: two-tier rule management — global `~/.ai-factory/rules/rules.json` and project `<root>/.ai-factory/rules.json`, with priority and merge relationships shown explicitly; a project rule of the same name overrides the global one, annotated both ways (global list marks overriddenBy, effective entries mark overrides). AGENTS.md / .cursorrules / .clinerules at the project root are shown read-only and never rewritten.

**How**: the Rules panel adds/edits/enables/disables/reorders whole tiers (ids must be an exact permutation of the tier, else 400); `GET /api/rules?root=` shows the four-part view (global/project/compat/effective), `POST /api/rules`, `PATCH /api/rules`, `DELETE /api/rules`, and `POST /api/rules/order` manage.

**Honest boundaries**: compat files are read-only in v1 — the panel has no edit entry for them; rule content gets no semantic validation; caps are 200 rules per tier, 64KB per rule, 512KB compat truncation; rule changes are audited (RULE_ADDED/UPDATED/DELETED/REORDERED); rules themselves drive no execution channel.

## 76. Custom slash commands (sixth round, part 2)

**What**: an extension of the W-B slash command mechanism, not a second parser. Three bindings: template (existing W-B behavior, deterministic `{args}` / `{args:N}` expansion), command (alias for a command-palette command id), and task (alias for a tasks.json chain label, executed through exactly the same policy/audit/record channel as a manual run). User tier `AI_FACTORY_DATA_DIR/slash-commands.json` (W-B file compatible as-is) and project tier `<root>/.ai-factory/slash-commands.json`; resolution order is project > user > builtin.

**How**: the Slash Commands panel adds/edits/enables/disables/deletes/test-runs; `GET /api/commands` (merged list + warnings), `POST /api/commands` manages, `POST /api/commands/execute` runs; the command palette gains a slash group (fetched on open, disabled items skipped); task-binding args append only to the requested task — dependency tasks keep their declared args.

**Honest boundaries**: slash commands are only aliases + arg templates — no natural-language parsing; builtin-name conflicts still default to 409, and an explicit `override: true` is required to cover one, with warnings on both the list and execute responses; disabled commands are listed but execute with 409; task bindings never modify tasks.json or dependency-task args; command bindings return only a descriptor server-side and are dispatched by the desktop — the server never executes a desktop command.

## 77. .env / environment variable visual management (sixth round, part 2)

**What**: a visual .env editor — parsing (comments/blanks/`export ` prefix/single-double quotes/inline comments/duplicate keys last-wins) plus round-trip writes (only set/delete lines change; everything else is preserved byte-for-byte). The security line is enforced in code, not UI: list responses are fully masked, plaintext leaves only via `/reveal`; secret warnings reuse the same SECRET_PATTERNS table as the pre-send gate.

**How**: the .env panel shows the key table, per-line reveal/hide, suspected-secret badges, add/edit/delete, missing-key validation, load-into-task, and a gitignore hint; `GET /api/env` lists, `GET /api/env/reveal` reveals, `POST /api/env` writes; loading into a task environment is a one-run in-memory overlay only — it never writes tasks.json, and a task's own options.env wins over overlay values.

**Honest boundaries**: an editor, not a secret vault (values are stored plaintext in .env); reveal is pinned to the operator role (viewers never get it, even on GET) and audits only key names, never values; write/load audits record key names only; warnings are advisory and never block a save (.env is a legitimate home for secrets); v1 does not support multi-line quoted values or lines without `=` (parsed as invalid lines, warned, preserved verbatim on write); file cap 512KB; a .env missing from .gitignore only prompts — it is never rewritten automatically.

## 78. Vim mode (sixth round, part 2)

**What**: a Vim key layer for the editor — normal/insert/visual/visual-line/command-line modes, registered through the fifth-round keybinding registry (`vim.toggle` command, no default key — users bind it themselves), not a second binding system. Off by default, persisted in localStorage, with the mode shown as a pill in the editor toolbar.

**How**: toggle from the editor toolbar or the `vim.toggle` command; motions (h j k l, w W b B e E, 0 ^ $, gg G, f F t T, %), operators (d c y including dd cc yy) + counts, editing (x X r p P i a A I o O J D C Y), visual d x y c and o to swap the anchor; u goes through Monaco undo, Ctrl+R through Monaco redo; command-line `:w` saves.

**Honest boundaries**: v1 has no macros, named registers, search (/ ? n N), `.` repeat, marks, text objects, visual-block, `:q` or any other Ex command (command line is `:w` only, everything else reports E492); when Vim is on and the editor is focused, unmodified keys are consumed by the Vim layer first and never trigger global which-key sequences, while Ctrl/Cmd/Alt chords still go through the keybinding registry.

## 79. Data file preview (sixth round, part 2)

**What**: a read-only table preview of data files — JSONL/NDJSON parsed line by line as JSON objects, CSV parsed in RFC 4180 shape (quoted fields, doubled-quote escapes, commas/newlines inside quotes, first record as header). Columns are the union of keys in first-appearance order; sorting is numeric-aware with nulls last and stable; filtering is a case-insensitive substring over any column; pagination defaults to 100, cap 500.

**How**: the DataPreview panel loads by relative path, sorts by clicking column headers, filters, and pages; `POST /api/datapreview/preview` (inspection-root jail gives 403 on escape, 413 over the 64MB file cap, fail-closed 400/404/415 for directory/missing/bad format).

**Honest boundaries**: read-only preview, no edits, no write-back; this is a file preview, not a database browser (it connects to no database); caps are 100,000 rows, 200 columns, 64MB files, 4096 characters per cell — overflows truncate with a label; malformed rows are skipped and counted, never format-guessed; previews are snapshots — reload after the file changes.

## 80. Desktop default per-install API token (V3.0 audit, part 1)

**What**: the fix for V3.0 audit P0-4 — the desktop no longer serves an unauthenticated loopback API by default. Each install generates its own token, stored in a 0600-mode token file; the server refuses to start without a credential (and no explicit opt-in), fail-closed; the Electron renderer fetches the token through the preload bridge, and the desktop offers a rotation entry.

**How**: the token is generated and persisted on first start; `GET /api/auth/whoami` shows mode and role; `POST /api/auth/rotate` rotates (the old token dies immediately; there is no separate revoke endpoint); explicit open-local mode (`FACTORY_ALLOW_OPEN_LOCAL=1`) renders a warning banner on the desktop, with the top bar also marked "local mode (no token)".

**Honest boundaries**: loopback-only default auth — a non-loopback bind without credentials is likewise refused at start (pre-existing behavior); under Vite dev (no bridge) a rotated token lives only in the localStorage fallback and server memory, reverting to the start-time env token after a server restart — the Electron path has no such issue; a bare `node --test` run (no wrapper) rejects token-less test starts under the new default, as intended, while the `npm run test:server` wrapper explicitly opts in.

## 81. Packaged smoke test + cross-platform verification pipeline (V3.0 audit, part 1)

**What**: a smoke script for the packaged product itself plus a Win/mac verification pipeline definition. `scripts/packaged-smoke.mjs` runs 14 checks against `release/linux-unpacked` or an extracted AppImage dir (layout, launch, health, token, panel tab count, zero backends after quit); `scripts/cross-platform-check.mjs` prints a 6-row platform-difference matrix (sandbox, process-group kill, paths, line endings, signing/notarization, installer format), with non-current platforms marked NOT_RUN plus exact rerun commands.

**How**: `npm run smoke:packaged` (after a Linux build) and `npm run verify:platform`; rerun the same script on Win/mac — never substitute Linux results. The platform-difference list lives in `docs/verification/platform-matrix.md`.

**Honest boundaries**: Linux x64 smoke 14/14 (Electron 44.8.0, 57 tabs, 0 page errors); Win/mac packaged artifacts, signing/notarization, sandbox degradation paths, and install flows are all unverified — all three platforms are currently unsigned, a script-measured fact, and certificate purchase is Tan's action; this VM has no bwrap, so the sandbox can only be verified as "probe unavailable + degradation auditable", not as "builds inside the sandbox".

## 82. Golden path wizard + tiered panel navigation (V3.0 audit, part 1)

**What**: the 57 center tabs in three tiers (12 common, advanced, expert) + a 4-step golden path wizard (pick a project → run checks → create a task → watch approvals) + empty-state guides for 20 panels. The tier toolbar sits outside `.center-tabs`, so e2e tab index order is unchanged; collapsing a tier only hides buttons with CSS — no feature removed, no route semantics changed.

**How**: the tier toolbar switches common/advanced/expert/all, auto-expanding a collapsed tier when navigated into; the wizard can be skipped and reopened, each step jumping to an existing flow the user marks complete manually; the Top 20 empty-state guides cover each panel's next step.

**Honest boundaries**: the wizard is a guidance checklist, not an auto-executor; the V3 report's "2–3 real users walk the golden path and log friction" was not done, so the 100% wizard success criterion is unverified; the smoke test started no server (a pure desktop UI change).

## 83. IDE performance benchmark suite + CI gate (V3.0 audit, part 1)

**What**: `packages/perfbench/` + `scripts/perfbench.mjs` + `scripts/perf-gate.mjs`: 11 measured tasks (server-boot, index, repomap, search, SQLite writes, large-file-scan, concurrent-task P95, unit-sample) + a canonical baseline `packages/perfbench/baselines/baseline.json` + a gate (self-compare warn PASS, a +50% regression warns through, block fails with exit 1, missing baseline passes under block with a noBaseline mark).

**How**: run the baseline, then compare with `scripts/perf-gate.mjs`; baseline run2: server-boot 2760ms, index-small 653ms, repomap-medium 109367ms, search-medium 508ms, SQLite 2000 autocommits 108344ms (20000 batched only 121ms), concurrent-task p95 650.73ms.

**Honest boundaries**: the gate stays warn — on this 2-core shared VM the same tier varied 18–23x across runs, so a 20% threshold would certainly false-positive; block requires 3 stable runs on the same machine first; the SQLite autocommit bottleneck is per-write fsync and repomap's medium-tier superlinear growth are recorded leads, not fixes here; large-file-scan is a read + tokenize proxy, not a real Monaco large-file render; Win/mac measurements, the large tier (100k files), and vite-build are opt-in and unrun.

## 84. Egress firewall default tightening + first-run wizard (V3.0 audit, part 1)

**What**: missing-file default is now enabled + deny + factoryDefault, replacing the old allow-all default; a first-run wizard with 8 templates (npm, pypi, and more, including the closeout-added `web-search` template for `www.bing.com`), each with a description and risk note; legacy files without policyVersion keep their rules verbatim, merged note-stamped when the wizard completes; explicit dev-mode OFF is audited, and dismissing the wizard creates no file (only a dismissed timestamp).

**How**: the EgressWizard panel completes/dismisses/reopens the wizard; `GET /api/egress/wizard`, `POST /api/egress/wizard/complete|dev-mode|dismiss`; every policy change is audited (EGRESS_CONFIG_UPDATED / WIZARD_COMPLETED / DEV_MODE / DISMISSED).

**Honest boundaries**: the firewall governs domain rules only — it does not defend against DNS rebinding, stated in both UI and code comments; dev-mode allow-all is an explicit operator choice and is audited, not a silent fallback; after tightening, the built-in Bing RSS search is 403 on a fresh install until the wizard explicitly allows the `web-search` template (a regression fixed at closeout).

## 85. LSP code intelligence (V3.0 audit, part 2)

**What**: new package `packages/langsrv/` (zero new dependencies): a TypeScript compiler API precision engine (go-to-definition, references, hover, outline, rename preview — edits computed only, files never written) + a zero-dependency LSP client (external language servers are clients only, never bundled; `FACTORY_LANGSRV_LSP_COMMAND` takes priority when configured) + codeindex heuristics as a third-tier fallback. Priority is LSP → semantic engine → heuristics; rename preview is semantic-only, 409 when semantics are unavailable.

**How**: the LangSrv panel (new center tab, advanced tier); `GET /api/langsrv/status`, `POST /api/langsrv/{definition,references,hover,outline,rename-preview}`; fallback responses always carry `source: 'heuristic'` + a warning — never a silent downgrade.

**Honest boundaries**: only TS/JS and dialects are precise; other languages fall back to heuristics; single-root scope, 3000-file cap with 409 beyond it; tree-sitter was refused (native/wasm external dependency, breaking the zero-dependency policy); accuracy spot-check (first 50 call-shaped identifiers in langsrv/src + server routes): semantic 49/50, heuristic baseline 21/50, the single semantic miss being a doc-comment-line sample artifact.

## 86. Cascade-style task timeline UI (V3.0 audit, part 2)

**What**: tasks.json chain run records upgraded to a full timeline: cards in execution order + unrun steps explicitly skipped + unknown commands partial; `GET /api/tasks/runs/:id` (full cards + shadow checkpoints matched by run root), `POST .../rollback` (audited TIMELINE_ROLLBACK), `POST .../rerun` (same executeChain, new run linked via rerunOf/rerunFrom). The desktop CascadeTimelinePanel sits at the bottom of TasksPanel — no new center tab.

**How**: the timeline panel shows step cards (command/status/exit code/duration/diagnostics/collapsible output/record summary), rollback (confirm), rerun, and checkpoint restore (via the existing shadow-checkpoint restore endpoint); the list view strips step output and the server root absolute path.

**Honest boundaries**: the timeline is an in-process record (ring cap 20 entries), cleared on server restart; rollback only marks later steps superseded — it deletes no history and changes no files (file restore goes through the shadow-checkpoint endpoint), and it does not stop same-name jobs already in the queue, which the panel warns about; checkpoint jumps depend on shadow workspace config and say so when absent.

## 87. Model-side cost governance policy layer (V3.0 audit, part 2)

**What**: merged into `packages/quota` (no new package): three budget tiers (task/person/project) x three units (usd-estimate/calls/tokens-estimate) x four periods (daily/weekly/monthly/all-time); 80% warns once → 100% trips (`checkAllowed` refuses new calls) → one-click release (reason required, else 400; clears only the current window, never raises the cap, audited); a new project's default monthly budget is a 10 USD estimate (an AI Factory policy default, not a vendor price); on trip, a project budget best-effort snapshots into a shadow checkpoint (label `budget-breaker:<id>`). Persisted to `<DATA_DIR>/budgets.json` with atomic writes; unknown shapes fail closed. The desktop BudgetPanel lives inside the Ops tab — no new center tab.

**How**: the Budget panel board/release; 11 `GET /api/quota/budgets/*` endpoints; apply-defaults is idempotent (an existing same scope+key+unit+period budget is kept verbatim; duplicate creation returns 409).

**Honest boundaries**: zero real model keys — all usage is simulated or hand-recorded, and costs and tokens are estimates; the conversion table's 3 rows are all `measured: false`, and unknown-unit estimates return null rather than invented numbers; real metering (provider token/bill wiring) is deferred until a model is actually connected, per the audit; the budget ledger keeps only the current window — cross-window history lives in the audit chain.

## 88. Extension trust model (V3.0 audit, part 2)

**What**: landed in `packages/extensions` (no new package): `trust.ts` (API version checks, Ed25519 sign/verify, trust verdicts, trust.json decision storage). Host API v1 is frozen; a missing `apiVersion` counts as legacy v1 with a warning, and a declared major version other than 1 is hard-refused; valid signature + official key = official auto-trust, valid signature + other key = auto-trust, invalid signature = install refused (fail-closed), unsigned = explicit trust required (inline install without `{ trust: true }` → 409 trust-required); review claims without a valid signature downgrade to unreviewed; trust verdicts are keyed by bundle hash, so any bundle change voids them.

**How**: the Extensions panel shows a trust badge row (review/signature/trust source/API version), a warning row, "trust and install" on an unsigned-install 409, and per-item trust/revoke buttons; audited EXT_TRUST_GRANTED/REVOKED; the 4 official examples (including the new demo-notes) carry `apiVersion: "1"` + `review: "official"` + an officially signed `signature.json`, with the resign tool `demo/sign-demo.mjs` (private key passed as an argument, never committed).

**Honest boundaries**: the vm sandbox is not a security boundary — the trust model only makes provenance auditable and the user's decision explicit, stated in the README, the schema, and desktop warnings alike; it never claims "untrusted extensions run safely"; the official private key is not in the repo, and rotation requires changing `OFFICIAL_PUBLIC_KEY_B64` and re-signing the examples.

## 89. Diagnostics bundle export + privacy disclosure (V3.0 audit, part 2)

**What**: new package `packages/diagpack/` (server-only, CJS single format): `GET /api/diagnostics/preview` (viewer; preview generates no bundle), `POST /api/diagnostics/export` (operator; requires `{ confirm: true }`, else 400; audited `DIAGNOSTICS_EXPORTED` with only bundle ID and section counts). A bundle holds only counts and stripped fields: audit details are never read in, task evidence is counts only, config is modes and counts only, and env var names and values never enter a bundle; redaction uses `@ai-factory/security` SECRET_PATTERNS + `maskSecret` throughout; `buildBundle` self-checks the serialized bundle and any hit throws, turning the route into a 409 with nothing shipped; nothing is uploaded — the bundle is returned to the caller for download. New center tab DiagnosticsPanel; privacy policy `docs/PRIVACY_POLICY.md` / `.en.md`.

**How**: the Diagnostics panel previews the list → confirms export → downloads JSON/HTML; preview first shows the excludes list (including secret classes) and the bilingual notice.

**Honest boundaries**: error excerpts are heuristic (the audit log has no severity column); the performance-baseline section depends on `FACTORY_PERFBENCH_BASELINE` and is marked unavailable when unset; a bundle holds no user file content or task titles — remote diagnosis needing verbatim text requires the user to supply it separately; the model-egress section is placeholder copy (adapters other than Codex are still stubs), stated in both panel and policy.

## 90. Remote development live access (seventh round, part 1)

**What**: new package `packages/remote/`: ssh/wsl/container/local transports (argv, no shell; path jail; timeouts and output caps), connection CRUD (12 endpoints), probing, policy-checked command execution (via `setRemoteExecPolicy(checkCommandPolicy)` into the existing exec channel), file round-trips, and ssh `-N -L` tunnels (tracked in-process, gone on restart). New center tab RemotePanel (advanced tier).

**How**: the Remote panel creates a connection → probes online → does directory/read/write/exec round-trips → starts/lists/deletes forwards; 12 `GET /api/remote/*` endpoints; keys are stored as paths only — the server never opens a key file; audit details carry only id/kind/outcome.

**Honest boundaries**: no real sshd/docker/WSL environment — the ssh path was verified via a PATH shim only; real remote hosts, containers, and WSL are unverified; `local` is an explicitly chosen loopback transport, so unprobed or disconnected connections return 409 on exec and file ops and never silently fall back to the local machine; remote debugging / remote LSP are out of scope.

## 91. Notebook interactive runs (seventh round, part 1)

**What**: new package `packages/notebook/`: versioned JSON documents (`<DATA_DIR>/notebooks/`), code cells + Markdown cells, per-cell run, run-all, clear-outputs, export (`?stripOutputs=1`). New center tab (advanced tier).

**How**: the Notebook panel creates a notebook → adds code cells → runs for output → moves/clears output/exports with-or-without outputs for comparison; 30s per-cell timeout, 64K characters per output stream (overflows marked truncated: true); only TS/JS can run; running a Markdown cell returns 400 not-code.

**Honest boundaries**: an honest deviation from the list — the list said "local Jupyter kernel access", but the brief specified the existing shared exec safety channel, so there is no Jupyter kernel wire protocol; each cell runs in its own node process, cells share no variables, and run-all is just sequential; notebooks are not audited and are not protected by the pre-send secret scan, which the panel footer warns about.

## 92. Test explorer UI (seventh round, part 1)

**What**: new package `packages/testexplorer/`: static discovery of `*.test.*` files as a package > file > case tree; runs reuse the node:test programmatic `run()` API (child process reports over fd 3 as JSON lines); spawned runners strip `NODE_TEST_CONTEXT` + `NODE_TEST_WORKER_ID` (against silent nested node:test downgrade); timeouts kill the process group; 512KB output cap, 8KB per-case failure-text cap; `POST /api/testexplorer/rerun-failed` (in-process last run). New center tab (advanced tier, appended last).

**How**: the TestExplorer panel shows the discovery tree + per-case/per-file/per-package/all runs + expandable failure output + rerun-failed; `GET /api/testexplorer/discover`, `POST /api/testexplorer/run` (case/file/package/all/cases scopes).

**Honest boundaries**: `*.spec.*` and `test.each` are out of v1; same-name leaf cases in one file all run (noted in the response); test paths containing deny words are fail-closed refused by the exec policy; after a server restart there is no last run to rerun (409 NO_FAILED_RUN).

## 93. Task dependency DAG (seventh round, part 1)

**What**: three genuine gaps on top of fifth-round S2 dependsOn planning and V3-#7 timeline skipped backfill: (1) `packages/tasks/src/graph.ts` adds `detectCycle()` + `dagLevels()` — PUT saving a cycle returns 400 `cycle-detected` and writes nothing (runtime plan-failed defense stays); (2) on dependency failure the dependent is recorded `skipped` with an error naming the root-cause failure (the original failure propagates, not the intermediate skipped node), audited `TASK_SKIPPED`; (3) `GET /api/tasks/graph` + desktop DagGraphPanel (embedded in TasksPanel, no new center tab).

**How**: DagGraphPanel picks a label and shows level-columned nodes (status-colored) and an edge list, plus run; linear chains behave unchanged, diamonds run once, stoppedAt semantics unchanged.

**Honest boundaries**: graph state comes from the in-process timeline ring and clears (null) on restart; the graph is a planning shape, not live execution tracing (per-step output and history live in the Cascade timeline); save-time cycle detection covers cycles only — unknown dependencies are still refused at runtime plan time.

## 94. Webhook event triggers (seventh round, part 1)

**What**: new package `packages/webhooks/`: HMAC-SHA256 + 300-second timestamp window + nonce ring + event-id dedup; the shared secret comes from the environment (`FACTORY_WEBHOOK_SECRET` or `FACTORY_WEBHOOK_SECRET_FILE`) and never enters webhooks.json, responses, logs, or audits. The receive endpoint `POST /api/webhooks/receive` is the single exact route bypassing the API token gate in `index.ts` (HMAC auth); events never select a chain and never pass parameters (a body `chainLabel` is ignored, proven by smoke test) — the chain comes from the endpoint config and runs via `runTaskChainByLabel`. New center tab (advanced tier).

**How**: the Webhooks panel manages endpoints (CRUD + delivery history under the normal gate); valid signatures trigger, replays get 401, unsigned 401, stale timestamps 401, unknown events 404.

**Honest boundaries**: delivery/dedup/nonce are in-process rings, cleared on restart, so dedup weakens across restarts (stated in the README); per-sender keys are not done; no public exposure or GitHub App wiring.

## 95. PR review and Issue linkage (seventh round, part 2)

**What**: read-only linkage first: new package `packages/prlink/` (refs parsing for `#123` / `owner/repo#123`, read-only local git linkage, a zero-dependency GitHub REST client + offline fixture provider, a local review archive at `<data>/prlink/reviews.json` with atomic writes); server routes status / local / linked / linked/:number / reviews/local / issues/import / write/comment; new center tab PrLinkPanel (advanced tier). Writes are off by default and need all three: server `FACTORY_PRLINK_WRITES_ENABLED=1` + body `confirm: true` + a configured provider; the fixture provider's publish returns 501.

**How**: the PrLink panel shows linked PRs/Issues, review excerpts, and CI status summaries; branch names and commit messages are parsed for numbers; Issue import creates a DRAFT, never auto-assigns; the local review archive stays local and is never sent upstream; token values never leave the provider closure — never in logs, audits, or responses.

**Honest boundaries**: zero real tokens by default — with no provider, linked returns configured:false + an empty array and never fabricates data; a bare `#123` is neither an issue nor a PR before provider resolution; the GitHub client is unverified against real GitHub, and live semantics (reviews/checks endpoints) await a Tan-side token for recheck; remote diff fetching is out of v1 (the review view uses local `base...head` stat + a 500-word remote review excerpt).

## 96. Debugging deepening: multi-language DAP + conditional breakpoints / logpoints (seventh round, part 2)

**What**: on top of fourth-round S2 DAP: multi-language DAP + conditional breakpoints / logpoints. Adapters are statically registered (node built-in and implemented; python via external debugpy, probed with `python3 -m debugpy --version` falling back to `python -m debugpy --version`, install hint `pip install debugpy`; go via external delve, probed with `dlv version`, install hint `go install github.com/go-delve/delve/cmd/dlv@latest`; probes time out at 10 seconds); conditional breakpoints pause only on a hit, logpoints only log and never pause (logMessage wins over condition; both together mean logpoint, implemented via CDP condition without touching source files); condition syntax is parse-checked only (`new Function` parse, never executed), and syntactically illegal conditions fail startup with 400 `bad-breakpoint`; evaluation errors at hit time are diagnosed and the chain continues.

**How**: the Debug panel adapter area (static list + on-demand probes), breakpoint-draft logpoint input with `log:` display in the list, config dropdown showing `(request, adapter)`; `GET /api/debug/adapters` (static registration, no spawn), `POST /api/debug/adapters/:kind/probe` (unknown kind 400 `unknown-adapter`); a non-node session start returns 501 `adapter-not-implemented` before spawning — never a silent fallback to node.

**Honest boundaries**: only TS/JS is precise; python/go are registration + probe only, not driven; a probe reports only whether the binary exists, not a usable session; a Node session does not auto-terminate (a round-4 gap — smoke tests use explicit DELETE as the session-end semantic); data breakpoints and reverse debugging are explicitly deferred.

## 97. Multi-connection databases + query history + ER diagram (seventh round, part 2)

**What**: deepening fourth-round A5 database browser: `multiconn.ts` (driver directory: sqlite/postgres available, mysql/mariadb/mssql/oracle honestly marked driverless; connection metadata with active switching; write-mode gate — off by default, confirm to enable, prod and read-only drivers can never enable; `stripSecretFields` audit redaction) + `history.ts` (query history at `<dataDir>/db-history.json` with atomic writes, 500-entry cap, SQL truncated to 4000 characters, corrupt files fail closed and are never overwritten, reruns append new entries); server routes `GET /drivers`, `GET /connections/meta`, `GET/POST /active`, `POST /connections/:name/write-mode`, `GET/DELETE /history`, `POST /history/:id/rerun|favorite`, `DELETE /history/:id`; the desktop extends the existing DbBrowserPanel (no new center tab): current-connection switching, write-mode switch (with a preceding `window.confirm`), driver hints, a history sub-tab, and an ER sub-tab with a new SVG relation graph (referenced tables left, FK-holding tables right, columns by reference depth, cycle-guarded).

**How**: the DbBrowser panel switches connections, enables write mode (confirm first), reruns/favorites/deletes/clears history, and reads FK relations from the ER graph; write paths on `/api/db-browser/query` and `PUT /api/db-browser/row` refuse by default (`WRITE_MODE_DISABLED`) until `POST /connections/:name/write-mode {enabled: true, confirm: true}`; destructive statements still take the original ticket path, unaffected by the write-mode gate; prod write refusal is unchanged (`PROD_WRITE_REFUSED`, prod checked first).

**Honest boundaries**: connections are server-session level — restart loses them and they must be re-registered; history survives restarts but old entries may 404 on rerun; Postgres is still a minimal wire-protocol driver (trust auth, no SSL), unverified against a real server; driverless engines refuse registration outright; history stores the SQL text itself (reruns need it) only in the server data dir, audit events carry only entry id and count and never SQL, and password fields are never read, stored, or logged; the ER graph is derived read-only from foreign keys and never modifies a database, and the desktop ER SVG is a deterministic column layout, not an interactive canvas.

## 98. API client deepening (seventh round, part 2)

**What**: deepening fourth-round A6 HTTP/REST client with collections, environments, auth, GraphQL, and WebSocket: `packages/httpclient/` gains `auth.ts` (Bearer/Basic/ApiKey, OAuth2 placeholder), `collections.ts` (collections/environments/auth configs/history, secrets stored separately), `graphql.ts` (queries + variables, errors surfaced as-is), `ws.ts` (RFC 6455 client, frame caps, close handshake, explicit close semantics), and strict substitution in `envs.ts`; server collection CRUD, auth-config CRUD, environment PUT/GET, `/send`, `/graphql`, `/ws/*`, `/history` + rerun; secrets live in `http-api-secrets.json` (0600) with reads always redacted; the desktop HttpPanel gains sub-tabs (files/collections/GraphQL/WebSocket/history) inside the existing panel — no new center tab.

**How**: the Http panel creates collections, configures the three auth kinds, saves environments, sends GraphQL, connects WebSocket (connect/send/echo reply/close), and reruns history; environment-variable substitution failures error explicitly (400 `unresolved-variable`) and never silently send empty values; history stores the pre-substitution URL template and redacted headers, never any secret verbatim.

**Honest boundaries**: OAuth2 is only a placeholder: kind 'oauth2' accepts records but applies fail-closed (`oauth2-placeholder`) and runs no token flow, stated in the panel boundary copy; WebSocket binary frames are refused fail-closed, post-close sends return 409, and outbound checks run against the equivalent http(s) address; the desktop panel path is covered by tsc + unit tests, not a separate Electron e2e (closeout e2e governs).

## 99. Settings sync (seventh round, part 2)

**What**: settings export/import (JSON + version stamp), pre-import preview diffs (added/modified/conflict, plus a removed class), per-item conflict confirmation with no silent overwrite, and post-apply audits recording key names only; an optional private remote (token stored only in the secure channel), with local export/import working fine without one. New center tab SettingsSyncPanel (advanced tier, last).

**How**: the SettingsSync panel downloads exports, pastes imports, shows the preview table, adjudicates conflicts/deletions item by item, applies, and configures/pushes/pulls the remote; `GET /api/settingsync/export`, `POST /api/settingsync/preview`, `POST /api/settingsync/apply` (unadjudicated conflict/removed entries return 409 as a whole and write no files), `GET/PUT /api/settingsync/remote` (returns only URL and a `tokenConfigured` boolean), `POST /api/settingsync/remote/push|pull` (pull previews only, never applies); baseline at `<dataDir>/settingsync-baseline.json`; RBAC follows the default gate (GET viewer, POST/PUT operator).

**Honest boundaries**: sync partitions are only keybindings and rules-global; desktop localStorage preferences (Vim, tiered navigation, golden-path progress) do not sync in v1; rule diffs compare at store level (the whole `rules` array); the remote is the user's own single-document HTTP endpoint — no accounts, no discovery, no retries; an export whose settings file itself carries secret characteristics is refused as a whole (fail-closed); document caps are 1MB, 32 sections, 1000 keys per section, and sections missing from a document are never diffed or written.

---

*Version 0.2.0 (2026-10-18). Supplemented 2026-10-21: hardening waves
(1/2), third wave (parts 1/2), second round (parts 1/2) — §12–§41;
supplemented 2026-10-21: third round (parts 1/2) — §42–§49;
supplemented 2026-10-22: fourth round (parts 1/2) — §50–§59;
supplemented 2026-10-23: fifth round (parts 1/2) — §60–§69.
supplemented 2026-10-27: sixth round (parts 1/2) — §70–§79.
supplemented 2026-11-02: V3.0 audit (parts 1/2) — §80–§89; seventh round (parts 1/2) — §90–§99.
中文版见 ADVANCED_FEATURES.md。*
