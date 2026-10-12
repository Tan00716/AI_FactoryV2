/**
 * Tests for the Git Broker (spec §36): the by-action policy gate in
 * front of git operations. Pure policy tests — no git binary needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitBroker,
  GitBrokerDeniedError,
  defaultGitBrokerPolicy,
  GIT_ACTIONS,
  type GitBrokerDecision,
} from '../src/index';

const CTX = { actor: 'agent-1', repo: '/tmp/repo' };

describe('GitBroker allowlist (fail-closed)', () => {
  it('denies an action category that is not in the allowlist, without running it', async () => {
    const decisions: GitBrokerDecision[] = [];
    const broker = new GitBroker(
      { allowedActions: ['branch', 'commit'], taskRequiredActions: [] },
      { audit: (d) => decisions.push(d) },
    );
    let ran = false;
    await assert.rejects(
      broker.execute('push', { ...CTX, branch: 'main' }, async () => {
        ran = true;
      }),
      (err: unknown) => {
        assert.ok(err instanceof GitBrokerDeniedError);
        assert.equal(err.decision.action, 'push');
        assert.match(err.decision.reason ?? '', /not in the git broker allowlist/);
        return true;
      },
    );
    assert.equal(ran, false, 'denied operation must never execute');
    assert.equal(decisions.length, 1, 'the denial itself is audited');
    assert.equal(decisions[0].allowed, false);
    assert.equal(decisions[0].actor, 'agent-1');
  });

  it('authorize() reports the denial as data (no throw)', async () => {
    const broker = new GitBroker({ allowedActions: [], taskRequiredActions: [] });
    const d = await broker.authorize('read', CTX);
    assert.equal(d.allowed, false);
    assert.equal(d.action, 'read');
  });

  it('runs an allowed action and returns its result', async () => {
    const decisions: GitBrokerDecision[] = [];
    const broker = new GitBroker(
      { allowedActions: ['commit'], taskRequiredActions: [] },
      { audit: (d) => decisions.push(d) },
    );
    const out = await broker.execute('commit', CTX, async () => 'sha-123');
    assert.equal(out, 'sha-123');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].allowed, true);
    assert.equal(decisions[0].reason, null);
  });
});

describe('GitBroker task binding', () => {
  it('default policy requires a taskId for push/merge/remote', async () => {
    const broker = new GitBroker(defaultGitBrokerPolicy());
    for (const action of ['push', 'merge', 'remote'] as const) {
      const d = await broker.authorize(action, CTX);
      assert.equal(d.allowed, false, `${action} without taskId must be denied`);
      assert.match(d.reason ?? '', /requires a task binding/);
    }
    for (const action of ['push', 'merge', 'remote'] as const) {
      const d = await broker.authorize(action, { ...CTX, taskId: 'task-1' });
      assert.equal(d.allowed, true, `${action} with taskId must be allowed`);
    }
    // Categories outside the task-required set need no binding.
    const d = await broker.authorize('commit', CTX);
    assert.equal(d.allowed, true);
  });

  it('a host can override which actions require a task binding', async () => {
    const broker = new GitBroker({ allowedActions: ['push'], taskRequiredActions: [] });
    const d = await broker.authorize('push', CTX);
    assert.equal(d.allowed, true);
  });
});

describe('GitBroker context check (injected host rules)', () => {
  it('a veto reason from contextCheck denies the action with that reason', async () => {
    const broker = new GitBroker(
      {
        allowedActions: ['commit'],
        taskRequiredActions: [],
        contextCheck: (_action, ctx) =>
          ctx.projectId === 'p-archived' ? 'project is archived: p-archived' : null,
      },
    );
    const denied = await broker.authorize('commit', { ...CTX, projectId: 'p-archived' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'project is archived: p-archived');
    const allowed = await broker.authorize('commit', { ...CTX, projectId: 'p-live' });
    assert.equal(allowed.allowed, true);
  });

  it('supports an async contextCheck', async () => {
    const broker = new GitBroker({
      allowedActions: ['branch'],
      taskRequiredActions: [],
      contextCheck: async () => 'no credentials for this repository',
    });
    const d = await broker.authorize('branch', CTX);
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'no credentials for this repository');
  });

  it('allowlist denial wins over the context check (fail-closed order)', async () => {
    let checked = false;
    const broker = new GitBroker({
      allowedActions: [],
      taskRequiredActions: [],
      contextCheck: () => {
        checked = true;
        return null;
      },
    });
    const d = await broker.authorize('merge', { ...CTX, taskId: 't' });
    assert.equal(d.allowed, false);
    assert.match(d.reason ?? '', /allowlist/);
    assert.equal(checked, false);
  });
});

describe('GitBroker decision record', () => {
  it('carries actor/repo/task/branch/remote and the injected clock time', async () => {
    const fixed = new Date('2026-10-12T00:00:00.000Z');
    const broker = new GitBroker(defaultGitBrokerPolicy(), { now: () => fixed });
    const d = await broker.authorize('push', {
      actor: 'human',
      repo: '/r',
      taskId: 'task-9',
      branch: 'main',
      remote: 'origin',
    });
    assert.equal(d.at, '2026-10-12T00:00:00.000Z');
    assert.equal(d.taskId, 'task-9');
    assert.equal(d.branch, 'main');
    assert.equal(d.remote, 'origin');
  });

  it('GIT_ACTIONS covers the §36 operation families', () => {
    for (const a of ['read', 'branch', 'commit', 'push', 'merge', 'remote'] as const) {
      assert.ok(GIT_ACTIONS.includes(a), `missing action category ${a}`);
    }
  });
});
