/**
 * Fake Codex app-server for CodexAdapter tests — speaks the NDJSON
 * JSON-RPC subset the adapter uses (initialize / thread/start / turn/start)
 * over stdio. No real codex binary, no login, no network.
 *
 * Scenario from argv[2] (or FAKE_CODEX_SCENARIO):
 *   ok        — two agentMessage items + one commandExecution item, then
 *               turn/completed(completed)
 *   fail-turn — turn/completed(failed, "not logged in…")
 *   exit-now  — exit(1) immediately, before reading anything
 *   hang      — answers requests but never sends turn/completed
 */
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? process.env.FAKE_CODEX_SCENARIO ?? 'ok';

if (scenario === 'exit-now') {
  process.exit(1);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const THREAD_ID = 'thread-fake-1';
const TURN_ID = 'turn-fake-1';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) return; // a response — nothing to do

  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        userAgent: 'fake-codex/0.0.0',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    return;
  }
  if (msg.method === 'initialized') return; // notification, no reply

  if (msg.method === 'thread/start') {
    send({
      id: msg.id,
      result: {
        thread: { id: THREAD_ID },
        model: 'fake-model',
        modelProvider: 'fake',
        cwd: '/tmp',
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly' },
      },
    });
    return;
  }

  if (msg.method === 'getAuthStatus') {
    send({
      id: msg.id,
      result: { authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true },
    });
    return;
  }
  if (msg.method === 'account/read') {
    send({
      id: msg.id,
      result: {
        account: { type: 'chatgpt', email: 'fake@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (msg.method === 'account/rateLimits/read') {
    send({
      id: msg.id,
      result: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1890000000 },
          secondary: null,
          planType: 'plus',
        },
      },
    });
    return;
  }

  if (msg.method === 'thread/resume') {
    send({
      id: msg.id,
      result: { thread: { id: msg.params?.threadId ?? THREAD_ID }, model: 'fake-model' },
    });
    return;
  }

  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    setImmediate(() => {
      send({
        method: 'turn/completed',
        params: {
          threadId: msg.params?.threadId ?? THREAD_ID,
          turn: {
            id: msg.params?.turnId ?? TURN_ID,
            status: 'interrupted',
            items: [],
            itemsView: 'full',
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: 1,
          },
        },
      });
    });
    return;
  }

  if (msg.method === 'turn/start') {
    send({
      id: msg.id,
      result: { turn: { id: TURN_ID, status: 'inProgress', items: [], error: null } },
    });
    if (scenario === 'hang') return; // never completes — the adapter must time out

    setImmediate(() => {
      if (scenario === 'fail-turn') {
        send({
          method: 'turn/completed',
          params: {
            threadId: THREAD_ID,
            turn: {
              id: TURN_ID,
              status: 'failed',
              items: [],
              itemsView: 'full',
              error: { message: 'not logged in: run `codex login`', codexErrorInfo: null, additionalDetails: null },
              startedAt: null,
              completedAt: null,
              durationMs: 1,
            },
          },
        });
        return;
      }
      // scenario 'ok'
      const itemCompleted = (item) =>
        send({ method: 'item/completed', params: { item, threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: Date.now() } });
      itemCompleted({ type: 'agentMessage', id: 'm1', text: 'First line', phase: null, memoryCitation: null, delivery: null });
      itemCompleted({ type: 'agentMessage', id: 'm2', text: 'Second line', phase: null, memoryCitation: null, delivery: null });
      itemCompleted({
        type: 'commandExecution',
        id: 'c1',
        pluginId: null,
        scriptPath: null,
        command: 'ls -la',
        cwd: '/tmp',
        processId: null,
        source: 'agent',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'total 0',
        exitCode: 0,
        durationMs: 3,
      });
      send({
        method: 'turn/completed',
        params: {
          threadId: THREAD_ID,
          turn: {
            id: TURN_ID,
            status: 'completed',
            items: [],
            itemsView: 'full',
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: 5,
          },
        },
      });
    });
    return;
  }

  // Unknown request: JSON-RPC method-not-found.
  if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
