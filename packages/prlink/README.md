# @ai-factory/prlink — PR review and Issue linkage (R7-#6)

Two planes, kept separate:

- **Local plane** (no network, no token): parse `#123` / `owner/repo#123`
  references from the current branch name and recent commit subjects
  (`refs.ts`, `local.ts`). A bare number is neither an issue nor a PR
  until a provider resolves it — the local plane never guesses.
- **Remote plane** (`provider.ts`): a provider resolves numbers into
  items, review excerpts, and check summaries. `GitHubProvider` talks
  to api.github.com over node:https; `FixtureProvider` reads an
  operator-configured JSON file and is always labeled `fixture`.

## Honest boundaries

- **No provider, no data.** When no token/fixture is configured, the
  route answers `configured: false` with zero items. Nothing is
  fabricated.
- **Remote writes are off by default.** The only remote write is
  `postComment`, and the route gates it behind
  `FACTORY_PRLINK_WRITES_ENABLED=1` plus an explicit `confirm: true`
  body field, plus audit. Local review comments are archived locally
  only and never sent anywhere.
- **Tokens never leak.** The token lives only in the server process
  that constructs the provider. It is never logged, audited, returned,
  or stored in any file this package writes.
- **Fixture data is labeled.** A fixture provider's items are real
  shapes but carry provider name `fixture`; the UI shows the source.
- **Diff review is local.** `getLocalDiff` renders a local
  `base...head` stat; there is no remote diff fetch in v1, and remote
  review bodies are excerpts (500 chars), not full threads.
