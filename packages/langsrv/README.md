# @ai-factory/langsrv — precise code intelligence (V3-#6)

Definition, references, hover, outline, and rename-preview for
TypeScript/JavaScript. Zero new dependencies.

## Selection conclusion (written before implementation, per the V3 audit)

| Option | Verdict | Reason |
|---|---|---|
| Self-built LSP client + external TS language server | Client built, server not bundled | `typescript-language-server` is not installed in this repo and npm install is out of scope; a second process plus protocol maintenance for a first wave. The client (`lspClient.ts`) is the plug-in point: set `FACTORY_LANGSRV_LSP_COMMAND` and it takes precedence. |
| tree-sitter | Rejected | Native/wasm external dependency — would need a supply-chain exception under the zero-new-dependency policy. |
| **TypeScript compiler API (chosen)** | **Built-in precise engine** | `typescript` is already in the repo's root `node_modules` (root devDependency, used by every build). Real parser + binder + checker, no subprocess, no new dependency. |

## How it relates to the existing layers (no wheel rebuilt)

- `packages/repomap`: stays the **summary layer** — cheap defs+refs digest
  for agents and prompts. langsrv never replaces it and never scans the
  repo in the background, so it cannot slow repomap indexing.
- `packages/codeindex`: stays the **heuristic layer** — regex symbol
  extraction ("This is not a parser"). It is the fallback tier: when the
  semantic engine and LSP are both unavailable, position queries degrade
  to a name lookup via codeindex and the response is tagged
  `source: 'heuristic'` with an explicit warning. Nothing ever fails
  closed to "no jump".
- `langsrv`: the **precise layer** — position-accurate, cross-file,
  import-aware, via `ts.LanguageService`.

## Degradation contract

- `typescript` is resolved with a dynamic `import()` and is NOT a
  declared dependency of this package. If a packaged build ships without
  devDependencies, the engine throws `TS_UNAVAILABLE` and callers fall
  back — a soft degradation, never a crash at import time.
- File set is bounded (`DEFAULT_MAX_FILES = 3000`); beyond it the engine
  throws `TOO_MANY_FILES` and the route layer falls back the same way.
- Rename-preview is semantic-only: a heuristic cannot safely compute
  edits, so it fails loudly (409) instead of guessing. It never writes;
  the caller applies the returned edits.
- Skipped directories: `node_modules`, `.git`, `dist` (compiled output
  would otherwise duplicate every definition).

## Precedence

LSP (when `FACTORY_LANGSRV_LSP_COMMAND` is set and the server answers)
→ semantic engine → codeindex heuristic (route layer). Every response
carries `source` so the UI can badge it.

## Auditability

Every query is recorded in a 100-entry ring (kind, source, file, ms,
result count — no file contents) exposed by `GET /api/langsrv/status`.
