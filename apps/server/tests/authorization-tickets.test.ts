/**
 * §17.2 (G-09, Batch 18) — the pre-authorization ticket registry over
 * real HTTP: issue/list/get/revoke, and POLICY dispatch consuming a
 * ticket — validated (exists, ACTIVE, unexpired, scope covers the
 * task) before anything mutates, consumed exactly once with the
 * record on the ticket, every refusal a 400 with an audited reason.
 * The Batch 17 bare-Rule-ID path (no ticketId) must behave exactly
 * as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'index.js');

interface Running {
  port: number;
  proc: ChildProcess;
  dir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error('server exited during startup');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy in 20s');
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-tickets-http-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      DB_PATH: path.join(dir, 'factory.db'),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitHealthy(port, proc);
  return { port, proc, dir };
}

async function stopServer(s: Running): Promise<void> {
  s.proc.kill('SIGTERM');
  await new Promise((r) => s.proc.once('exit', r)).catch(() => undefined);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

async function api(
  port: number,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function auditActions(port: number): Promise<string[]> {
  const res = await api(port, 'GET', '/api/audit?limit=300');
  return (res.body as { action: string }[]).map((r) => r.action);
}

async function makeProject(port: number): Promise<string> {
  const project = await api(port, 'POST', '/api/projects', {
    name: 'Ticket Demo',
    description: 'batch 18',
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  return (project.body as { id: string }).id;
}

/** A WAITING task in the given project, ready for a POLICY dispatch. */
async function waitingTask(port: number, projectId: string): Promise<string> {
  const created = await api(port, 'POST', '/api/tasks', {
    title: 'ticket target',
    projectId,
    authorizationStatus: 'DRAFT',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body as { id: string }).id;
  const req = await api(port, 'POST', `/api/tasks/${id}/request-dispatch`, {});
  assert.equal(req.status, 200, JSON.stringify(req.body));
  return id;
}

test('issue → list → get → revoke over HTTP, with audit on both writes', async () => {
  const s = await startServer();
  try {
    const bad = await api(s.port, 'POST', '/api/authorization-tickets', {
      scope: {},
      issuedBy: 'ops',
    });
    assert.equal(bad.status, 400); // policyRuleId is the point of the ticket

    const pid = await makeProject(s.port);
    const issued = await api(s.port, 'POST', '/api/authorization-tickets', {
      policyRuleId: 'RULE-9',
      scope: { projectId: pid, priorities: ['P2'], actions: ['dispatch'] },
      issuedBy: 'ops-lead',
      expiresAt: null,
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const ticket = issued.body as {
      id: string;
      status: string;
      policyRuleId: string;
      consumptions: unknown[];
    };
    assert.equal(ticket.status, 'ACTIVE');
    assert.equal(ticket.policyRuleId, 'RULE-9');
    assert.deepEqual(ticket.consumptions, []);

    const list = await api(s.port, 'GET', '/api/authorization-tickets');
    assert.equal((list.body as unknown[]).length, 1);
    const filtered = await api(
      s.port,
      'GET',
      '/api/authorization-tickets?status=USED',
    );
    assert.equal((filtered.body as unknown[]).length, 0);
    const badStatus = await api(
      s.port,
      'GET',
      '/api/authorization-tickets?status=BOGUS',
    );
    assert.equal(badStatus.status, 400);

    const got = await api(s.port, 'GET', `/api/authorization-tickets/${ticket.id}`);
    assert.equal(got.status, 200);
    const missing = await api(s.port, 'GET', '/api/authorization-tickets/nope');
    assert.equal(missing.status, 404);

    const revoked = await api(
      s.port,
      'POST',
      `/api/authorization-tickets/${ticket.id}/revoke`,
      { actor: 'admin', reason: 'policy retired' },
    );
    assert.equal(revoked.status, 200);
    assert.equal((revoked.body as { status: string }).status, 'REVOKED');
    const again = await api(
      s.port,
      'POST',
      `/api/authorization-tickets/${ticket.id}/revoke`,
      { actor: 'admin' },
    );
    assert.equal(again.status, 409);

    const actions = await auditActions(s.port);
    assert.ok(actions.includes('AUTHORIZATION_TICKET_ISSUED'));
    assert.ok(actions.includes('AUTHORIZATION_TICKET_REVOKED'));
  } finally {
    await stopServer(s);
  }
});

test('POLICY dispatch consumes an ACTIVE ticket exactly once', async () => {
  const s = await startServer();
  try {
    const pid = await makeProject(s.port);
    const taskId = await waitingTask(s.port, pid);
    const issued = await api(s.port, 'POST', '/api/authorization-tickets', {
      policyRuleId: 'RULE-9',
      scope: { projectId: pid, actions: ['dispatch'] },
      issuedBy: 'ops',
      expiresAt: null,
    });
    const ticketId = (issued.body as { id: string }).id;

    // No policyRuleId in the body — the ticket's Rule ID is the record.
    const dispatched = await api(s.port, 'POST', `/api/tasks/${taskId}/dispatch`, {
      via: 'POLICY',
      ticketId,
    });
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
    assert.equal(
      (dispatched.body as { task: { authorizationStatus: string } }).task
        .authorizationStatus,
      'AUTHORIZED',
    );

    const after = await api(s.port, 'GET', `/api/authorization-tickets/${ticketId}`);
    const t = after.body as {
      status: string;
      consumptions: { taskId: string; action: string; consumedBy: string; policyRuleId: string }[];
    };
    assert.equal(t.status, 'USED');
    assert.equal(t.consumptions.length, 1);
    assert.equal(t.consumptions[0]!.taskId, taskId);
    assert.equal(t.consumptions[0]!.action, 'dispatch');
    assert.equal(t.consumptions[0]!.consumedBy, 'policy');
    assert.equal(t.consumptions[0]!.policyRuleId, 'RULE-9');

    // A second task cannot spend the same ticket.
    const task2 = await waitingTask(s.port, pid);
    const reuse = await api(s.port, 'POST', `/api/tasks/${task2}/dispatch`, {
      via: 'POLICY',
      ticketId,
    });
    assert.equal(reuse.status, 400);
    assert.equal((reuse.body as { code: string }).code, 'AUTHORIZATION_TICKET_INVALID');
    const task2After = await api(s.port, 'GET', `/api/tasks/${task2}`);
    assert.equal(
      (task2After.body as { authorizationStatus: string }).authorizationStatus,
      'WAITING_HUMAN_DISPATCH',
    );

    const actions = await auditActions(s.port);
    assert.ok(actions.includes('AUTHORIZATION_TICKET_CONSUMED'));
    assert.ok(actions.includes('AUTHORIZATION_TICKET_REJECTED'));
  } finally {
    await stopServer(s);
  }
});

test('an expired ticket, a scope gap and an unknown ticket each refuse with 400 + audit', async () => {
  const s = await startServer();
  try {
    const pid = await makeProject(s.port);
    const taskId = await waitingTask(s.port, pid);

    const expired = await api(s.port, 'POST', '/api/authorization-tickets', {
      policyRuleId: 'RULE-OLD',
      scope: {},
      issuedBy: 'ops',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    const expiredId = (expired.body as { id: string }).id;
    const r1 = await api(s.port, 'POST', `/api/tasks/${taskId}/dispatch`, {
      via: 'POLICY',
      ticketId: expiredId,
    });
    assert.equal(r1.status, 400);
    assert.equal((r1.body as { reason: string }).reason, 'not_active');

    const scoped = await api(s.port, 'POST', '/api/authorization-tickets', {
      policyRuleId: 'RULE-OTHER-PROJECT',
      scope: { projectId: 'someone-else' },
      issuedBy: 'ops',
      expiresAt: null,
    });
    const r2 = await api(s.port, 'POST', `/api/tasks/${taskId}/dispatch`, {
      via: 'POLICY',
      ticketId: (scoped.body as { id: string }).id,
    });
    assert.equal(r2.status, 400);
    assert.equal((r2.body as { reason: string }).reason, 'scope_gap');

    const r3 = await api(s.port, 'POST', `/api/tasks/${taskId}/dispatch`, {
      via: 'POLICY',
      ticketId: 'no-such-ticket',
    });
    assert.equal(r3.status, 400);
    assert.equal((r3.body as { reason: string }).reason, 'not_found');

    // A Rule ID in the body that disagrees with the ticket is refused.
    const good = await api(s.port, 'POST', '/api/authorization-tickets', {
      policyRuleId: 'RULE-9',
      scope: {},
      issuedBy: 'ops',
      expiresAt: null,
    });
    const r4 = await api(s.port, 'POST', `/api/tasks/${taskId}/dispatch`, {
      via: 'POLICY',
      ticketId: (good.body as { id: string }).id,
      policyRuleId: 'RULE-DIFFERENT',
    });
    assert.equal(r4.status, 400);
    assert.equal((r4.body as { reason: string }).reason, 'rule_id_mismatch');

    // Through all of it the task was never dispatched and the good
    // ticket was never consumed.
    const task = await api(s.port, 'GET', `/api/tasks/${taskId}`);
    assert.equal(
      (task.body as { authorizationStatus: string }).authorizationStatus,
      'WAITING_HUMAN_DISPATCH',
    );
    const goodAfter = await api(
      s.port,
      'GET',
      `/api/authorization-tickets/${(good.body as { id: string }).id}`,
    );
    assert.equal((goodAfter.body as { status: string }).status, 'ACTIVE');

    const actions = await auditActions(s.port);
    assert.equal(
      actions.filter((a) => a === 'AUTHORIZATION_TICKET_REJECTED').length,
      4,
    );
  } finally {
    await stopServer(s);
  }
});

test('without ticketId the Batch 17 Rule ID path is byte-for-byte the old behaviour', async () => {
  const s = await startServer();
  try {
    const pid = await makeProject(s.port);
    const taskId = await waitingTask(s.port, pid);
    const missing = await api(s.port, 'POST', `/api/tasks/${taskId}/dispatch`, {
      via: 'POLICY',
    });
    assert.equal(missing.status, 400);
    const ok = await api(s.port, 'POST', `/api/tasks/${taskId}/dispatch`, {
      via: 'POLICY',
      policyRuleId: 'RULE-9',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const list = await api(s.port, 'GET', '/api/authorization-tickets');
    assert.equal((list.body as unknown[]).length, 0);
  } finally {
    await stopServer(s);
  }
});
