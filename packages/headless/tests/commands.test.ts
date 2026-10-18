/**
 * Headless CLI command-logic tests (W-D) — mock HttpClient, no server.
 * Run: node --test packages/headless/dist/tests/*.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  execCommand,
  sessionsList,
  sessionsCreate,
  sessionsAttach,
  resumeSession,
  checkpointCreate,
  checkpointList,
  checkpointRestore,
  EXIT_OK,
  EXIT_FAILED,
  EXIT_USAGE,
  type HttpClient,
  type HttpResult,
} from '../src/index.js';

type Handler = (method: string, path: string, body?: unknown) => HttpResult;

function mockClient(handler: Handler): HttpClient {
  return {
    request(method: string, path: string, body?: unknown): Promise<HttpResult> {
      return Promise.resolve(handler(method, path, body));
    },
  };
}

const okTasks: Handler = (method, path) => {
  if (method === 'GET' && path === '/api/projects') return { status: 200, body: [{ id: 'p1' }] };
  if (method === 'POST' && path === '/api/tasks') return { status: 201, body: { id: 't1', title: 'x' } };
  if (method === 'GET' && path === '/api/agents') return { status: 200, body: [{ id: 'a1' }] };
  if (method === 'POST' && path === '/api/runtime/runs') return { status: 202, body: { id: 'r1' } };
  throw new Error(`unexpected ${method} ${path}`);
};

test('exec: empty prompt is a usage error (exit 2)', async () => {
  const r = await execCommand(
    { prompt: '   ', json: false, timeoutMs: 1000, pollMs: 10 },
    mockClient(okTasks),
  );
  assert.equal(r.exitCode, EXIT_USAGE);
});

test('exec: full happy path → exit 0', async () => {
  let polls = 0;
  const http = mockClient((method, path, body) => {
    if (method === 'GET' && path === '/api/runtime/runs/r1') {
      polls++;
      return { status: 200, body: { id: 'r1', status: polls >= 2 ? 'COMPLETED' : 'RUNNING' } };
    }
    return okTasks(method, path, body);
  });
  const r = await execCommand({ prompt: 'do the thing', json: false, timeoutMs: 5000, pollMs: 5 }, http);
  assert.equal(r.exitCode, EXIT_OK);
  assert.match(String((r.output as string[])[0]), /completed/);
});

test('exec: failed run → exit 1', async () => {
  const http = mockClient((method, path, body) => {
    if (method === 'GET' && path === '/api/runtime/runs/r1') {
      return { status: 200, body: { id: 'r1', status: 'FAILED' } };
    }
    return okTasks(method, path, body);
  });
  const r = await execCommand({ prompt: 'do the thing', json: false, timeoutMs: 5000, pollMs: 5 }, http);
  assert.equal(r.exitCode, EXIT_FAILED);
});

test('exec: no projects → exit 1 with guidance', async () => {
  const http = mockClient((method, path) => {
    if (method === 'GET' && path === '/api/projects') return { status: 200, body: [] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await execCommand({ prompt: 'x', json: false, timeoutMs: 1000, pollMs: 5 }, http);
  assert.equal(r.exitCode, EXIT_FAILED);
  assert.match(String((r.output as string[])[0]), /no projects/);
});

test('exec: explicit project/agent skip discovery calls', async () => {
  const seen: string[] = [];
  const http = mockClient((method, path, body) => {
    seen.push(`${method} ${path}`);
    if (method === 'POST' && path === '/api/tasks') return { status: 201, body: { id: 't9', title: 'x' } };
    if (method === 'POST' && path === '/api/runtime/runs') {
      assert.deepEqual(body, { agentId: 'a9', taskId: 't9' });
      return { status: 202, body: { id: 'r9' } };
    }
    if (method === 'GET' && path === '/api/runtime/runs/r9') {
      return { status: 200, body: { id: 'r9', status: 'COMPLETED' } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = await execCommand(
    { prompt: 'x', projectId: 'p9', agentId: 'a9', json: true, timeoutMs: 1000, pollMs: 5 },
    http,
  );
  assert.equal(r.exitCode, EXIT_OK);
  assert.ok(!seen.some((s) => s.includes('/api/projects') || s.includes('/api/agents')));
  assert.equal((r.output as Record<string, unknown>)['taskId'], 't9');
});

test('exec: timeout while polling → exit 2', async () => {
  const http = mockClient((method, path, body) => {
    if (method === 'GET' && path.startsWith('/api/runtime/runs/')) {
      return { status: 200, body: { status: 'RUNNING' } };
    }
    return okTasks(method, path, body);
  });
  const r = await execCommand({ prompt: 'x', json: false, timeoutMs: 30, pollMs: 5 }, http);
  assert.equal(r.exitCode, EXIT_USAGE);
  assert.match(String((r.output as string[])[0]), /timed out/);
});

test('sessions list/create', async () => {
  const http = mockClient((method, path) => {
    if (method === 'GET' && path === '/api/sessions') {
      return { status: 200, body: { sessions: [{ id: 's1', title: 't', status: 'active', runIds: [], taskIds: [], checkpointIds: [] }] } };
    }
    if (method === 'POST' && path === '/api/sessions') {
      return { status: 201, body: { session: { id: 's2', title: 'n' } } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const l = await sessionsList(http, false);
  assert.equal(l.exitCode, EXIT_OK);
  assert.match(String((l.output as string[])[0]), /s1/);
  const c = await sessionsCreate(http, 'n', undefined, false);
  assert.equal(c.exitCode, EXIT_OK);
  const c2 = await sessionsCreate(http, '   ', undefined, false);
  assert.equal(c2.exitCode, EXIT_USAGE);
});

test('sessions attach', async () => {
  const http = mockClient((method, path) => {
    assert.equal(path, '/api/sessions/s1/attach');
    return { status: 200, body: { session: { id: 's1', runIds: ['r1'] } } };
  });
  const r = await sessionsAttach(http, 's1', 'r1', undefined, false);
  assert.equal(r.exitCode, EXIT_OK);
  const bad = await sessionsAttach(http, 's1', undefined, undefined, false);
  assert.equal(bad.exitCode, EXIT_USAGE);
});

test('resume: prints bundle lines', async () => {
  const http = mockClient((method, path) => {
    assert.equal(path, '/api/sessions/s1/resume');
    return {
      status: 200,
      body: {
        session: { id: 's1', title: 't', status: 'active' },
        tasks: [{ id: 't1', title: 'task one', status: 'done' }],
        runResumePoints: [{ runId: 'r1', stepPosition: 3, hasCheckpoint: true, resumeEndpoint: '/api/runtime/runs/r1/resume' }],
        checkpointIds: ['c1'],
      },
    };
  });
  const r = await resumeSession(http, 's1', false);
  assert.equal(r.exitCode, EXIT_OK);
  const lines = r.output as string[];
  assert.ok(lines.some((l) => l.includes('task one')));
  assert.ok(lines.some((l) => l.includes('/api/runtime/runs/r1/resume')));
});

test('checkpoint create/list/restore', async () => {
  const http = mockClient((method, path) => {
    if (method === 'POST' && path === '/api/sessions/s1/checkpoints') {
      return { status: 201, body: { checkpoint: { id: 'c1', label: 'l', gitDiff: 'diff...', gitDiffTruncated: false } } };
    }
    if (method === 'GET' && path === '/api/sessions/s1/checkpoints') {
      return { status: 200, body: { checkpoints: [{ id: 'c1', createdAt: 't', label: 'l' }] } };
    }
    if (method === 'POST' && path === '/api/sessions/s1/checkpoints/c1/restore') {
      return { status: 200, body: { codeApplied: true, codeApplyReason: '', preRestoreCheckpointId: 'c0' } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const c = await checkpointCreate(http, 's1', 'l', undefined, false);
  assert.equal(c.exitCode, EXIT_OK);
  const l = await checkpointList(http, 's1', false);
  assert.equal(l.exitCode, EXIT_OK);
  const r = await checkpointRestore(http, 's1', 'c1', false);
  assert.equal(r.exitCode, EXIT_OK);
  assert.ok((r.output as string[]).some((x) => x.includes('c0')));
  const missing = await checkpointRestore(http, 's1', undefined, false);
  assert.equal(missing.exitCode, EXIT_USAGE);
});

test('HTTP error surfaces as exit 1 with server message', async () => {
  const http = mockClient(() => ({ status: 404, body: { error: 'session not found' } }));
  const r = await resumeSession(http, 'nope', false);
  assert.equal(r.exitCode, EXIT_FAILED);
  assert.match(String((r.output as string[])[0]), /session not found/);
});
