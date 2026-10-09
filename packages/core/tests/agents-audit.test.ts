/**
 * Unit tests for the agent registry (spec §15–§17, §44) and audit log (§70).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, AgentValidationError, AuditLog } from '../src/index';

describe('agent registry', () => {
  it('registers an employee with validated autonomy level and permissions', () => {
    const r = new AgentRegistry();
    const a = r.register({
      name: 'coder-01',
      jobTitle: 'Senior Backend Engineer',
      autonomyLevel: 4,
      permissions: ['filesystem.write', 'git.commit'],
    });
    assert.equal(a.autonomyLevel, 4);
    assert.equal(a.status, 'IDLE');
    assert.ok(r.can(a.id, 'filesystem.write'));
    assert.ok(!r.can(a.id, 'deploy.prod'));
  });

  it('rejects autonomy levels outside 0–5 (§17)', () => {
    const r = new AgentRegistry();
    assert.throws(
      () => r.register({ name: 'x', jobTitle: 'Coder', autonomyLevel: 7 as never }),
      AgentValidationError,
    );
  });

  it('rejects unknown permission capabilities (§44)', () => {
    const r = new AgentRegistry();
    assert.throws(
      () =>
        r.register({
          name: 'x',
          jobTitle: 'Coder',
          permissions: ['nuke.everything' as never],
        }),
      AgentValidationError,
    );
  });

  it('applies least-privilege role defaults (§2.5)', () => {
    const r = new AgentRegistry();
    const coder = r.register({ name: 'coder', jobTitle: 'Backend Engineer' });
    assert.ok(!coder.permissions.includes('deploy.prod'));
    assert.ok(!coder.permissions.includes('secret.read'));
    assert.ok(coder.permissions.includes('filesystem.write'));
  });

  it('builds the org tree (§84)', () => {
    const r = new AgentRegistry();
    const pm = r.register({ name: 'pm', jobTitle: 'AI PM', department: 'Management' });
    const lead = r.register({ name: 'lead', jobTitle: 'Tech Lead', parentAgentId: pm.id });
    r.register({ name: 'coder', jobTitle: 'Backend Engineer', parentAgentId: lead.id });
    const tree = r.orgTree();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].agent.id, pm.id);
    assert.equal(tree[0].children[0].agent.id, lead.id);
    assert.equal(tree[0].children[0].children.length, 1);
  });
});

describe('audit log', () => {
  it('is append-only: records can be listed but never changed', () => {
    const log = new AuditLog();
    log.record('human', 'AGENT_CREATED', 'agent', 'a1', { jobTitle: 'Coder' });
    log.record('ai-pm', 'WORKFLOW_TRANSITIONED', 'task', 't1', { from: 'TODO', to: 'PLANNING' });
    const all = log.list();
    assert.equal(all.length, 2);
    assert.equal(all[0].action, 'AGENT_CREATED');
    // Mutating a returned copy must not affect the store.
    all[0].action = 'TAMPERED';
    assert.equal(log.list()[0].action, 'AGENT_CREATED');
    // There is intentionally no update/delete API on AuditLog.
    assert.equal(typeof (log as unknown as { update?: unknown }).update, 'undefined');
    assert.equal(typeof (log as unknown as { delete?: unknown }).delete, 'undefined');
  });
});
