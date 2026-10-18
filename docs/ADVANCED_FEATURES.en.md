# AI Factory Advanced Features Guide (0.2.0)

> For users already comfortable with the basic flow: MCP, Plan mode,
> slash commands, hooks, permission tiers, Headless CLI, session resume
> & checkpoints, web search, multimodal input, plugins, PR review.
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

---

*Version 0.2.0 (2026-10-18). 中文版见 ADVANCED_FEATURES.md。*
