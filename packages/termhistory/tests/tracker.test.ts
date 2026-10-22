/**
 * tracker.test.ts — CommandTracker state machine over marker streams.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandTracker } from '../src/index.js';

const ESC = '\x1b';
function marker(kind: string, payload = ''): string {
  return `${ESC}]133;${kind}${payload ? `;${payload}` : ''}${ESC}\\`;
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** A full successful command cycle as the shell emits it. */
function cycle(cmd: string, code: number): string {
  return marker('A') + marker('B') + cmd + marker('C') + marker('E', b64(cmd)) +
    `output of ${cmd}\n` + marker('D', String(code)) + marker('H', b64(cmd));
}

describe('CommandTracker', () => {
  it('records a full cycle with the real exit code', () => {
    const t = new CommandTracker({ now: () => 1000 });
    const seen: string[] = [];
    t.onCommand((c) => seen.push(`${c.command}=${c.exitCode}@${c.at}`));
    t.feedOutput(marker('A') + marker('B'));
    assert.equal(t.getState(), 'input');
    t.feedOutput(cycle('echo hi', 0));
    const cmds = t.getCommands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].command, 'echo hi');
    assert.equal(cmds[0].exitCode, 0);
    assert.equal(cmds[0].at, 1000);
    assert.deepEqual(seen, ['echo hi=0@1000']);
  });

  it('records non-zero exit codes honestly', () => {
    const t = new CommandTracker();
    t.feedOutput(cycle('false', 1) + cycle('exit 42', 42));
    const cmds = t.getCommands();
    assert.deepEqual(cmds.map((c) => [c.command, c.exitCode]), [['false', 1], ['exit 42', 42]]);
  });

  it('discards Ctrl+C-aborted and empty lines (D without C)', () => {
    const t = new CommandTracker();
    // aborted: B, partial input, D;130, A — no C ever
    t.feedOutput(marker('A') + marker('B') + 'ech' + marker('D', '130') + marker('A'));
    // empty line: B, D;0, A — no C
    t.feedOutput(marker('B') + marker('D', '0') + marker('A'));
    assert.deepEqual(t.getCommands(), []);
  });

  it('ignores the startup D;0/H/A before any command', () => {
    const t = new CommandTracker();
    t.feedOutput(marker('D', '0') + marker('H', b64('stale')) + marker('A'));
    assert.deepEqual(t.getCommands(), []);
    assert.equal(t.getState(), 'prompt');
  });

  it('falls back to E payloads when H is empty (history stalled)', () => {
    const t = new CommandTracker();
    t.feedOutput(
      marker('A') + marker('B') +
      marker('C') + marker('E', b64('echo a')) + marker('E', b64('echo b')) +
      marker('D', '0') + marker('H') + marker('A'),
    );
    const cmds = t.getCommands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].command, 'echo a\necho b');
  });

  it('reassembles a marker split across chunks', () => {
    const t = new CommandTracker();
    const full = cycle('ls -la', 2);
    const cut = full.indexOf('133;D');
    t.feedOutput(full.slice(0, cut));
    assert.deepEqual(t.getCommands(), []);
    t.feedOutput(full.slice(cut));
    const cmds = t.getCommands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].command, 'ls -la');
    assert.equal(cmds[0].exitCode, 2);
  });

  it('first C wins; later C/E noise is tolerated', () => {
    const t = new CommandTracker();
    t.feedOutput(
      marker('A') + marker('B') +
      marker('C') + marker('E', b64('echo a')) +
      marker('C') + marker('E', b64('echo b')) + // DEBUG trap per simple command
      marker('D', '0') + marker('H', b64('echo a; echo b')) + marker('A'),
    );
    const cmds = t.getCommands();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].command, 'echo a; echo b'); // H is authoritative
  });

  it('bounds the in-memory command list', () => {
    const t = new CommandTracker({ maxCommands: 3 });
    for (let i = 0; i < 5; i++) t.feedOutput(cycle(`cmd${i}`, 0));
    assert.deepEqual(t.getCommands().map((c) => c.command), ['cmd2', 'cmd3', 'cmd4']);
  });

  it('multi-line commands keep their newlines', () => {
    const t = new CommandTracker();
    const ml = 'for i in 1 2; do\necho $i\ndone';
    t.feedOutput(marker('A') + marker('B') + marker('C') + marker('D', '0') + marker('H', b64(ml)) + marker('A'));
    assert.equal(t.getCommands()[0].command, ml);
  });

  it('listener errors do not break tracking', () => {
    const t = new CommandTracker();
    t.onCommand(() => { throw new Error('boom'); });
    t.feedOutput(cycle('ok', 0));
    assert.equal(t.getCommands().length, 1);
  });
});
