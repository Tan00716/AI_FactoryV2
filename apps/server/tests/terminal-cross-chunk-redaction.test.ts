/**
 * Terminal cross-chunk redaction wiring test (Batch 48).
 *
 * The cross-chunk algorithm itself is unit-tested in @ai-factory/secrets
 * (cross-chunk-redaction.test.ts, incl. a 50-trial fuzz). This file tests
 * the server wiring seam: createTerminalStreamRedactor (one instance per
 * SSE stream, backlog + live chunks through it, hits -> onHit).
 *
 * Dual-mode note: imports the COMPILED ../dist/routes/terminal.js (root
 * build must run first) — routes/terminal.ts value-imports a sibling
 * extensionless ('../redaction-monitor'), which node type-stripping
 * cannot resolve. Precedent: build-records.test.ts imports
 * ../dist/routes/git.js.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalStreamRedactor } from '../dist/routes/terminal.js';

const SECRET = 'wire-seam-secret-abcdef-123456';

function drive(secretValues: readonly string[], chunks: string[]) {
  const hits: number[] = [];
  const r = createTerminalStreamRedactor(secretValues, (h) => hits.push(h));
  let text = '';
  for (const c of chunks) text += r.push(c);
  text += r.flush();
  return { text, hits };
}

describe('createTerminalStreamRedactor (terminal wiring seam)', () => {
  it('redacts a secret split across the backlog/live boundary', () => {
    const half = 10;
    // backlog ends mid-secret; live chunks complete it.
    const { text, hits } = drive([SECRET], [
      `shell$ echo ${SECRET.slice(0, half)}`,
      `${SECRET.slice(half)}\r\nshell$ `,
    ]);
    assert.ok(!text.includes(SECRET), `leaked: ${text}`);
    assert.ok(!text.includes(SECRET.slice(0, half) + SECRET.slice(half, half + 4)));
    assert.ok(text.includes('***'));
    assert.deepEqual(hits, [1]);
  });

  it('emits normal output with no duplication or loss', () => {
    const { text, hits } = drive([SECRET], ['hello ', 'world\r\n', 'shell$ ']);
    assert.equal(text, 'hello world\r\nshell$ ');
    assert.deepEqual(hits, []);
  });

  it('flush emits the held tail when the stream closes', () => {
    const hits: number[] = [];
    const r = createTerminalStreamRedactor([SECRET], (h) => hits.push(h));
    const a = r.push('short');
    const tail = r.flush();
    assert.equal(a + tail, 'short');
    assert.deepEqual(hits, []);
  });

  it('empty secret values degrade to identity with no hits', () => {
    const { text, hits } = drive([], ['any', 'thing']);
    assert.equal(text, 'anything');
    assert.deepEqual(hits, []);
  });

  it('a secret entirely in one chunk still reports exactly one hit', () => {
    const { text, hits } = drive([SECRET], [`v=${SECRET}\r\n`]);
    assert.equal(text, 'v=***\r\n');
    assert.deepEqual(hits, [1]);
  });
});
