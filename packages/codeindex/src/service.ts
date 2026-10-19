/**
 * CodeIndexService — the server/agent-facing facade.
 *
 * Owns the path jail (roots allowlist), the on-disk cache, and an
 * in-memory registry of loaded indexes:
 *
 *   const svc = new CodeIndexService({ cacheDir, roots: ['/srv/repos'] });
 *   const stats = await svc.buildIndex('/srv/repos/myapp'); // 403 outside roots
 *   const hits  = await svc.search('/srv/repos/myapp', 'buildIndex', 'symbols');
 *
 * Path jail: `root` is realpath-resolved and must sit inside one of the
 * configured roots, otherwise a 403-style Error is thrown. Roots default
 * to FACTORY_CODEINDEX_ROOTS (comma-separated); empty = deny everything
 * (fail-closed — the operator must explicitly allow roots).
 *
 * Incremental: buildIndex loads the previous on-disk index and passes
 * it as `previous`, so unchanged files (same mtime+size) are reused.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  buildIndex,
  defaultCacheDir,
  loadIndex,
  saveIndex,
} from './indexer.js';
import { getDefinition, searchSymbols, searchText, withContext } from './query.js';
import type { IndexData, IndexStats, SearchHit } from './types.js';
import type { QueryOptions } from './query.js';

export class CodeIndexError extends Error {
  /** Machine-readable code: 'ROOT_DENIED' | 'ROOT_NOT_FOUND' | 'NOT_INDEXED'. */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodeIndexError';
    this.code = code;
  }
}

export interface CodeIndexServiceOptions {
  cacheDir?: string;
  /** Absolute allowed roots. Defaults to FACTORY_CODEINDEX_ROOTS. */
  roots?: string[];
}

export class CodeIndexService {
  private readonly cacheDir: string;
  private readonly roots: string[];
  private readonly loaded = new Map<string, IndexData>();

  constructor(opts: CodeIndexServiceOptions = {}) {
    this.cacheDir = opts.cacheDir ?? defaultCacheDir();
    const envRoots = (process.env.FACTORY_CODEINDEX_ROOTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.roots = (opts.roots ?? envRoots).map((r) => path.resolve(r));
  }

  /** Realpath-resolve + jail check. Throws CodeIndexError('ROOT_DENIED'). */
  async resolveRoot(root: string): Promise<string> {
    const abs = path.resolve(root);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      throw new CodeIndexError('ROOT_NOT_FOUND', `root does not exist: ${root}`);
    }
    const st = await fs.stat(real).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new CodeIndexError('ROOT_NOT_FOUND', `root is not a directory: ${root}`);
    }
    const ok = this.roots.some(
      (r) => real === r || real.startsWith(r + path.sep),
    );
    if (!ok) {
      throw new CodeIndexError(
        'ROOT_DENIED',
        `root is outside the allowed code-index roots (set FACTORY_CODEINDEX_ROOTS)`,
      );
    }
    return real;
  }

  /** Build (or incrementally refresh) the index for a jailed root. */
  async buildIndex(root: string): Promise<IndexStats> {
    const real = await this.resolveRoot(root);
    const previous = (await loadIndex(this.cacheDir, real)) ?? undefined;
    const { index, stats } = await buildIndex(real, { previous });
    await saveIndex(this.cacheDir, index);
    this.loaded.set(real, index);
    return stats;
  }

  /** Load the index for a root (from memory, else disk). */
  async getIndex(root: string): Promise<IndexData> {
    const real = await this.resolveRoot(root);
    const mem = this.loaded.get(real);
    if (mem) return mem;
    const disk = await loadIndex(this.cacheDir, real);
    if (!disk) {
      throw new CodeIndexError('NOT_INDEXED', `no index for root (POST /api/codeindex/index first)`);
    }
    this.loaded.set(real, disk);
    return disk;
  }

  async search(
    root: string,
    query: string,
    mode: 'symbols' | 'text' = 'symbols',
    opts: QueryOptions = {},
  ): Promise<SearchHit[]> {
    const index = await this.getIndex(root);
    const hits = mode === 'text'
      ? searchText(index, query, opts)
      : searchSymbols(index, query, opts);
    if (opts.contextLines && opts.contextLines > 0) {
      return withContext(index.root, hits, opts.contextLines);
    }
    return hits;
  }

  async getDefinition(root: string, name: string): Promise<SearchHit[]> {
    const index = await this.getIndex(root);
    return getDefinition(index, name);
  }

  /** For tests: clear the in-memory registry. */
  clearMemory(): void {
    this.loaded.clear();
  }
}
