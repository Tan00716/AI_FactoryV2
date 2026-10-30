/**
 * Demo: precise definition lookup on a tiny two-file project.
 * Run from dist: node dist/demo/langsrv.demo.js
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SemanticEngine } from '../src/index.js';

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-langsrv-demo-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
  fs.writeFileSync(path.join(dir, 'b.ts'), "import { greet } from './a';\nexport const x = greet('yo');\n");
  const engine = new SemanticEngine(dir);
  const defs = await engine.definition('b.ts', 1, 20);
  console.log(JSON.stringify({ dir, defs }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
