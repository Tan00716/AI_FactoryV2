# @ai-factory/runtime

Agent runtime — spec **§24 (Agent Loop)**, **§25 (Loop Engineering)**,
**§26 (Harness Engineering)**, **§27 (Agent Runtime)**.

Depends on `@ai-factory/core` (Agent/Task/Permission types — never modified)
and `@ai-factory/model-router` (routing decisions).

## Modules

- `types` — loop phases/decisions, budgets, `FactoryError` codes
  (`BUDGET_EXCEEDED`, `LOOP_STAGNATION`, `PERMISSION_DENIED`,
  `FILESYSTEM_BOUNDARY`, `STEP_TIMEOUT`, `ADAPTER_NOT_IMPLEMENTED`),
  trace steps, and the `EvidenceSink` interface.
- `loop` — `AgentLoop`: the explicit state machine
  `OBSERVE → UNDERSTAND → PLAN → ACT → VERIFY → EVALUATE → CONTINUE | RETRY |
  HANDOFF | ESCALATE | COMPLETE`. A caller-supplied `StepFn` drives each phase
  (scriptable without an LLM). Enforces step/time/retry budgets; same error
  signature 3× (configurable) → `LoopStagnation` → caller auto-escalates;
  `checkpoint()` → opaque base64url token, `resume(token)` continues with
  budgets and failure history intact. Injectable `Clock` for deterministic tests.
- `harness` — `Harness`: tool routing through the core `Permission` check
  (denials throw `PermissionDenied` and are audited via callback), filesystem
  boundary (`allowedRoots`, sibling-prefix safe), per-step timeouts, evidence
  collection forwarded to the caller's `EvidenceSink` (the runtime never
  mutates core's evidence store), and tracing.
- `adapters` — `RuntimeAdapter` interface (`Agent → Model Router → Runtime
  Adapter`, §27); `StubAdapter` replays scripted responses (tests/demos);
  `CodexAdapter` is a placeholder holding config that throws a clear
  `AdapterNotImplemented` until wired to a Codex app-server (§28).
- `runner` — `runAgent({agent, task, loop, harness, adapter})`:
  routes the model (optional `routeRequest`), runs the loop with either a
  scripted `StepFn` or the default adapter-driven one (ACT invokes the adapter
  and routes each tool call through the harness), and returns
  `{outcome: 'completed'|'escalated'|'failed', steps, evidence, handoffs, trace}`.

## Build / test / demo

```bash
npx tsc -p tsconfig.json
node --test dist/tests/*.test.js
node dist/demo/demo.js
```
