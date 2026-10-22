/**
 * Desktop unit tests for terminalHistory.ts (R4-A8).
 * node:test + node:assert/strict. Run: node --test apps/desktop/tests/unit/terminal-history.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scanShellMarkers, groupEntriesBySession, flattenGroups } = await import(
  '../../src/terminalHistory.ts'
);

const ESC = '\x1b';
const marker = (kind, payload = '') => `${ESC}]133;${kind}${payload ? `;${payload}` : ''}${ESC}\\`;

test('scanShellMarkers mirrors the wire protocol', () => {
  const text = `out${marker('C')}${marker('E', 'ZWNobyBoaQ==')}hi\n${marker('D', '1')}${marker('H', 'ZWNobyBoaQ==')}`;
  const kinds = scanShellMarkers(text).map((m) => m.kind);
  assert.deepEqual(kinds, ['C', 'E', 'D', 'H']);
  const d = scanShellMarkers(text).find((m) => m.kind === 'D');
  assert.equal(d.payload, '1');
});

test('scanShellMarkers ignores split markers without terminator', () => {
  assert.deepEqual(scanShellMarkers(`${ESC}]133;D`), []);
});

test('groupEntriesBySession groups in first-seen order', () => {
  const entries = [
    { id: '1', sessionId: 'sess-aaa', principal: 'human', command: 'ls', exitCode: 0, at: 3 },
    { id: '2', sessionId: 'sess-bbb', principal: 'ai', command: 'pwd', exitCode: 0, at: 2 },
    { id: '3', sessionId: 'sess-aaa', principal: 'human', command: 'git status', exitCode: 1, at: 1 },
  ];
  const groups = groupEntriesBySession(entries);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, 'sess-aaa');
  assert.match(groups[0].label, /sess-aaa/);
  assert.deepEqual(groups[0].entries.map((e) => e.command), ['ls', 'git status']);
  assert.equal(groups[1].entries[0].principal, 'ai');
  const flat = flattenGroups(groups);
  assert.deepEqual(flat.map((e) => e.id), ['1', '3', '2']);
});

test('groupEntriesBySession handles empty input', () => {
  assert.deepEqual(groupEntriesBySession([]), []);
  assert.deepEqual(flattenGroups([]), []);
});
