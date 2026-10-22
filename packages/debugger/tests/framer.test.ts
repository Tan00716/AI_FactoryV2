/**
 * DapFramer tests — Content-Length framing, chunk splits, multi-message
 * batches, and fail-closed behavior on corrupt frames.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DapFramer, encodeMessage } from '../src/index';

function frame(obj: unknown): Buffer {
  return encodeMessage(obj);
}

describe('encodeMessage', () => {
  it('emits a Content-Length header followed by JSON', () => {
    const buf = frame({ type: 'request', seq: 1 });
    const text = buf.toString('utf8');
    assert.match(text, /^Content-Length: \d+\r\n\r\n/);
    const body = JSON.parse(text.split('\r\n\r\n')[1]);
    assert.equal(body.seq, 1);
  });
});

describe('DapFramer', () => {
  it('decodes a single complete message', () => {
    const f = new DapFramer();
    const msgs = f.push(frame({ type: 'event', event: 'initialized' }));
    assert.equal(msgs.length, 1);
    assert.equal((msgs[0] as { event: string }).event, 'initialized');
  });

  it('handles byte-at-a-time delivery', () => {
    const f = new DapFramer();
    const buf = frame({ seq: 7, type: 'request', command: 'threads' });
    let got: unknown[] = [];
    for (let i = 0; i < buf.length; i++) {
      got = got.concat(f.push(buf.slice(i, i + 1)));
    }
    assert.equal(got.length, 1);
    assert.equal((got[0] as { command: string }).command, 'threads');
  });

  it('decodes multiple messages in one chunk', () => {
    const f = new DapFramer();
    const chunk = Buffer.concat([frame({ a: 1 }), frame({ b: 2 }), frame({ c: 3 })]);
    const msgs = f.push(chunk);
    assert.equal(msgs.length, 3);
  });

  it('waits for a partial body', () => {
    const f = new DapFramer();
    const buf = frame({ hello: 'world' });
    const head = buf.slice(0, buf.length - 3);
    assert.deepEqual(f.push(head), []);
    const rest = f.push(buf.slice(buf.length - 3));
    assert.equal(rest.length, 1);
    assert.equal((rest[0] as { hello: string }).hello, 'world');
  });

  it('drops corrupt JSON frames and stays in sync', () => {
    const f = new DapFramer();
    const bad = Buffer.from('Content-Length: 5\r\n\r\n{bad!', 'utf8');
    const good = frame({ ok: true });
    const msgs = f.push(Buffer.concat([bad, good]));
    assert.equal(msgs.length, 1);
    assert.equal((msgs[0] as { ok: boolean }).ok, true);
  });

  it('resets on an absurd Content-Length (fail-closed)', () => {
    const f = new DapFramer();
    const bad = Buffer.from('Content-Length: 99999999999\r\n\r\n', 'utf8');
    assert.deepEqual(f.push(bad), []);
    // stream recovers for the next good frame
    const msgs = f.push(frame({ ok: 1 }));
    assert.equal(msgs.length, 1);
  });

  it('round-trips unicode payloads', () => {
    const f = new DapFramer();
    const msgs = f.push(frame({ text: '断点命中 🎯' }));
    assert.equal((msgs[0] as { text: string }).text, '断点命中 🎯');
  });
});
