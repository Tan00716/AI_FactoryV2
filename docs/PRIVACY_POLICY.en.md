# AI Factory Privacy Policy and Data Processing Notes

> Version: V3-#10 (2026-10-30). This document describes how AI Factory
> handles your data. Anything it says we do NOT do has a matching
> implementation or an explicit not-implemented note.

## 1. Data residency: local first

- Your projects, tasks, audit chain, approvals and knowledge base live
  locally by default: the SQLite database (`data/factory.db`) and the
  `.ai-factory/` directory. There is no AI Factory cloud, no telemetry,
  no crash reporting and no usage-statistics upload (no telemetry /
  sentry / posthog product-level calls anywhere in the tree).
- The only channels that leave this machine are the external targets
  you explicitly configure: model provider APIs, remote MCP servers,
  webhooks and outbound search providers — all constrained by the
  egress firewall (tightened by default, see the Egress panel) and by
  task-scoped locks.
- A diagnostics bundle (see section 3) is exported by you, to a
  location you choose. Exporting records one audit entry (bundle id
  and section counts, never bundle contents).

## 2. Model egress: a call means data leaves (placeholder notice)

- **Current placeholder status**: apart from Codex, the model adapters
  are still stubs and no real model turn is connected, so this section
  is currently a written notice, not a description of a real call.
- **Rules once connected (decided, not yet in effect)**: before every
  model call, the UI will state that the call will send the prompt and
  relevant code snippets to the named provider, and will offer a
  no-egress alternative (local stub / cancel). Prompts, code snippets
  and task descriptions are egress data; secret and token values are
  blocked by the pre-send secret scan (R4-S1) before sending, and every
  block is audited.
- Retention, training use and deletion on the provider side follow that
  provider's own policy, outside this product's control; the pre-call
  notice will name the provider and link its policy.

## 3. Deletion and export rights

- **Export right**: the diagnostics bundle export (desktop Diagnostics
  panel) produces portable JSON + an HTML report: audit summary, task
  evidence counts, a masked config snapshot, an error excerpt and a
  perf-baseline summary. A preview list (what is included, what is
  never included) is shown first and generation requires your confirm;
  the bundle never contains secrets, tokens, environment variables,
  task titles or file contents.
- **Deletion right**: deleting projects, tasks or audit data follows
  the in-product deletion flow; archived data is deleted when the
  tiered retention policy expires (see the retention documentation).
  Note: the audit chain is a tamper-evident hash chain — a single
  audit record cannot be deleted tracelessly; the deletion itself is
  audited. That is a compliance design choice, not a gap.
- **Corrections and questions**: for anything not covered here, check
  the honest-boundaries list in `docs/KNOWN_LIMITATIONS.md` first;
  unlisted behavior should be treated as not implemented, not assumed.
