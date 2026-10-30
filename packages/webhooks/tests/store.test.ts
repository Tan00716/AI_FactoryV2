/**
 * Webhook store tests (R7-#5): validation, atomic persistence,
 * fail-closed corrupt files, delivery + dedup rings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DedupRing,
  DeliveryRing,
  fallbackEventId,
  loadEndpoints,
  saveEndpoints,
  toEndpoint,
  validateEndpointInput,
} from '../src/index.ts';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'aif-webhook-')), 'webhooks.json');
}

const GOOD = {
  id: 'gh-push',
  name: 'GitHub push',
  eventType: 'push',
  chainLabel: 'lint-and-test',
  root: '/tmp/demo',
  projectId: 'demo',
};

test('validateEndpointInput accepts good input, rejects bad ids and blanks', () => {
  assert.deepEqual(validateEndpointInput(GOOD), []);
  assert.ok(validateEndpointInput({ ...GOOD, id: 'Bad ID!' }).length > 0);
  assert.ok(validateEndpointInput({ ...GOOD, eventType: '' }).length > 0);
  assert.ok(validateEndpointInput({ ...GOOD, chainLabel: '' }).length > 0);
  assert.ok(validateEndpointInput({ ...GOOD, enabled: 'yes' }).length > 0);
  assert.ok(validateEndpointInput(null).length > 0);
});

test('toEndpoint defaults enabled=true and never carries a secret', () => {
  const e = toEndpoint({ ...GOOD, secret: 'should-not-survive' }, 123);
  assert.equal(e.enabled, true);
  assert.equal('secret' in e, false);
  assert.equal(e.createdAt, 123);
});

test('save/load round-trips; missing file loads empty', () => {
  const file = tmpFile();
  assert.deepEqual(loadEndpoints(file), []);
  const ep = toEndpoint(GOOD, 456);
  saveEndpoints([ep], file);
  assert.deepEqual(loadEndpoints(file), [ep]);
});

test('corrupt or wrong-shape files fail closed, never overwritten', () => {
  const file = tmpFile();
  writeFileSync(file, '{not json', 'utf8');
  assert.throws(() => loadEndpoints(file), /corrupt JSON/);
  writeFileSync(file, '{"version":2,"endpoints":[]}', 'utf8');
  assert.throws(() => loadEndpoints(file), /unknown shape/);
  writeFileSync(file, '{"version":1,"endpoints":[{"id":"BAD ID"}]}', 'utf8');
  assert.throws(() => loadEndpoints(file), /invalid endpoint/);
  // The corrupt content is untouched by the failed loads.
  assert.equal(readFileSync(file, 'utf8').includes('BAD ID'), true);
});

test('delivery ring caps at 100, newest first', () => {
  const ring = new DeliveryRing();
  for (let i = 0; i < 105; i++) {
    ring.record({ endpointId: 'e', eventType: 'push', eventId: `ev-${i}`, receivedAt: i, status: 'triggered' });
  }
  const list = ring.list();
  assert.equal(list.length, 100);
  assert.equal(list[0].eventId, 'ev-104');
  assert.equal(list[99].eventId, 'ev-5');
});

test('dedup ring keys on (endpoint, event) and caps', () => {
  const ring = new DedupRing(3);
  assert.equal(ring.has('e1', 'ev-1'), false);
  ring.remember('e1', 'ev-1');
  assert.equal(ring.has('e1', 'ev-1'), true);
  assert.equal(ring.has('e2', 'ev-1'), false);
  ring.remember('e1', 'ev-2');
  ring.remember('e1', 'ev-3');
  ring.remember('e1', 'ev-4');
  assert.equal(ring.has('e1', 'ev-1'), false);
  assert.equal(ring.has('e1', 'ev-4'), true);
});

test('fallback event id is deterministic per body', () => {
  assert.equal(fallbackEventId('a'), fallbackEventId('a'));
  assert.notEqual(fallbackEventId('a'), fallbackEventId('b'));
  assert.ok(fallbackEventId('a').startsWith('sha256:'));
});
