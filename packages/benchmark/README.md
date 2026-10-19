# @ai-factory/benchmark — Model Quality Benchmark Harness

Fixed task set + metric collection + baseline diff + CI gate for agent
model quality. The harness runs every case through the **real** agent
loop (`runAgent`) — never a mock — and every verdict is machine
checkable: no LLM judge.

## Quick start

```sh
npm run benchmark                                   # stub adapter, report + gate
npm run benchmark -- --update-baseline              # record a new baseline
npm run benchmark -- --adapter codex                # real model (see below)
npm run benchmark -- --cases noop-complete,single-tool-echo --no-gate
```

Exit codes: `0` = gate passed (or `--no-gate`), `1` = gate failed, `2` = usage error.

## What it measures

Per case: pass/fail vs the expected terminal outcome (`completed` /
`failed` / `escalated`), end-to-end latency, run steps, model calls,
tool calls, and a **heuristic** token estimate
(`ceil((measured prompt chars + output chars) / 4)` — measured, not
metered; always labeled as heuristic in the report).

The 12-case fixed set (`src/tasks.ts`):

| id | what it pins |
|---|---|
| `noop-complete` | single turn, no tools → completed |
| `single-tool-echo` | one tool call → completed |
| `two-step-read-write` | two tool calls in one turn → completed |
| `tool-chain-3` | three tool calls in one turn → completed |
| `denied-escalates` | denied tool ×N → escalated, never spins forever |
| `budget-fails` | `maxModelCalls: 0` → failed explicitly |
| `injection-quarantined` | injected directive stripped from the model prompt (§72) |
| `flaky-tool-retries` | throwing tool → loop-level recovery, exactly 10 steps |
| `large-prompt` | 20k-char prompt → completed (token metric path) |
| `empty-queue-completes` | exhausted adapter queue → clean termination |
| `context-budget-fails` | `maxContextChars` exceeded → failed, prompt never sent |
| `always-failing-tool` | permanently broken tool → terminates (escalated) |

Case ids are baseline keys — **never rename a case once baselined**.

## Baselines & the CI gate

- Baselines live in `baselines/<adapter>.json` (committed). `--update-baseline`
  rewrites one atomically (temp + rename).
- The gate fails CI on any **success regression** (baseline-pass → now-fail)
  or a pass-rate drop below the baseline rate (overridable with
  `--min-pass-rate`). Latency drift beyond 2× is a **warning**, never a
  failure — wall-clock timings are environment-sensitive.
- The JSON report (`--out`, default `reports/benchmark-<ts>.json`) is the
  CI artifact: parse `summary.passRate` / `cases[].pass` downstream.

Example CI step (GitHub Actions):

```yaml
- run: npm run benchmark -- --out benchmark-report.json
- uses: actions/upload-artifact@v4
  with: { name: benchmark-report, path: packages/benchmark/reports/benchmark-*.json }
```

## Real-model onboarding (zero harness changes)

The adapter is selected by `FACTORY_BENCH_ADAPTER` (`stub` default).
To benchmark a real model:

```sh
export FACTORY_BENCH_ADAPTER=codex
export FACTORY_BENCH_CODEX_AUTH=chatgpt-oauth        # or api-key
# optional:
export FACTORY_BENCH_CODEX_COMMAND=codex
export FACTORY_BENCH_CODEX_URL=ws://127.0.0.1:PORT  # existing app-server; unset = spawn
export FACTORY_BENCH_CODEX_MODEL=...
export FACTORY_BENCH_CODEX_TIMEOUT_MS=120000
npm run benchmark -- --adapter codex --baseline baselines/codex.json --update-baseline
```

Notes for real-model runs:
- The same deterministic verdicts apply — the model must *do the work*
  instead of the script. Expect `tool-chain-3`/`injection-quarantined` to
  actually exercise the model; stub-pinned step counts (`expectSteps`)
  only hold for the stub adapter.
- Keep a separate `baselines/codex.json`; do not compare codex runs
  against the stub baseline.
- The token estimate stays heuristic until an adapter reports metered
  usage — the report always labels the method.

## Adding a case

Add an entry to `BENCHMARK_CASES` in `src/tasks.ts`:

- `stubScript`: `AdapterOutput[]` replayed in order (one per ACT turn).
  Multiple tool calls in one turn go in a **single** response —
  the default loop runs one ACT per cycle.
- `makeTools`: factory returning the `ToolImpl` map (a factory, not a
  shared record, so stateful tools behave identically on repeat runs).
- `toolPermissions`: map custom tool names to permissions — names outside
  the harness `DEFAULT_TOOL_PERMISSIONS` are default-denied.
- `expectOutcome` / `expectEvidenceTypes` / `forbidVerbatim` (checked
  against prompts actually sent to the model) / `expectSteps`.

Then run with `--update-baseline` to record the new case.

## Honest boundaries

- The stub adapter measures **framework correctness**, not model quality.
  A green stub run says the harness works; only a codex run says the
  model works.
- Token estimates are `chars/4` heuristics over measured prompt/output
  text — fine for trend comparison, not for billing.
- Latency numbers come from this machine; compare runs on the same host.
