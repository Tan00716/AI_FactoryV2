import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LangSrvService } from '../src/index.js';

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-langsrv-svc-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
  fs.writeFileSync(path.join(dir, 'b.ts'), "import { greet } from './a';\nexport const x = greet('yo');\n");
  return dir;
}

test('service without LSP answers from the semantic engine and logs queries', async () => {
  const dir = fixture();
  const svc = new LangSrvService();
  const res = await svc.definition(dir, 'b.ts', 1, 20);
  assert.equal(res.source, 'semantic');
  assert.equal(res.locations.length, 1);
  assert.equal(res.locations[0].file, 'a.ts');
  const status = svc.status();
  assert.equal(status.semantic, 'available');
  assert.equal(status.lspConfigured, false);
  assert.equal(status.queries, 1);
  assert.equal(status.recent[0].kind, 'definition');
  assert.equal(status.recent[0].source, 'semantic');
});

test('service status before any query reports semantic unknown, not unavailable', () => {
  const svc = new LangSrvService();
  assert.equal(svc.status().semantic, 'unknown');
  assert.equal(svc.status().lspConfigured, false);
});
