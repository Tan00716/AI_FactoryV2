/**
 * Demo: structural search and replace on a sample file.
 * Run from the built package: node dist/demo/ssr.demo.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  validateTemplate,
  findMatches,
  previewEdits,
  builtinTemplates,
} from '../src/index.js';

const here = join(__dirname, '..', '..', 'tests', 'fixtures', 'repo');
const text = readFileSync(join(here, 'service.ts'), 'utf8');
const files = [{ file: 'service.ts', text }];

console.log('=== builtin templates ===');
for (const t of builtinTemplates()) {
  console.log(`- ${t.id}: ${t.name}`);
}

const { template } = validateTemplate({
  id: 'demo-public-async',
  name: 'demo',
  version: 1,
  search: { kind: 'method', modifiers: ['public', 'async'] },
  replace: { op: 'rename', to: 'renamed' },
});
const matches = findMatches(files, template!);
console.log(`\n=== search: public async methods -> ${matches.length} match(es) ===`);
for (const m of matches) {
  console.log(`  ${m.file}:${m.startLine} ${m.kind} ${m.parent}.${m.name}`);
}
const { diffs, skipped } = previewEdits(new Map([['service.ts', text]]), matches, template!);
console.log('\n=== preview (rename, dry-run) ===');
console.log(diffs['service.ts'] ?? '(no diff)');
console.log(`skipped: ${skipped.length}`);
