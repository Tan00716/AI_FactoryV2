/**
 * Demo: CodexAdapter (spec §27/§28) against the FAKE Codex app-server —
 * the green, no-login member of the demo suite.
 *
 * The adapter spawns packages/runtime/tests/fixtures/fake-codex-server.mjs
 * (a Node script speaking the NDJSON JSON-RPC subset: initialize /
 * thread/start / turn/start) exactly the way it would spawn the real
 * `codex app-server --stdio`, and runs one full turn through it:
 *
 *   prompt → agentMessage items → text
 *          → commandExecution item → observed action (NOT a tool call)
 *          → toolCalls stays [] by design (Codex already executed its own
 *            actions in its sandbox; the factory harness must not re-run
 *            them — see adapters.ts)
 *
 * The real-binary counterpart is codex-live.demo.ts, which needs
 * `codex login` and is deliberately NOT in the demo suite.
 *
 * Run: node packages/runtime/dist/demo/codex-fake.demo.js
 * (or: npm run demo:codex)
 */
import { join } from 'node:path';
import { CodexAdapter } from '../src/index';

// Compiled demo lives in dist/demo/; the fixture ships in the source tree.
const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-codex-server.mjs');

function check(label: string, ok: boolean) {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}`);
  if (!ok) throw new Error(`assertion failed: ${label}`);
}

async function main() {
  console.log('=== Demo: CodexAdapter × fake Codex app-server (scenario "ok") ===');
  const adapter = new CodexAdapter({
    auth: 'chatgpt-oauth',
    command: process.execPath, // node — the fixture is a Node script
    args: [FIXTURE, 'ok'],
    timeoutMs: 10_000,
  });

  const out = await adapter.invoke({
    prompt: 'List the files here and tell me what you found.',
    tools: ['read'],
  });

  console.log(`text: ${JSON.stringify(out.text)}`);
  console.log(`toolCalls: ${out.toolCalls.length} (always 0 by design)`);
  console.log('observed actions:');
  for (const a of out.actions ?? []) {
    console.log(`  [${a.kind}] ${a.summary}`);
  }

  console.log('\nassertions:');
  check('text concatenates both agentMessage items', out.text === 'First line\nSecond line');
  check('toolCalls is empty (no re-execution of Codex actions)', out.toolCalls.length === 0);
  const actions = out.actions ?? [];
  check('exactly one observed action recorded', actions.length === 1);
  check(
    'the action is the commandExecution item (ls -la, exit=0)',
    actions.length === 1 &&
      actions[0].kind === 'commandExecution' &&
      /ls -la/.test(actions[0].summary) &&
      /exit=0/.test(actions[0].summary),
  );

  console.log('\nDemo OK: real adapter flow, fake server, no login needed.');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
