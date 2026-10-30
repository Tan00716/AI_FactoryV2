/**
 * perfbench demo: generate a 200-file synthetic repo, cold-index it,
 * and print the timing. Run after build:
 *   node packages/perfbench/dist/demo/perfbench.demo.js
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRepo } from '../src/seed.js';
import { indexRepo } from '../src/tasks.js';

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'perfbench-demo-'));
  try {
    const gen = generateRepo(join(dir, 'repo'), 200, 42);
    const { result } = await indexRepo(join(dir, 'repo'), join(dir, 'cache'), 'demo');
    console.log(`[perfbench demo] generated ${gen.files} files (${gen.bytes} bytes)`);
    console.log(`[perfbench demo] cold index: ${result.ms.toFixed(0)}ms (${(result.value ?? 0).toFixed(1)} files/sec)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
