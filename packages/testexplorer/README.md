# @ai-factory/testexplorer (Round 7 #3)

Test explorer: static discovery of `node:test` cases plus single-case /
single-file / single-package runs, with per-case status, duration and
failure output fed back into the tree.

## Design

- **Discovery is static, never executed.** `discoverTests` walks a root
  for `*.test.{js,mjs,cjs,ts,mts,cts}` files and parses
  `describe`/`suite` + `test`/`it` calls (with `.only`/`.skip`/`.todo`
  suffixes, including names on a later line) into a
  package > file > case tree. Packages group by nearest `package.json`.
- **Runs reuse node:test, not a new framework.** The server spawns
  `node dist/src/runner.js`, which uses the programmatic `run()` API so
  each leaf test reports status, duration and failure text. Results
  travel on fd 3 as JSON lines, so test stdout/stderr can never corrupt
  the result stream.
- **Safety.** The route layer gates the spawn through the server's exec
  policy (`checkCommandPolicy`: binary allowlist, deny patterns, no
  inline eval); argv is passed to `spawn` directly, never through a
  shell. The child env strips `NODE_TEST_CONTEXT` /
  `NODE_TEST_WORKER_ID` (nested `node --test` otherwise silently
  downgrades). Test roots go through the codeindex allowlist jail, and
  every file must resolve inside the root.

## Honest limits

- Only `*.test.*` files are discovered; `*.spec.*` files and
  `test.each` table calls are not picked up (v1 scope).
- Describe nesting is brace-counted after stripping string literals and
  `//` comments; braces inside template literals or block comments can
  mis-nest a chain (the leaf case is still found, only its `fullName`
  prefix may be wrong).
- node:test name patterns match a test's own name only, not the
  describe chain. A single-case run therefore uses the leaf name
  (`^leaf$`); duplicate leaf names in one file all run, and the run
  response says how many matched. The route replaces runner fullNames
  with discovery fullNames when the case matches uniquely.
- Runs are synchronous with a timeout (default 120s, max 600s) and a
  512KB stdout/stderr capture cap; per-case failure text is capped at
  8KB. A file that produces no cases reports a `__file` verdict: a
  failed load (missing file, syntax error) surfaces its stderr instead
  of vanishing into "0 results".
- Run records are process-local (last run per root, for rerun-failed);
  a server restart clears them.
