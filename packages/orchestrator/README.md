# @ai-factory/orchestrator

Orchestration control plane for the AI Engineering Factory IDE prototype
(spec §92–§95, §21): task auto-decomposition, scheduling, agent selection,
next-action decisions, handoffs, and orchestration patterns.

## Modules

| module | spec | what it does |
|---|---|---|
| `auto-decomposition.ts` | §95 | rule-based task → plan templates per kind |
| `scheduler.ts` | §93 | priority / dependency / concurrency scheduling + workload tracking |
| `selection.ts` | §94 | weighted agent scoring and candidate ranking |
| `orchestrator.ts` | §92 | pure state → next-action decisions, handoff records |
| `patterns.ts` | §21 | manager vs handoff pattern chooser |

## AI vs code boundary (§92)

The spec is explicit: **the orchestrator should be deterministic where
possible. Use AI for decisions that require reasoning. Use code for state
transitions, permissions, gate checks, resource limits, retries, scheduling,
and audit. Never let an LLM own these critical invariants.**

This package draws the line as follows:

| Owned by code (deterministic) | Owned by AI (reasoning) |
|---|---|
| `decideNextAction` — pure state → action mapping | whether *evidence is sufficient* to advance a state |
| `Scheduler.nextBatch` — dependency/priority/concurrency policy | what priority a task deserves upstream |
| `scoreAgent`/`rankCandidates` — weighted scoring with documented weights | judging agent fit beyond the measurable factors |
| `decompose` — structural plan skeleton per kind (a **heuristic**) | validating the plan against the real codebase |
| `choosePattern` — structural heuristic (fan-out → manager, pipeline → handoff) | recognizing when the heuristic misfires |
| handoff records + audit trail (immutable, clock-injected) | summarizing context for the next owner |

The heuristic modules (`auto-decomposition`, `patterns`) are deterministic
but not intelligent: they scaffold structure so every task gets a complete,
auditable plan. AI refines judgement; code guarantees invariants.

## Determinism notes

- All modules are pure functions / small classes with no network or LLM
  calls.
- Clocks are injectable (`{ now: () => number }`) for `Scheduler` and
  `Orchestrator`/`createHandoff`, so timestamps are deterministic in tests.
- Zero external dependencies (only `@ai-factory/core` types).

## Build / test / demo

```sh
npx tsc -p tsconfig.json
node --test dist/tests/*.test.js
node dist/demo/decompose.demo.js
```
