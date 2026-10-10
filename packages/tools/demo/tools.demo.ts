/**
 * Tool registry demo — SPEC v2 §33.
 *
 *  1. Register fs.write and the alternate path python.open (same action).
 *  2. Grant WITHOUT filesystem.write → both denied (same policy).
 *  3. Grant WITH filesystem.write → both allowed.
 *  4. Runner reports exit 1 + note "success" → record keeps FAILED.
 *
 * Run after building the package:
 *   npx tsc -p packages/tools/tsconfig.json
 *   node packages/tools/dist/demo/tools.demo.js
 */
import {
  ToolExecutor,
  ToolRegistry,
  type CapabilityGrant,
  type ToolMetadata,
} from '../src/index';

function meta(id: string): ToolMetadata {
  return {
    id,
    version: '1.0.0',
    source: 'builtin',
    inputSchema: { path: { type: 'string', required: true } },
    outputSchema: {},
    capabilities: ['filesystem.write'],
    sideEffect: 'write',
    networkRequirements: [],
    filesystemRequirements: ['/ws/'],
    timeoutMs: 5_000,
    idempotency: true,
    cancelable: true,
    reconcilable: false,
    health: 'healthy',
    approvalPolicy: 'AUTO',
  };
}

async function main() {
  const registry = new ToolRegistry();
  registry.register(meta('fs.write'));
  registry.register({ ...meta('python.open'), source: 'interpreter' });
  const executor = new ToolExecutor(registry, {
    runner: (c) => ({ exitCode: 0, stdout: `wrote via ${c.tool.id}`, stderr: '' }),
  });

  const principal = { id: 'ai:coder-1', type: 'AI' as const };
  const noWrite: CapabilityGrant = {
    id: 'cap-read',
    principalId: principal.id,
    actions: ['filesystem.read'],
    resourcePrefixes: ['/ws/project-a/'],
    expiresAt: null,
  };
  console.log('--- denied action: both paths refused ---');
  for (const toolId of ['fs.write', 'python.open']) {
    const r = await executor.execute({
      toolId,
      args: { path: '/ws/project-a/a.txt' },
      action: 'filesystem.write',
      resource: '/ws/project-a/a.txt',
      principal,
      capability: noWrite,
    });
    console.log(`[${r.outcome}] ${toolId}: ${r.note}`);
  }

  const withWrite: CapabilityGrant = { ...noWrite, id: 'cap-write', actions: ['filesystem.write'] };
  console.log('--- granted action: both paths allowed ---');
  for (const toolId of ['fs.write', 'python.open']) {
    const r = await executor.execute({
      toolId,
      args: { path: '/ws/project-a/a.txt' },
      action: 'filesystem.write',
      resource: '/ws/project-a/a.txt',
      principal,
      capability: withWrite,
    });
    console.log(`[${r.outcome}] ${toolId}: ${r.stdout}`);
  }

  console.log('--- exit-code truth ---');
  const liar = new ToolExecutor(registry, {
    runner: () => ({ exitCode: 2, stdout: '', stderr: 'disk full', note: 'success' }),
  });
  const r = await liar.execute({
    toolId: 'fs.write',
    args: { path: '/ws/project-a/a.txt' },
    action: 'filesystem.write',
    resource: '/ws/project-a/a.txt',
    principal,
    capability: withWrite,
  });
  console.log(`exit=${r.exitCode} outcome=${r.outcome} note=${JSON.stringify(r.note)}`);
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
