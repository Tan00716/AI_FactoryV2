import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Channel,
  CommsError,
  MESSAGE_KINDS,
  CommsPayload,
} from '../src/index';

function makeChannel(start = 1_000_000) {
  let t = start;
  return new Channel({ clock: { now: () => t++ } });
}

const base = { taskId: 'task-1', from: 'coder', to: 'reviewer' };

describe('channel: eight message primitives (§22)', () => {
  it('posts an assignment', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: {
        kind: 'assignment',
        title: 'Implement login',
        description: 'Add OAuth login flow',
        requirements: ['tests', 'docs'],
      },
    });
    assert.equal(msg.id, 'msg-1');
    assert.equal(msg.taskId, 'task-1');
    assert.equal(msg.from, 'coder');
    assert.equal(msg.to, 'reviewer');
    assert.equal(msg.timestamp, 1_000_000);
    assert.match(msg.correlationId, /^corr-/);
    assert.equal(msg.payload.kind, 'assignment');
    if (msg.payload.kind === 'assignment') {
      assert.equal(msg.payload.title, 'Implement login');
    }
  });

  it('posts an artifact_ref', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: {
        kind: 'artifact_ref',
        artifactId: 'pr-42',
        artifactType: 'PULL_REQUEST',
        uri: 'https://git.example.com/pr/42',
        summary: 'OAuth login PR',
      },
    });
    assert.equal(msg.payload.kind, 'artifact_ref');
    if (msg.payload.kind === 'artifact_ref') {
      assert.equal(msg.payload.artifactId, 'pr-42');
    }
  });

  it('posts a decision', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: {
        kind: 'decision',
        subject: 'auth library',
        outcome: 'use jose',
        rationale: 'smallest footprint',
      },
    });
    assert.equal(msg.payload.kind, 'decision');
    if (msg.payload.kind === 'decision') {
      assert.equal(msg.payload.outcome, 'use jose');
    }
  });

  it('posts a report', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: { kind: 'report', title: 'QA report', verdict: 'pass', summary: 'all green' },
    });
    assert.equal(msg.payload.kind, 'report');
    if (msg.payload.kind === 'report') {
      assert.equal(msg.payload.verdict, 'pass');
    }
  });

  it('posts an evidence', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: {
        kind: 'evidence',
        uri: 's3://logs/test-run.json',
        description: 'test run log',
      },
    });
    assert.equal(msg.payload.kind, 'evidence');
  });

  it('posts an approval_ref', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: { kind: 'approval_ref', approvalId: 'appr-7', decision: 'approved' },
    });
    assert.equal(msg.payload.kind, 'approval_ref');
    if (msg.payload.kind === 'approval_ref') {
      assert.equal(msg.payload.decision, 'approved');
    }
  });

  it('posts a handoff', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: {
        kind: 'handoff',
        fromRole: 'coder',
        toRole: 'reviewer',
        summary: 'PR ready for review',
      },
    });
    assert.equal(msg.payload.kind, 'handoff');
    if (msg.payload.kind === 'handoff') {
      assert.equal(msg.payload.toRole, 'reviewer');
    }
  });

  it('posts an event', () => {
    const ch = makeChannel();
    const msg = ch.post({
      ...base,
      payload: { kind: 'event', name: 'deploy.started', severity: 'info' },
    });
    assert.equal(msg.payload.kind, 'event');
    if (msg.payload.kind === 'event') {
      assert.equal(msg.payload.name, 'deploy.started');
    }
  });

  it('exposes exactly the eight §22 kinds', () => {
    assert.deepEqual([...MESSAGE_KINDS].sort(), [
      'approval_ref',
      'artifact_ref',
      'assignment',
      'decision',
      'event',
      'evidence',
      'handoff',
      'report',
    ]);
  });
});

describe('channel: payload validation', () => {
  it('rejects an empty payload', () => {
    const ch = makeChannel();
    assert.throws(
      () => ch.post({ ...base, payload: {} as unknown as CommsPayload }),
      (err: unknown) => err instanceof CommsError && err.code === 'EMPTY_PAYLOAD',
    );
  });

  it('rejects a null payload', () => {
    const ch = makeChannel();
    assert.throws(
      () => ch.post({ ...base, payload: null as unknown as CommsPayload }),
      (err: unknown) => err instanceof CommsError && err.code === 'EMPTY_PAYLOAD',
    );
  });

  it('rejects an oversized payload', () => {
    const ch = new Channel({ maxPayloadBytes: 100 });
    assert.throws(
      () =>
        ch.post({
          ...base,
          payload: {
            kind: 'report',
            title: 'x',
            verdict: 'pass',
            summary: 'y'.repeat(200),
          },
        }),
      (err: unknown) => err instanceof CommsError && err.code === 'PAYLOAD_TOO_LARGE',
    );
  });

  it('rejects a missing taskId', () => {
    const ch = makeChannel();
    assert.throws(
      () =>
        ch.post({
          taskId: '  ',
          from: 'a',
          to: 'b',
          payload: { kind: 'event', name: 'x' },
        }),
      (err: unknown) => err instanceof CommsError && err.code === 'MISSING_TASK_ID',
    );
  });

  it('rejects a missing sender/recipient', () => {
    const ch = makeChannel();
    assert.throws(
      () =>
        ch.post({
          taskId: 't',
          from: '',
          to: 'b',
          payload: { kind: 'event', name: 'x' },
        }),
      (err: unknown) => err instanceof CommsError && err.code === 'MISSING_SENDER',
    );
    assert.throws(
      () =>
        ch.post({
          taskId: 't',
          from: 'a',
          to: '',
          payload: { kind: 'event', name: 'x' },
        }),
      (err: unknown) => err instanceof CommsError && err.code === 'MISSING_RECIPIENT',
    );
  });

  it('rejects free-text chat message types (no free-form chat)', () => {
    const ch = makeChannel();
    assert.throws(
      () =>
        ch.post({
          ...base,
          payload: { kind: 'chat_text', text: 'hey' } as unknown as CommsPayload,
        }),
      (err: unknown) => err instanceof CommsError && err.code === 'UNKNOWN_KIND',
    );
    assert.throws(
      () =>
        ch.post({
          ...base,
          payload: { kind: 'message', body: 'hello' } as unknown as CommsPayload,
        }),
      (err: unknown) => err instanceof CommsError && err.code === 'UNKNOWN_KIND',
    );
  });
});

describe('channel: queries, chains, isolation', () => {
  const assignment = {
    kind: 'assignment',
    title: 'Build feature',
    description: 'do it',
  } as const;
  const handoff = {
    kind: 'handoff',
    fromRole: 'coder',
    toRole: 'reviewer',
    summary: 'done, please review',
  } as const;
  const report = {
    kind: 'report',
    title: 'QA report',
    verdict: 'pass',
    summary: 'all green',
  } as const;

  it('lists messages by taskId', () => {
    const ch = makeChannel();
    ch.post({ taskId: 'a', from: 'x', to: 'y', payload: { ...assignment } });
    ch.post({ taskId: 'a', from: 'y', to: 'z', payload: { ...handoff } });
    const list = ch.listByTask('a');
    assert.equal(list.length, 2);
    assert.equal(list[0].payload.kind, 'assignment');
    assert.equal(list[1].payload.kind, 'handoff');
  });

  it('keeps tasks isolated from each other', () => {
    const ch = makeChannel();
    ch.post({ taskId: 'a', from: 'x', to: 'y', payload: { ...assignment } });
    ch.post({ taskId: 'b', from: 'p', to: 'q', payload: { ...report } });
    assert.equal(ch.listByTask('a').length, 1);
    assert.equal(ch.listByTask('b').length, 1);
    assert.equal(ch.listByTask('a')[0].taskId, 'a');
    assert.equal(ch.listByTask('b')[0].taskId, 'b');
  });

  it('traces a handoff chain by correlationId in chronological order', () => {
    const ch = makeChannel();
    const first = ch.post({
      taskId: 'a',
      from: 'orchestrator',
      to: 'coder',
      payload: { ...assignment },
      correlationId: 'chain-1',
    });
    ch.post({
      taskId: 'a',
      from: 'coder',
      to: 'reviewer',
      payload: { ...handoff },
      correlationId: 'chain-1',
    });
    ch.post({
      taskId: 'a',
      from: 'qa',
      to: 'orchestrator',
      payload: { ...report },
      correlationId: 'chain-1',
    });
    // unrelated chain must not leak in
    ch.post({
      taskId: 'a',
      from: 'qa',
      to: 'orchestrator',
      payload: { ...report },
      correlationId: 'chain-2',
    });
    const chain = ch.traceChain('chain-1');
    assert.equal(chain.length, 3);
    assert.deepEqual(
      chain.map((m) => m.payload.kind),
      ['assignment', 'handoff', 'report'],
    );
    assert.equal(chain[0].id, first.id);
    assert.ok(chain[0].timestamp <= chain[1].timestamp);
    assert.ok(chain[1].timestamp <= chain[2].timestamp);
  });

  it('exports a complete trace for auditing', () => {
    const ch = makeChannel();
    ch.post({
      taskId: 'a',
      from: 'orchestrator',
      to: 'coder',
      payload: { ...assignment },
      correlationId: 'c1',
    });
    ch.post({
      taskId: 'a',
      from: 'coder',
      to: 'reviewer',
      payload: { ...handoff },
      correlationId: 'c1',
    });
    ch.post({
      taskId: 'b',
      from: 'qa',
      to: 'orchestrator',
      payload: { ...report },
    });
    const trace = ch.exportTrace('a');
    assert.equal(trace.taskId, 'a');
    assert.equal(trace.messageCount, 2);
    assert.deepEqual(trace.participants, ['coder', 'orchestrator', 'reviewer']);
    assert.equal(trace.kindCounts.assignment, 1);
    assert.equal(trace.kindCounts.handoff, 1);
    assert.equal(trace.kindCounts.report, 0);
    assert.deepEqual(
      trace.messages.map((m) => m.id),
      ['msg-1', 'msg-2'],
    );
  });

  it('getById fetches a message and throws for unknown ids', () => {
    const ch = makeChannel();
    const msg = ch.post({ taskId: 'a', from: 'x', to: 'y', payload: { ...assignment } });
    assert.equal(ch.getById(msg.id).id, msg.id);
    assert.throws(
      () => ch.getById('msg-999'),
      (err: unknown) => err instanceof CommsError && err.code === 'MESSAGE_NOT_FOUND',
    );
  });
});
