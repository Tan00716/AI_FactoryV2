/**
 * Real end-to-end test: the actual node-adapter (DAP<->CDP bridge) debugging
 * a real `node --inspect` target. This is the honest "it really debugs
 * Node.js" proof — breakpoint hit at the exact line, locals, step, evaluate.
 *
 * Timing: local loopback only; generous timeouts. If the sandbox cannot do
 * loopback TCP this test fails loudly (it does NOT silently pass).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DebugClient, resolveNodeAdapterScript, DapVariable } from '../src/index';

const TARGET = join(__dirname, 'fixtures', 'target.mjs');
// target.mjs line numbers (see fixture): bp at line 4, step lands on line 5.
const BP_LINE = 4;
const STEP_LINE = 5;

function waitForEvent<T>(client: DebugClient, name: string, timeoutMs = 20000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for DAP event '${name}'`)), timeoutMs);
    client.on(name, (body) => {
      clearTimeout(timer);
      resolve(body as T);
    });
  });
}

describe('node-adapter real debugging', () => {
  it('hits a breakpoint, reads locals, steps, evaluates, and exits', async () => {
    const client = new DebugClient(resolveNodeAdapterScript());
    try {
      const outputs: string[] = [];
      client.on('output', (b) => {
        const text = (b as { output?: string }).output ?? '';
        outputs.push(text);
      });
      await client.start();
      const caps = await client.initialize();
      assert.equal(caps.supportsConfigurationDoneRequest, true);

      const stoppedAtBp = waitForEvent<{ reason: string; threadId: number }>(client, 'stopped');
      await client.launch({ program: TARGET, stopOnEntry: false });
      const bps = await client.setBreakpoints({ path: TARGET }, [{ line: BP_LINE }]);
      assert.equal(bps.length, 1);
      assert.equal(bps[0].line, BP_LINE);
      await client.configurationDone();

      const stopped = await stoppedAtBp;
      assert.equal(stopped.reason, 'breakpoint', `stop reason was ${stopped.reason}`);

      const stack = await client.stackTrace(1);
      assert.ok(stack.totalFrames >= 1);
      const top = stack.stackFrames[0];
      assert.equal(top.name, 'compute');
      assert.equal(top.line, BP_LINE, `paused at line ${top.line}, expected ${BP_LINE}`);
      assert.equal(top.source?.path, TARGET);

      // locals of compute(n): n should be 21
      const scopes = await client.scopes(top.id);
      const local = scopes.find((s) => s.name === 'Local' || s.presentationHint === 'locals');
      assert.ok(local, `no local scope; got ${scopes.map((s) => s.name).join(',')}`);
      const vars: DapVariable[] = await client.variables(local.variablesReference);
      const n = vars.find((v) => v.name === 'n');
      assert.ok(n, `no 'n' in locals: ${vars.map((v) => v.name).join(',')}`);
      assert.equal(n.value, '21');

      // evaluate in the paused frame
      const evaled = await client.evaluate('n * 2', { frameId: top.id });
      assert.equal(evaled.result, '42');

      // step over: const doubled = n * 2; -> return doubled + 1;
      const stepped = waitForEvent<{ reason: string }>(client, 'stopped');
      await client.next(1);
      const stepStop = await stepped;
      assert.equal(stepStop.reason, 'step');
      const stack2 = await client.stackTrace(1);
      assert.equal(stack2.stackFrames[0].line, STEP_LINE, `stepped to line ${stack2.stackFrames[0].line}`);

      // the local `doubled` is now assigned
      const scopes2 = await client.scopes(stack2.stackFrames[0].id);
      const local2 = scopes2.find((s) => s.name === 'Local' || s.presentationHint === 'locals');
      assert.ok(local2);
      const vars2: DapVariable[] = await client.variables(local2.variablesReference);
      const doubled = vars2.find((v) => v.name === 'doubled');
      assert.ok(doubled, `no 'doubled' after step: ${vars2.map((v) => v.name).join(',')}`);
      assert.equal(doubled.value, '42');

      // continue to the end; the target prints, then parks waiting for the
      // debugger to disconnect (standard node --inspect behavior), so the
      // client ends the session explicitly.
      await client.continue(1);
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(outputs.join('').includes('out= 43'), `target output missing; got: ${outputs.join('').slice(-200)}`);
      const terminated = waitForEvent(client, 'terminated');
      await client.terminate();
      await terminated;
    } finally {
      await client.stop();
    }
  });

  it('stopOnEntry pauses at the first line', async () => {
    const client = new DebugClient(resolveNodeAdapterScript());
    try {
      await client.start();
      await client.initialize();
      const stopped = waitForEvent<{ reason: string }>(client, 'stopped');
      await client.launch({ program: TARGET, stopOnEntry: true });
      await client.configurationDone();
      const body = await stopped;
      assert.equal(body.reason, 'entry', `expected entry stop, got ${body.reason}`);
      const stack = await client.stackTrace(1);
      assert.ok(stack.stackFrames[0].line <= 3, `entry line ${stack.stackFrames[0].line}`);
      const terminated = waitForEvent(client, 'terminated');
      await client.terminate();
      await terminated;
    } finally {
      await client.stop();
    }
  });

  it('conditional breakpoint only stops when the condition holds', async () => {
    // true condition → stops with reason 'breakpoint'
    {
      const client = new DebugClient(resolveNodeAdapterScript());
      try {
        await client.start();
        await client.initialize();
        const stopped = waitForEvent<{ reason: string }>(client, 'stopped');
        await client.launch({ program: TARGET });
        await client.setBreakpoints({ path: TARGET }, [{ line: BP_LINE, condition: 'n === 21' }]);
        await client.configurationDone();
        const body = await stopped;
        assert.equal(body.reason, 'breakpoint');
        const terminated = waitForEvent(client, 'terminated');
        await client.terminate();
        await terminated;
      } finally {
        await client.stop();
      }
    }
    // false condition → runs to completion, never stops (the target then
    // parks waiting for disconnect; the client ends the session).
    {
      const client = new DebugClient(resolveNodeAdapterScript());
      try {
        await client.start();
        await client.initialize();
        let stoppedCount = 0;
        client.on('stopped', () => {
          stoppedCount++;
        });
        await client.launch({ program: TARGET });
        await client.setBreakpoints({ path: TARGET }, [{ line: BP_LINE, condition: 'n === 999' }]);
        await client.configurationDone();
        await new Promise((r) => setTimeout(r, 3000));
        assert.equal(stoppedCount, 0, 'a false condition must not stop the target');
        const terminated = waitForEvent(client, 'terminated');
        await client.terminate();
        await terminated;
      } finally {
        await client.stop();
      }
    }
  });

  it('launch rejects a missing program fail-closed', async () => {
    const client = new DebugClient(resolveNodeAdapterScript());
    try {
      await client.start();
      await client.initialize();
      await assert.rejects(client.launch({ program: '/nonexistent/nope.mjs' }), /does not exist/);
    } finally {
      await client.stop();
    }
  });
});
