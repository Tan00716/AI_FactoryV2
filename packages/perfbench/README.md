# @ai-factory/perfbench — IDE performance benchmark suite + CI gate (V3-#4)

Measures IDE-side costs on deterministic synthetic repos. This is NOT
`packages/benchmark` (model-quality benchmarks: pass rates, latencies
of model calls). The two suites share nothing but the word
"benchmark"; keep them separate.

## Tasks

| task | what it measures | honest label |
|---|---|---|
| `server-boot` | compiled server spawn to first healthy `GET /api/health` | real |
| `index-<scale>` | cold `@ai-factory/codeindex` build, files/sec | synthetic repo |
| `repomap-<scale>` | `@ai-factory/repomap` build from that index | synthetic repo |
| `search-<scale>` | index-free `@ai-factory/codesearch` grep for the probe token | synthetic repo |
| `sqlite-inserts` | 2000 autocommit inserts (p50/p95) + 20000 batched inserts, `node:sqlite` | real driver, synthetic rows |
| `concurrent-tasks` | 8 x 200ms child sleeps through a 4-worker pool, per-job p50/p95 | PROXY (process pool; not taskqueue job execution) |
| `large-file-scan` | read + line-split + token-count of a 10MB synthetic file | PROXY, not Monaco render |
| `unit-sample` | `node --test` over this package's own compiled tests | harness overhead only |
| `vite-build` | `npm run build -w @ai-factory/desktop` wall time | opt-in only; headless proxy for desktop startup cost |

Scales: `small` = 1000 files, `medium` = 10000, `large` = 100000
(plus 50 shared util modules). Seed default 42; same seed always
yields the same tree (see `seed.ts`, tested byte-identical).

## Run

```sh
npm run build -w @ai-factory/perfbench
node scripts/perfbench.mjs [--scale small,medium] [--with-vite]
  [--out <path>] [--gate <baseline.json>] [--gate-mode warn|block]
  [--save-baseline <path>] [--seed 42]
```

The workdir lives under `$HOME` as `perfbench-work-<pid>`
(`PERFBENCH_WORKDIR` override) and is
removed after a successful run — never `/tmp`, never inside the repo.
The server-boot task uses an isolated DB/secrets/data dir and never
touches `apps/server/data/factory.db`. The product-DB WAL finding
reads a COPY of the product DB (read-only); the live file is untouched.

## Gate semantics (warn-first)

- Regression = current.ms > baseline.ms * (1 + threshold/100).
  Default threshold 20%, set in the runner and in `perf-gate.mjs`
  (`--threshold`), not hidden in code.
- Default mode is `warn`: regressions warn but the verdict passes.
  Wall-clock timings on a shared runner are noisy; a first-landing
  gate must not red-flag CI on jitter. Tighten to `block` only after
  the baseline has proven stable across several runs (repeatability
  report in `baselines/`).
- Missing/corrupt baseline passes with `noBaseline: true` — never
  "everything regressed".
- Skipped tasks and tasks present on only one side never fail a gate.
- Standalone gate step (no re-run needed):
  `node scripts/perf-gate.mjs --result <run.json> --baseline <baseline.json> [--mode warn|block]`

## WAL finding (report step: "first check, then decide")

This suite does NOT enable WAL. It reports the product DB's
`journal_mode` (via a read-only copy) in the run notes, and the
bench DB's own mode in the `sqlite-inserts` meta. Enabling WAL on
the product DB changes crash-recovery and backup semantics
(`db-time-travel.ts` already assumes WAL sidecars in places); it is
a separate decision with its own review, not a benchmark side effect.

## What is NOT covered (placeholders, stated plainly)

- **Win/mac runs**: the suite is plain node and can run there, but
  Electron first-paint, signed-packaging checks, and OS-specific
  file-watcher behavior need real Win/mac machines. The `platform`
  field in every report records where a number came from; do not
  compare a Linux number against a Win/mac number without noting it.
- **Monaco render**: `large-file-scan` is a read + tokenize proxy.
  A real Monaco large-file measurement needs a display machine and
  an Electron harness; it is not claimed here.
- **Full test-suite time**: `unit-sample` is harness overhead only.
  The repo's own `npm test` gate remains the authority on suite time.
- **Real repos**: synthetic content has a small vocabulary and
  uniform shape. Numbers are comparable run-to-run (same seed) but
  are a hint about scaling behavior, not a promise for any real repo.
