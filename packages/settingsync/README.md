# @ai-factory/settingsync — Settings sync (R7-#10)

Versioned settings export/import with three-way diff and an optional
private-remote push/pull client.

## Document format

```json
{
  "format": "ai-factory-settings-sync",
  "version": 1,
  "exportedAt": "2026-10-30T00:00:00.000Z",
  "sections": {
    "keybindings": { "items": [{ "command": "palette.toggle", "key": "ctrl+k" }] },
    "rules-global": { "version": 1, "rules": [] }
  }
}
```

Every section value is a flat key -> JSON value map; diffs are computed
key by key. The route wraps non-object stores into this shape (the
keybindings array file becomes `{ items: [...] }`).

## Diff semantics (three-way, baseline = last applied state)

| Situation | Kind | Apply behavior |
|---|---|---|
| Key only in incoming, absent from baseline | added | automatic |
| Key in both, incoming changed, local == baseline | modified | automatic |
| Key in both, both changed differently | conflict | needs explicit resolution |
| Key only in incoming, present in baseline | conflict | needs explicit resolution |
| Key dropped by incoming, local == baseline | removed | needs explicit resolution |
| Key dropped by incoming, locally changed | conflict | needs explicit resolution |
| Key only local, or local-only change | (no entry) | kept silently |

Without a baseline (never applied before), differing keys are
"modified", not conflicts: there is no evidence of a concurrent change,
so the first import wins. Timestamps are informational only — conflict
logic never uses wall-clock ordering, so clock skew cannot pick a
winner.

Resolutions are keyed `"section:key"`: `"incoming"` takes the incoming
value (or deletes the key for a removed entry), `"keep"` keeps local.
Any unresolved conflict/removed entry aborts the whole apply before
anything is written.

## What is never synced

Secrets, .env files, API tokens, extension code, project files. Both
export and import refuse any document whose serialized form matches a
shared `@ai-factory/security` secret pattern (fail-closed). The remote
token is resolved at request time from `FACTORY_SETTINGSYNC_TOKEN` (or
the file named by `FACTORY_SETTINGSYNC_TOKEN_FILE`) and is never stored
in a document, a response, or an audit record. Remote URLs must be
http(s) and must not embed credentials.

## Private remote

The remote is the user's own endpoint that stores one JSON document at
one URL (a private file server, object storage, or a tiny HTTP service).
`pushRemote` PUTs the document; `pullRemote` GETs and validates it.
There is no account system, no discovery, and no retry-with-credentials.
Without a configured remote, local export/import works unchanged.
