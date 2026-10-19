/**
 * Tests for adapter selection + the measuring decorator.
 * Run: node --test dist/tests/adapters.test.js (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCaseAdapter, resolveAdapterName } from '../src/adapters';

describe('resolveAdapterName', () => {
  it('defaults to stub', () => {
    assert.equal(resolveAdapterName({}), 'stub');
  });
  it('accepts stub and codex (case-insensitive)', () => {
    assert.equal(resolveAdapterName({ FACTORY_BENCH_ADAPTER: 'stub' }), 'stub');
    assert.equal(resolveAdapterName({ FACTORY_BENCH_ADAPTER: 'CODEX' }), 'codex');
  });
  it('throws on unknown adapters', () => {
    assert.throws(() => resolveAdapterName({ FACTORY_BENCH_ADAPTER: 'gpt' }), /unknown benchmark adapter/);
  });
});

describe('createCaseAdapter', () => {
  it('measures prompt and output chars for the stub adapter', async () => {
    const measured = createCaseAdapter('stub', [{ text: 'hello world', toolCalls: [] }]);
    const out = await measured.adapter.invoke({ prompt: '0123456789', tools: [] });
    assert.equal(out.text, 'hello world');
    assert.equal(measured.promptChars(), 10);
    assert.equal(measured.outputChars(), 11);
  });
  it('builds a codex adapter from env without touching the network', () => {
    const measured = createCaseAdapter(
      'codex',
      [],
      { FACTORY_BENCH_CODEX_AUTH: 'api-key', FACTORY_BENCH_CODEX_COMMAND: 'codex' },
    );
    assert.equal(measured.adapter.name, 'codex');
  });
  it('rejects a bad codex auth value', () => {
    assert.throws(
      () => createCaseAdapter('codex', [], { FACTORY_BENCH_CODEX_AUTH: 'magic' }),
      /FACTORY_BENCH_CODEX_AUTH/,
    );
  });
});
