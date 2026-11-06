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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

// ---------- V3R15 #6(f): credential env scrub ----------

describe('node-adapter credential env scrub (R15 #6(f))', () => {
  it('target process never sees FACTORY_API_TOKEN / FACTORY_SECRET_*', async () => {
    const keys = ['FACTORY_API_TOKEN', 'FACTORY_SECRET_PROBE'] as const;
    const values: Record<string, string> = {
      FACTORY_API_TOKEN: 'test-value-for-factory_api_token-1234567890',
      FACTORY_SECRET_PROBE: 'test-value-for-factory_secret_probe-1234567890',
    };
    const saved = new Map<string, string | undefined>();
    for (const k of keys) {
      saved.set(k, process.env[k]);
      process.env[k] = values[k];
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-debugger-6f-'));
    // The debug target is always a Node script file (there is no "run a
    // command" entry point), so the probe script prints the credentials
    // itself and then parks (node --inspect keeps the process alive until
    // the debugger disconnects) — output buffering only keeps the last
    // 200 lines, so nothing may be printed after the secret lines.
    const script = path.join(dir, 'pwn.mjs');
    fs.writeFileSync(
      script,
      [
        `console.log('FACTORY_API_TOKEN=' + process.env.FACTORY_API_TOKEN);`,
        `console.log('FACTORY_SECRET_PROBE=' + process.env.FACTORY_SECRET_PROBE);`,
        `console.log('PATH=' + process.env.PATH);`,
        '',
      ].join('\n'),
      'utf8',
    );
    const client = new DebugClient(resolveNodeAdapterScript());
    try {
      const outputs: string[] = [];
      client.on('output', (b) => {
        outputs.push((b as { output?: string }).output ?? '');
      });
      await client.start();
      await client.initialize();
      await client.launch({ program: script, stopOnEntry: false });
      await client.configurationDone();
      // The target prints and then parks (a node --inspect process stays
      // alive until the debugger disconnects), so there is no natural
      // 'terminated' to wait for — wait for the output itself instead.
      const deadline = Date.now() + 20000;
      for (;;) {
        const text = outputs.join('');
        if (
          text.includes('FACTORY_API_TOKEN=') &&
          text.includes('FACTORY_SECRET_PROBE=') &&
          text.includes('PATH=')
        ) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for target output; got: ${text.slice(-500)}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const text = outputs.join('');
      const lines = text.split('\n');
      // Line-prefix assertions (R13 #6(d) precedent): the key NAME may
      // legitimately appear as text in unrelated ambient vars.
      for (const k of keys) {
        assert.ok(!lines.some((line) => line.startsWith(`${k}=${values[k]}`)), `target env leaked ${k}`);
        assert.ok(!text.includes(values[k]), `target output leaked the value for ${k}`);
      }
      assert.ok(lines.some((line) => line === 'FACTORY_API_TOKEN=undefined'), `expected scrubbed token line; got: ${text.slice(-500)}`);
      assert.ok(lines.some((line) => line.startsWith('PATH=/')), 'PATH must still pass through to the target');
      const terminated = waitForEvent(client, 'terminated');
      await client.terminate();
      await terminated;
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await client.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
