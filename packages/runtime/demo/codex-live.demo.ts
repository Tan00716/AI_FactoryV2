/**
 * Demo: CodexAdapter against a REAL `codex app-server` (spec §27/§28).
 *
 * This is a live, manual demo — it is NOT part of npm test, and it needs:
 *   1. the `codex` CLI installed (or CODEX_APP_SERVER_URL pointing at a
 *      server started with `codex app-server --listen ws://127.0.0.1:PORT`)
 *   2. a logged-in account (`codex login`) for the turn to succeed
 *
 * Without a login the turn fails and this script prints the server's real
 * failure reason and exits non-zero. That is the intended, honest behavior:
 * the adapter never falls back to a stub and never fakes a success.
 *
 * Run (after build): node packages/runtime/dist/demo/codex-live.demo.js
 * Env: CODEX_APP_SERVER_URL (ws://…), CODEX_MODEL, CODEX_CWD, CODEX_TIMEOUT_MS
 */
import { CodexAdapter } from '../src/index';

async function main(): Promise<void> {
  const adapter = new CodexAdapter({
    auth: 'chatgpt-oauth',
    appServerUrl: process.env.CODEX_APP_SERVER_URL || undefined,
    model: process.env.CODEX_MODEL || undefined,
    cwd: process.env.CODEX_CWD || undefined,
    timeoutMs: process.env.CODEX_TIMEOUT_MS ? Number(process.env.CODEX_TIMEOUT_MS) : undefined,
  });

  const status = await adapter.getAccountStatus();
  console.log('[codex-live] account status:', JSON.stringify(status, null, 2));
  if (!status.reachable) {
    console.error('[codex-live] app-server unreachable — see "error" above. Exiting.');
    process.exit(1);
  }

  try {
    const out = await adapter.invoke({
      prompt:
        'Reply with exactly one line: codex-live-ok\n' +
        'Then run the shell command `pwd` once so the demo can show an observed action.',
      tools: [],
    });
    console.log('[codex-live] text:', out.text);
    // By design: Codex executed its own actions in its sandbox, so the
    // factory receives observations (actions), never re-executable calls.
    console.log('[codex-live] toolCalls (always [] by design):', out.toolCalls.length);
    console.log('[codex-live] observed actions:', JSON.stringify(out.actions ?? [], null, 2));
  } catch (err) {
    console.error(
      '[codex-live] turn FAILED (expected when not logged in — run `codex login`):',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

void main();
