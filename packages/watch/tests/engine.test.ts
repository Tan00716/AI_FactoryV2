import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchEngine } from '../src/engine';
import type { WatchFire, WatchRule } from '../src/types';

/** Deterministic timer: tests advance time explicitly. */
class FakeTimers {
  private next = 1;
  private readonly jobs = new Map<number, () => void>();
  setTimeout = (fn: () => void, _ms: number): number => {
    const id = this.next++;
    this.jobs.set(id, fn);
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.jobs.delete(id as number);
  };
  runAll(): void {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const fn of jobs) fn();
  }
  pending(): number {
    return this.jobs.size;
  }
}

const rule: WatchRule = {
  id: 'r1',
  name: 'R1',
  globs: ['src/**/*.ts'],
  action: { type: 'task', label: 'lint' },
  debounceMs: 500,
  enabled: true,
};

test('one save = one fire with merged files', () => {
  const timers = new FakeTimers();
  const fires: WatchFire[] = [];
  const engine = new WatchEngine({ timers, onFire: (f) => fires.push(f) });
  engine.addRule(rule);
  engine.handleChange('src/a.ts', 'change');
  engine.handleChange('src/a.ts', 'change');
  engine.handleChange('src/b.ts', 'change');
  engine.handleChange('README.md', 'change');
  assert.equal(timers.pending(), 1);
  timers.runAll();
  assert.equal(fires.length, 1);
  assert.deepEqual(fires[0].files, ['src/a.ts', 'src/b.ts']);
  assert.equal(fires[0].burst, false);
});

test('events inside the window reset the timer (no early fire)', () => {
  const timers = new FakeTimers();
  const fires: WatchFire[] = [];
  const engine = new WatchEngine({ timers, onFire: (f) => fires.push(f) });
  engine.addRule(rule);
  engine.handleChange('src/a.ts', 'change');
  // Simulate a second save before the first timer fires: the timer is
  // replaced, so running the old job set must not fire.
  engine.handleChange('src/b.ts', 'change');
  assert.equal(timers.pending(), 1);
  timers.runAll();
  assert.equal(fires.length, 1);
  assert.deepEqual(fires[0].files, ['src/a.ts', 'src/b.ts']);
});

test('burst flag when the window exceeds the threshold', () => {
  const timers = new FakeTimers();
  const fires: WatchFire[] = [];
  const engine = new WatchEngine({ timers, onFire: (f) => fires.push(f) });
  engine.addRule(rule);
  for (let i = 0; i < 201; i++) engine.handleChange(`src/f${i}.ts`, 'change');
  timers.runAll();
  assert.equal(fires.length, 1);
  assert.equal(fires[0].burst, true);
  assert.equal(fires[0].files.length, 201);
});

test('disabled rules never fire; dispose clears pending', () => {
  const timers = new FakeTimers();
  const fires: WatchFire[] = [];
  const engine = new WatchEngine({ timers, onFire: (f) => fires.push(f) });
  engine.addRule({ ...rule, enabled: false });
  engine.handleChange('src/a.ts', 'change');
  assert.equal(timers.pending(), 0);
  engine.setRule(rule);
  engine.handleChange('src/a.ts', 'change');
  engine.dispose();
  assert.equal(timers.pending(), 0);
  timers.runAll();
  assert.equal(fires.length, 0);
});

test('removeRule drops pending fire', () => {
  const timers = new FakeTimers();
  const fires: WatchFire[] = [];
  const engine = new WatchEngine({ timers, onFire: (f) => fires.push(f) });
  engine.addRule(rule);
  engine.handleChange('src/a.ts', 'change');
  engine.removeRule('r1');
  timers.runAll();
  assert.equal(fires.length, 0);
});
