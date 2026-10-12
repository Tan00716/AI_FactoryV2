/**
 * Tests for §33 empty tool results in the Harness.
 *
 * A tool that returns nothing (undefined / null / blank string / [] / {})
 * has not produced a substantive success: the run still completes and the
 * tool is not retried, but the sealed evidence and the committed intent
 * result must say `empty: true` instead of a plain ok. Real falsy results
 * (0, false) are NOT empty.
 *
 * Run: node --test dist/tests/harness-empty-result.test.js (after tsc)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Permission } from '@ai-factory/core';
import {
  EvidenceInput,
  Harness,
  StepIntentStore,
  isEmptyToolResult,
} from '../src/index';

const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

function makeHarness(withIntentStore = false) {
  const collected: EvidenceInput[] = [];
  const intentStore = withIntentStore ? new StepIntentStore() : undefined;
  const harness = new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: 500,
    permissions: ['filesystem.read'] as Permission[],
    evidence: { collect: (e) => collected.push(e) },
    ...(intentStore ? { intentStore, runId: 'run-empty-test' } : {}),
  });
  return { harness, collected, intentStore };
}

describe('isEmptyToolResult (§33)', () => {
  it('flags undefined, null, blank strings, empty arrays and empty objects', () => {
    assert.equal(isEmptyToolResult(undefined), true);
    assert.equal(isEmptyToolResult(null), true);
    assert.equal(isEmptyToolResult(''), true);
    assert.equal(isEmptyToolResult('  \n\t '), true);
    assert.equal(isEmptyToolResult([]), true);
    assert.equal(isEmptyToolResult({}), true);
    assert.equal(isEmptyToolResult(new Map()), true);
    assert.equal(isEmptyToolResult(new Set()), true);
  });

  it('does NOT flag 0, false or NaN — they are real results', () => {
    assert.equal(isEmptyToolResult(0), false);
    assert.equal(isEmptyToolResult(false), false);
    assert.equal(isEmptyToolResult(NaN), false);
  });

  it('does not flag non-empty strings, arrays, objects or collections', () => {
    assert.equal(isEmptyToolResult('ok'), false);
    assert.equal(isEmptyToolResult('  x  '), false);
    assert.equal(isEmptyToolResult([0]), false);
    assert.equal(isEmptyToolResult({ a: 1 }), false);
    assert.equal(isEmptyToolResult(new Map([['k', 'v']])), false);
    assert.equal(isEmptyToolResult(42), false);
    assert.equal(isEmptyToolResult(true), false);
  });
});

describe('Harness.runTool empty results (§33)', () => {
  it('a tool returning undefined completes the run but seals empty evidence', async () => {
    const { harness, collected } = makeHarness();
    const result = await harness.runTool('read', { path: 'gone.txt' }, async () => undefined);
    assert.equal(result, undefined); // run does NOT fail on empty
    const ev = collected.find((e) => e.type === 'tool_result');
    assert.ok(ev, 'tool_result evidence must still be recorded');
    assert.equal(ev.title, 'tool read returned empty');
    assert.equal(ev.payload.ok, true);
    assert.equal(ev.payload.empty, true);
    const trace = harness.drainTrace();
    assert.ok(trace.some((t) => t.action === 'tool:read' && t.result === 'ok (empty)'));
  });

  it("'', [] and {} are sealed as empty too", async () => {
    for (const value of ['', '   ', [], {}] as unknown[]) {
      const { harness, collected } = makeHarness();
      await harness.runTool('read', {}, async () => value);
      const ev = collected.find((e) => e.type === 'tool_result');
      assert.ok(ev);
      assert.equal(ev.payload.empty, true, `value ${JSON.stringify(value)} must be marked empty`);
      assert.equal(ev.title, 'tool read returned empty');
    }
  });

  it('0, false and real payloads are sealed as plain ok — no empty mark', async () => {
    for (const value of [0, false, { rows: 3 }, 'content', [1]] as unknown[]) {
      const { harness, collected } = makeHarness();
      const out = await harness.runTool('read', {}, async () => value);
      assert.deepEqual(out, value);
      const ev = collected.find((e) => e.type === 'tool_result');
      assert.ok(ev);
      assert.equal(ev.title, 'tool read ok');
      assert.equal(ev.payload.ok, true);
      assert.equal('empty' in ev.payload, false, `value ${JSON.stringify(value)} must not be marked empty`);
    }
  });

  it('the intent result commits to the empty outcome (hash over {ok,empty}), status stays EXECUTED', async () => {
    const { harness, intentStore } = makeHarness(true);
    assert.ok(intentStore);
    await harness.runTool('read', {}, async () => undefined);
    const intents = intentStore.listIntents();
    assert.equal(intents.length, 1);
    // Empty is not a failure: the intent executed. But its resultHash is
    // over { ok: true, empty: true }, not the plain { ok: true }.
    assert.equal(intents[0].status, 'EXECUTED');
    assert.equal(intents[0].resultHash, sha256Hex(JSON.stringify({ ok: true, empty: true })));
    assert.notEqual(intents[0].resultHash, sha256Hex(JSON.stringify({ ok: true })));
  });

  it('a non-empty result keeps the plain intent commit', async () => {
    const { harness, intentStore } = makeHarness(true);
    assert.ok(intentStore);
    await harness.runTool('read', {}, async () => 'data');
    const intents = intentStore.listIntents();
    assert.equal(intents[0].status, 'EXECUTED');
    assert.equal(intents[0].resultHash, sha256Hex(JSON.stringify({ ok: true })));
  });

  it('a throwing tool still fails with FAILED intent and no success evidence (no regression)', async () => {
    const { harness, collected, intentStore } = makeHarness(true);
    assert.ok(intentStore);
    await assert.rejects(
      harness.runTool('read', {}, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(collected.some((e) => e.type === 'tool_result'), false);
    const intents = intentStore.listIntents();
    assert.equal(intents[0].status, 'FAILED');
    assert.equal(intents[0].resultHash, sha256Hex(JSON.stringify({ ok: false })));
  });
});
