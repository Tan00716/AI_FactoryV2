/**
 * RepoMapService tests (node:test, run compiled from dist).
 *
 * Covers: path jail (ROOT_DENIED outside FACTORY_CODEINDEX_ROOTS —
 * fail-closed when unset), ROOT_NOT_FOUND, build round-trip through
 * the on-disk map cache, renderCached, and full vs incremental
 * rebuild equivalence.
 *
 * Run: node scripts/run-tests-tmp.mjs --test packages/repomap/dist/tests/service.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepoMapService, RepoMapError } from '../src/index.js';

let tmp: string;
let cacheDir: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-svc-'));
  cacheDir = path.join(tmp, 'cache');
  await fs.writeFile(
    path.join(tmp, 'a.ts'),
    'export class Alpha {}\nexport function beta() { return new Alpha(); }\n',
  );
  await fs.writeFile(path.join(tmp, 'b.ts'), "import { beta } from './a';\nbeta();\n");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function svcWithRoots(roots: string[]): RepoMapService {
  return new RepoMapService({ cacheDir, roots });
}

describe('RepoMapService path jail', () => {
  it('rejects roots outside the allowlist (ROOT_DENIED)', async () => {
    const svc = svcWithRoots([path.join(tmp, 'nowhere')]);
    await assert.rejects(() => svc.buildMap(tmp), (e: unknown) => {
      assert.ok(e instanceof RepoMapError);
      assert.equal((e as RepoMapError).code, 'ROOT_DENIED');
      return true;
    });
  });

  it('is fail-closed when no roots are configured', async () => {
    const svc = new RepoMapService({ cacheDir, roots: [] });
    await assert.rejects(() => svc.buildMap(tmp), (e: unknown) => {
      assert.ok(e instanceof RepoMapError);
      assert.equal((e as RepoMapError).code, 'ROOT_DENIED');
      return true;
    });
  });

  it('rejects missing roots (ROOT_NOT_FOUND)', async () => {
    const svc = svcWithRoots([tmp]);
    await assert.rejects(
      () => svc.buildMap(path.join(tmp, 'does-not-exist')),
      (e: unknown) => {
        assert.ok(e instanceof RepoMapError);
        assert.equal((e as RepoMapError).code, 'ROOT_NOT_FOUND');
        return true;
      },
    );
  });
});

describe('RepoMapService build', () => {
  it('builds a map and round-trips through the cache', async () => {
    const svc = svcWithRoots([tmp]);
    const { map, markdown, stats } = await svc.buildMap(tmp);
    assert.equal(map.root, await fs.realpath(tmp));
    assert.equal(stats.files, 2);
    assert.equal(stats.symbols, 2, `symbols=${stats.symbols} (Alpha, beta)`);
    assert.ok(markdown.includes('# Repo map'), 'markdown header');
    assert.ok(markdown.includes('Alpha'), 'symbol in markdown');

    const cached = await svc.loadCachedMap(tmp);
    assert.ok(cached, 'cached map loads');
    assert.equal(cached.version, 1);
    assert.equal(cached.files.length, map.files.length);
    const re = svc.renderCached(cached);
    assert.ok(re.includes('# Repo map'), 'renderCached works');
  });

  it('full rebuild matches incremental rebuild', async () => {
    const svc = svcWithRoots([tmp]);
    const a = await svc.buildMap(tmp, { full: true });
    const b = await svc.buildMap(tmp);
    assert.equal(JSON.stringify(a.map.files), JSON.stringify(b.map.files));
    assert.equal(a.stats.incremental, false);
    // Second call reuses the codeindex cache → incremental.
    assert.equal(b.stats.incremental, true);
  });

  it('respects the token budget option', async () => {
    const svc = svcWithRoots([tmp]);
    const { map } = await svc.buildMap(tmp, { maxTokens: 500 });
    assert.equal(map.maxTokens, 500);
  });
});
