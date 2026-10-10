import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UsageRecorder } from '../src/index';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('UsageRecorder', () => {
  it('records events with the injected clock', () => {
    const c = clock(5000);
    const rec = new UsageRecorder(c);
    const r = rec.record('t1', 'a1', 'tokens', 100);
    assert.equal(r.at, 5000);
    assert.deepEqual(r, { taskId: 't1', agentId: 'a1', kind: 'tokens', amount: 100, at: 5000 });
    c.advance(100);
    assert.equal(rec.record('t1', 'a1', 'toolCalls', 2).at, 5100);
  });

  it('summarizes totals by kind', () => {
    const rec = new UsageRecorder();
    rec.record('t1', 'a1', 'tokens', 100);
    rec.record('t1', 'a1', 'tokens', 200);
    rec.record('t1', 'a1', 'toolCalls', 3);
    const s = rec.summarize();
    assert.equal(s.records, 3);
    assert.equal(s.totals.tokens, 300);
    assert.equal(s.totals.toolCalls, 3);
    assert.equal(s.totals.retries, 0);
  });

  it('aggregates by task and by agent', () => {
    const rec = new UsageRecorder();
    rec.record('t1', 'a1', 'tokens', 100);
    rec.record('t1', 'a2', 'tokens', 50);
    rec.record('t2', 'a1', 'toolCalls', 7);
    const s = rec.summarize();
    assert.equal(s.byTask['t1']!.kinds.tokens, 150);
    assert.equal(s.byTask['t1']!.total, 150);
    assert.equal(s.byTask['t2']!.kinds.toolCalls, 7);
    assert.equal(s.byAgent['a1']!.kinds.tokens, 100);
    assert.equal(s.byAgent['a1']!.kinds.toolCalls, 7);
    assert.equal(s.byAgent['a2']!.kinds.tokens, 50);
  });

  it('filters by taskId and agentId', () => {
    const rec = new UsageRecorder();
    rec.record('t1', 'a1', 'tokens', 100);
    rec.record('t2', 'a1', 'tokens', 50);
    const s = rec.summarize({ taskId: 't1' });
    assert.equal(s.records, 1);
    assert.equal(s.totals.tokens, 100);
    const a = rec.summarize({ agentId: 'nobody' });
    assert.equal(a.records, 0);
    assert.equal(a.totals.tokens, 0);
  });

  it('filters by a time window', () => {
    const c = clock(0);
    const rec = new UsageRecorder(c);
    rec.record('t1', 'a1', 'tokens', 100); // t=0
    c.advance(1000);
    rec.record('t1', 'a1', 'tokens', 200); // t=1000
    c.advance(1000);
    rec.record('t1', 'a1', 'tokens', 300); // t=2000
    const s = rec.summarize({ from: 500, to: 1500 });
    assert.equal(s.records, 1);
    assert.equal(s.totals.tokens, 200);
    assert.deepEqual(s.window, { from: 500, to: 1500 });
  });

  it('rejects negative amounts and lists cloned records', () => {
    const rec = new UsageRecorder();
    assert.throws(() => rec.record('t1', 'a1', 'tokens', -1), /non-negative/);
    rec.record('t1', 'a1', 'tokens', 5);
    const list = rec.list();
    assert.equal(list.length, 1);
    list[0]!.amount = 999;
    assert.equal(rec.summarize().totals.tokens, 5);
  });
});
