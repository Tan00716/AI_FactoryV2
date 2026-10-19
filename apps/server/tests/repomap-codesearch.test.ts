/**
 * code_search map:true option — the runtime tool attaches the
 * @ai-factory/repomap structural map as sanitized context.
 *
 * Imports the route from src (like runtime-intents.test.ts) and
 * invokes the tool impl directly through the getRuntimeToolImpl
 * test seam, with both services injected via their setters.
 *
 * Run: node scripts/run-tests-tmp.mjs --test apps/server/tests/repomap-codesearch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexService } from '@ai-factory/codeindex';
import { RepoMapService } from '@ai-factory/repomap';
import {
  getRuntimeToolImpl,
  setRuntimeCodeIndexService,
  setRuntimeRepoMapService,
} from '../src/routes/runtime.ts';

function fixture(): { dir: string; repo: string; cache: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aif-rmcs-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, 'svc.ts'),
    'export class WidgetService {\n  build() { return 1; }\n}\n',
  );
  writeFileSync(
    join(repo, 'app.ts'),
    "import { WidgetService } from './svc';\nnew WidgetService().build();\n",
  );
  return { dir, repo, cache: join(dir, 'cache') };
}

test('code_search map:true attaches the sanitized repo map; default omits it', async () => {
  const { dir, repo, cache } = fixture();
  const codeIndex = new CodeIndexService({ cacheDir: join(cache, 'codeindex'), roots: [repo] });
  const repoMap = new RepoMapService({ cacheDir: join(cache, 'repomap'), roots: [repo] });
  setRuntimeCodeIndexService(codeIndex);
  setRuntimeRepoMapService(repoMap);
  await codeIndex.buildIndex(repo);
  try {
    const impl = getRuntimeToolImpl('code_search');
    assert.ok(impl, 'code_search impl registered');

    const withMap = await impl({ root: repo, q: 'WidgetService', map: true });
    assert.equal(withMap.ok, true);
    assert.ok(
      typeof withMap.map === 'string' && withMap.map.includes('# Repo map'),
      'map markdown attached',
    );
    assert.ok(
      (withMap.promptSafe as string).includes('# Repo map'),
      'promptSafe includes the map block',
    );
    assert.ok(
      (withMap.map as string).includes('WidgetService'),
      'map names the top symbol',
    );

    const plain = await impl({ root: repo, q: 'WidgetService' });
    assert.equal(plain.ok, true);
    assert.ok(!('map' in (plain as Record<string, unknown>)), 'no map field by default');
    assert.ok(Array.isArray((plain as { hits: unknown[] }).hits));
  } finally {
    setRuntimeCodeIndexService(null);
    setRuntimeRepoMapService(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
