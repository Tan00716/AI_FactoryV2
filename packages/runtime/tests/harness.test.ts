/**
 * Tests for the Harness — spec §26 (Harness Engineering).
 * Run: node --test dist/tests/harness.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Permission } from '@ai-factory/core';
import {
  AuditEvent,
  EvidenceInput,
  FilesystemBoundary,
  Harness,
  PermissionDenied,
  StepTimeout,
} from '../src/index';

function makeHarness(opts: {
  permissions?: Permission[];
  stepTimeoutMs?: number;
  toolPermissions?: Record<string, Permission>;
} = {}) {
  const audits: AuditEvent[] = [];
  const collected: EvidenceInput[] = [];
  const harness = new Harness({
    allowedRoots: ['/tmp/ai-factory-ws'],
    stepTimeoutMs: opts.stepTimeoutMs ?? 500,
    permissions: opts.permissions ?? ['filesystem.read'],
    toolPermissions: opts.toolPermissions,
    evidence: { collect: (e) => collected.push(e) },
    onAudit: (e) => audits.push(e),
  });
  return { harness, audits, collected };
}

describe('Harness permissions (§26)', () => {
  it('denies a tool whose permission the agent lacks — audited', async () => {
    const { harness, audits } = makeHarness({ permissions: ['filesystem.read'] });
    await assert.rejects(
      harness.runTool('shell', { cmd: 'rm -rf /' }, async () => 'nope'),
      (err: unknown) =>
        err instanceof PermissionDenied && err.code === 'PERMISSION_DENIED',
    );
    assert.ok(
      audits.some((a) => a.action === 'permission.denied' && a.detail.includes('shell')),
      'denial must be audited',
    );
  });

  it('denies unknown tools by default', async () => {
    const { harness } = makeHarness({ permissions: ['shell.execute'] });
    await assert.rejects(
      harness.runTool('launch-missiles', {}, async () => 'nope'),
      (err: unknown) => err instanceof PermissionDenied,
    );
  });

  it('runs an allowed tool, collecting evidence and trace', async () => {
    const { harness, collected } = makeHarness({ permissions: ['filesystem.read'] });
    const result = await harness.runTool('read', { path: 'a.txt' }, async (args) => `content:${(args as { path: string }).path}`);
    assert.equal(result, 'content:a.txt');
    assert.ok(collected.some((e) => e.type === 'tool_result' && e.title === 'tool read ok'));
    const trace = harness.drainTrace();
    assert.ok(trace.some((t) => t.action === 'tool:read' && t.result === 'ok'));
  });

  it('honors toolPermissions overrides', async () => {
    const { harness } = makeHarness({
      permissions: ['shell.execute'],
      toolPermissions: { deploy: 'shell.execute' },
    });
    const out = await harness.runTool('deploy', {}, async () => 'deployed');
    assert.equal(out, 'deployed');
  });
});

describe('filesystem boundary (§26)', () => {
  it('allows paths inside an allowed root', () => {
    const { harness } = makeHarness();
    const resolved = harness.assertWithinRoot('/tmp/ai-factory-ws/src/a.ts');
    assert.equal(resolved, '/tmp/ai-factory-ws/src/a.ts');
  });

  it('denies paths outside the allowed roots', () => {
    const { harness, audits } = makeHarness();
    assert.throws(
      () => harness.assertWithinRoot('/etc/passwd'),
      (err: unknown) => err instanceof FilesystemBoundary && err.code === 'FILESYSTEM_BOUNDARY',
    );
    assert.ok(audits.some((a) => a.action === 'filesystem.denied'));
  });

  it('blocks the sibling-prefix escape (/tmp/ai-factory-ws-evil)', () => {
    const { harness } = makeHarness();
    assert.throws(
      () => harness.assertWithinRoot('/tmp/ai-factory-ws-evil/secret.txt'),
      (err: unknown) => err instanceof FilesystemBoundary,
    );
  });
});

describe('step timeout (§26)', () => {
  it('throws StepTimeout when a step exceeds its budget', async () => {
    const { harness } = makeHarness({ stepTimeoutMs: 20 });
    await assert.rejects(
      harness.withTimeout('slow-step', () => new Promise((resolve) => setTimeout(resolve, 500))),
      (err: unknown) => err instanceof StepTimeout && err.code === 'STEP_TIMEOUT',
    );
  });

  it('lets fast steps through', async () => {
    const { harness } = makeHarness({ stepTimeoutMs: 500 });
    assert.equal(await harness.withTimeout('fast-step', async () => 42), 42);
  });
});
