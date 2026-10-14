/**
 * Cross-chunk secret redactor tests (Batch 48 — terminal §50.1).
 *
 * The per-chunk redactSecretValuesCounted misses a secret value split
 * across two output chunks. createCrossChunkRedactor closes that hole.
 * Tests run against the compiled dist (package convention).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCrossChunkRedactor,
  redactSecretValuesCounted,
} from '../src/index';

const SECRET = 'S3CR3T-TOKEN-XYZ-12345';

/** Feed chunks through a redactor; return concatenated emit + flush. */
function runAll(values: readonly string[], chunks: string[]): { text: string; hits: number } {
  const r = createCrossChunkRedactor(values);
  let text = '';
  let hits = 0;
  for (const c of chunks) {
    const out = r.push(c);
    text += out.text;
    hits += out.hits;
  }
  const f = r.flush();
  text += f.text;
  hits += f.hits;
  return { text, hits };
}

describe('createCrossChunkRedactor (Batch 48)', () => {
  it('catches a secret split across two chunks', () => {
    const half = Math.floor(SECRET.length / 2);
    const { text, hits } = runAll([SECRET], [
      `prefix-${SECRET.slice(0, half)}`,
      `${SECRET.slice(half)}-suffix`,
    ]);
    assert.ok(!text.includes(SECRET), `leaked: ${text}`);
    assert.ok(text.includes('***'), `not redacted: ${text}`);
    assert.equal(text, 'prefix-***-suffix');
    assert.equal(hits, 1);
  });

  it('catches a secret fed code-point by code-point (many chunks)', () => {
    const chunks = [`start-`, ...[...SECRET], `-end`];
    const { text, hits } = runAll([SECRET], chunks);
    assert.equal(text, 'start-***-end');
    assert.equal(hits, 1);
  });

  it('catches a secret split across three chunks', () => {
    const { text, hits } = runAll([SECRET], [
      'aa' + SECRET.slice(0, 5),
      SECRET.slice(5, 12),
      SECRET.slice(12) + 'zz',
    ]);
    assert.equal(text, 'aa***zz');
    assert.equal(hits, 1);
  });

  it('redacts a secret wholly inside the held tail at flush', () => {
    // carryLen = SECRET.length - 1, so the whole secret can sit in pending.
    const { text, hits } = runAll([SECRET], [`xx${SECRET}`]);
    assert.equal(text, 'xx***');
    assert.equal(hits, 1);
  });

  it('never duplicates or loses bytes: concat == whole-stream redaction', () => {
    const values = ['alpha-secret-1', 'beta'];
    const full = 'one alpha-secret-1 two beta three alpha-secret-1 four';
    // deterministic pseudo-random-ish splits
    const splits = [3, 7, 2, 11, 5, 1, 13, 4];
    const chunks: string[] = [];
    let pos = 0;
    for (const n of splits) {
      chunks.push(full.slice(pos, pos + n));
      pos += n;
    }
    chunks.push(full.slice(pos));
    const { text, hits } = runAll(values, chunks);
    const expected = redactSecretValuesCounted(full, values);
    assert.equal(text, expected.text);
    assert.equal(hits, expected.hits);
  });

  it('fuzz: random splits always equal whole-stream redaction', () => {
    const values = ['tok-ABC-123', 'zz'];
    const full = 'a tok-ABC-123 b zz c tok-ABC-123zz d';
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 50; trial++) {
      const chunks: string[] = [];
      let pos = 0;
      while (pos < full.length) {
        const n = 1 + Math.floor(rand() * 6);
        chunks.push(full.slice(pos, pos + n));
        pos += n;
      }
      const { text, hits } = runAll(values, chunks);
      const expected = redactSecretValuesCounted(full, values);
      assert.equal(text, expected.text, `trial ${trial} text mismatch`);
      assert.equal(hits, expected.hits, `trial ${trial} hits mismatch`);
    }
  });

  it('handles astral-plane secrets split mid-emoji across the boundary', () => {
    const emojiSecret = '🔑key-🔑-999';
    const cps = [...emojiSecret];
    const cut = 3; // splits inside the first emoji region boundaries
    const { text, hits } = runAll([emojiSecret], [
      'out:' + cps.slice(0, cut).join(''),
      cps.slice(cut).join('') + ':done',
    ]);
    assert.equal(text, 'out:***:done');
    assert.equal(hits, 1);
  });

  it('prefix-overlap values: shorter match deferred, longer wins (no leak)', () => {
    // "AB" is a strict prefix of "ABCDEF"; the boundary falls inside.
    const { text, hits } = runAll(['AB', 'ABCDEF'], ['xxAB', 'CDEFyy']);
    assert.equal(text, 'xx***yy');
    assert.ok(!text.includes('CD'), `leaked: ${text}`);
    assert.equal(hits, 1);
  });

  it('longest-first still applies within a single chunk', () => {
    const { text, hits } = runAll(['AB', 'ABCDEF'], ['xxABCDEFyy']);
    assert.equal(text, 'xx***yy');
    assert.equal(hits, 1);
  });

  it('empty values degrade to a transparent passthrough', () => {
    const { text, hits } = runAll([], ['hello', ' ', 'world']);
    assert.equal(text, 'hello world');
    assert.equal(hits, 0);
  });

  it('length-1 values are redacted without needing carry', () => {
    const { text, hits } = runAll(['x'], ['a', 'xb', 'x']);
    assert.equal(text, 'a***b***');
    assert.equal(hits, 2);
  });

  it('backlog + live chunks share one instance without double-redacting', () => {
    const r = createCrossChunkRedactor([SECRET]);
    const b = r.push(`transcript has ${SECRET} in it`);
    const l = r.push(' and more text');
    const f = r.flush();
    const text = b.text + l.text + f.text;
    assert.ok(!text.includes(SECRET));
    assert.equal(text, 'transcript has *** in it and more text');
  });

  it('a second secret starting where the first ended is still caught', () => {
    const { text, hits } = runAll([SECRET], [`${SECRET}${SECRET}`]);
    assert.equal(text, '******');
    assert.equal(hits, 2);
  });
});
