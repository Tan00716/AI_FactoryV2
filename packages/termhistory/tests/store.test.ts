/**
 * store.test.ts — HistoryStore persistence, dedupe, search, compaction.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from '../src/index.js';

let dir: string;
let tick: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termhistory-test-'));
  tick = 1000;
});
const now = () => tick++;

function mkStore(maxEntries = 5000): HistoryStore {
  return new HistoryStore(join(dir, 'h'), { maxEntries, now });
}

describe('HistoryStore', () => {
  it('appends and reads back most-recent-first', () => {
    const s = mkStore();
    s.append({ sessionId: 's1', principal: 'human', command: 'ls', exitCode: 0 });
    s.append({ sessionId: 's1', principal: 'human', command: 'git status', exitCode: 1 });
    const r = s.recent(10);
    assert.equal(r.length, 2);
    assert.equal(r[0].command, 'git status');
    assert.equal(r[0].exitCode, 1);
    assert.equal(r[1].command, 'ls');
    assert.ok(r[0].id !== r[1].id);
  });

  it('skips empty commands and consecutive duplicates', () => {
    const s = mkStore();
    assert.equal(s.append({ sessionId: 's', principal: 'human', command: '', exitCode: 0 }), null);
    s.append({ sessionId: 's', principal: 'human', command: 'ls', exitCode: 0 });
    assert.equal(s.append({ sessionId: 's', principal: 'human', command: 'ls', exitCode: 0 }), null);
    assert.equal(s.count, 1);
    // non-consecutive duplicate is kept
    s.append({ sessionId: 's', principal: 'human', command: 'pwd', exitCode: 0 });
    assert.notEqual(s.append({ sessionId: 's', principal: 'human', command: 'ls', exitCode: 0 }), null);
    assert.equal(s.count, 3);
  });

  it('persists across instances (real file round-trip)', () => {
    const s = mkStore();
    s.append({ sessionId: 's9', principal: 'ai', command: 'npm test', exitCode: 2 });
    const file = s.path;
    assert.match(readFileSync(file, 'utf8'), /npm test/);
    const s2 = new HistoryStore(join(dir, 'h'));
    assert.equal(s2.count, 1);
    assert.equal(s2.recent(1)[0].command, 'npm test');
    assert.equal(s2.recent(1)[0].principal, 'ai');
    assert.equal(s2.recent(1)[0].exitCode, 2);
  });

  it('skips corrupt lines on load', () => {
    const d = join(dir, 'h2');
    const s = new HistoryStore(d);
    writeFileSync(
      s.path,
      '{"id":"a","sessionId":"s","principal":"human","command":"ok","exitCode":0,"at":1}\n' +
        'NOT JSON AT ALL\n' +
        '{"id":"b","command":""}\n',
    );
    const s2 = new HistoryStore(d);
    assert.equal(s2.count, 1);
    assert.equal(s2.recent(1)[0].command, 'ok');
  });

  it('fuzzy search ranks the best match first', () => {
    const s = mkStore();
    s.append({ sessionId: 's', principal: 'human', command: 'git checkout main', exitCode: 0 });
    s.append({ sessionId: 's', principal: 'human', command: 'ls -la', exitCode: 0 });
    s.append({ sessionId: 's', principal: 'human', command: 'git commit -m x', exitCode: 0 });
    const hits = s.search('gco', 10);
    assert.ok(hits.length >= 2, 'both git commands should match');
    assert.ok(hits.some((e) => e.command === 'git checkout main'));
    // a longer consecutive run ranks the true target first
    const hits2 = s.search('checko', 10);
    assert.equal(hits2[0].command, 'git checkout main');
    assert.deepEqual(s.search('zzz-nope', 10), []);
    // empty query = recent
    assert.equal(s.search('', 2).length, 2);
  });

  it('compacts the file past the cap', () => {
    const s = mkStore(10);
    for (let i = 0; i < 25; i++) {
      s.append({ sessionId: 's', principal: 'human', command: `cmd${i}`, exitCode: 0 });
    }
    // hysteresis: compacts at >1.2x cap, keeps the newest `cap`
    assert.ok(s.count >= 10 && s.count <= 12, `count=${s.count}`);
    assert.equal(s.recent(1)[0].command, 'cmd24');
    assert.equal(s.recent(s.count)[s.count - 1].command, `cmd${25 - s.count}`);
    const lines = readFileSync(s.path, 'utf8').trim().split('\n');
    assert.equal(lines.length, s.count);
  });

  it('refuses absurdly large single entries', () => {
    const s = mkStore();
    const big = 'x'.repeat(100 * 1024);
    assert.equal(s.append({ sessionId: 's', principal: 'human', command: big, exitCode: 0 }), null);
    assert.equal(s.count, 0);
  });
});
