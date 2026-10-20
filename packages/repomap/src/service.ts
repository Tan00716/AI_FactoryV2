/**
 * RepoMapService — server/agent-facing facade.
 *
 * Owns the path jail (same roots allowlist as codeindex:
 * FACTORY_CODEINDEX_ROOTS, comma-separated; empty = deny everything,
 * fail-closed) and the on-disk map cache. Reuses @ai-factory/codeindex
 * for the underlying file walk + incremental index (its mtime+size
 * watermarks), then builds the importance-ranked map on top.
 *
 *   const svc = new RepoMapService();
 *   const { markdown, stats } = await svc.buildMap('/srv/repos/myapp');
 *
 * Map JSON is cached atomically under FACTORY_DATA_DIR/repomap (or
 * ~/.ai-factory/repomap); the codeindex cache it builds on lives next
 * to it under .../codeindex.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildIndex, loadIndex, saveIndex } from '@ai-factory/codeindex';
import { buildRepoMap, renderMarkdown } from './map.js';
import type { BuildMapOptions, RepoMapData, RepoMapStats } from './types.js';

export class RepoMapError extends Error {
  /** Machine-readable code: 'ROOT_DENIED' | 'ROOT_NOT_FOUND'. */
  code: string;
  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'RepoMapError';
    this.code = code;
  }
}

export interface RepoMapServiceOptions {
  cacheDir?: string;
  /** Absolute allowed roots. Defaults to FACTORY_CODEINDEX_ROOTS. */
  roots?: string[];
  /**
   * Two-tier ignore gate predicate (task ②), consulted when the map's
   * underlying code index is built (forIndex=true so the indexing tier
   * also applies).
   */
  ignoreCheck?: (root: string, abs: string, isDir: boolean) => boolean;
}

export function defaultMapCacheDir(): string {
  const base = process.env.FACTORY_DATA_DIR || path.join(os.homedir(), '.ai-factory');
  return path.join(base, 'repomap');
}

function defaultCodeIndexCacheDir(): string {
  const base = process.env.FACTORY_DATA_DIR || path.join(os.homedir(), '.ai-factory');
  return path.join(base, 'codeindex');
}

function mapFilePath(cacheDir: string, root: string): string {
  const safe = root.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  return path.join(cacheDir, `${safe}.map.json`);
}

export class RepoMapService {
  private readonly cacheDir: string;
  private readonly codeIndexCacheDir: string;
  private readonly roots: string[];
  private readonly ignoreCheck?: (root: string, abs: string, isDir: boolean) => boolean;

  constructor(opts: RepoMapServiceOptions = {}) {
    this.cacheDir = opts.cacheDir ?? defaultMapCacheDir();
    this.codeIndexCacheDir =
      opts.cacheDir !== undefined
        ? path.join(path.dirname(opts.cacheDir), 'codeindex')
        : defaultCodeIndexCacheDir();
    const envRoots = (process.env.FACTORY_CODEINDEX_ROOTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.roots = (opts.roots ?? envRoots).map((r) => path.resolve(r));
    this.ignoreCheck = opts.ignoreCheck;
  }

  /** Realpath-resolve + jail check. Throws RepoMapError('ROOT_DENIED'). */
  async resolveRoot(root: string): Promise<string> {
    const abs = path.resolve(root);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      throw new RepoMapError('ROOT_NOT_FOUND', `root does not exist: ${root}`);
    }
    const st = await fs.stat(real).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new RepoMapError('ROOT_NOT_FOUND', `root is not a directory: ${root}`);
    }
    const ok = this.roots.some((r) => real === r || real.startsWith(r + path.sep));
    if (!ok) {
      throw new RepoMapError(
        'ROOT_DENIED',
        'root is outside the allowed code-index roots (set FACTORY_CODEINDEX_ROOTS)',
      );
    }
    return real;
  }

  /**
   * Build (or incrementally refresh) the repo map for a jailed root.
   * The underlying codeindex rebuild reuses unchanged files via its
   * mtime+size watermarks unless `full` is set. Returns the map data,
   * its markdown rendering, and stats.
   */
  async buildMap(
    root: string,
    opts: BuildMapOptions = {},
  ): Promise<{ map: RepoMapData; markdown: string; stats: RepoMapStats }> {
    const t0 = Date.now();
    const real = await this.resolveRoot(root);
    const previous = opts.full ? undefined : (await loadIndex(this.codeIndexCacheDir, real)) ?? undefined;
    const { index, stats: indexStats } = await buildIndex(real, {
      previous,
      ignore: this.ignoreCheck ? (abs, isDir) => this.ignoreCheck!(real, abs, isDir) : undefined,
    });
    await saveIndex(this.codeIndexCacheDir, index);
    const { map, markdown, totals } = buildRepoMap(index, { maxTokens: opts.maxTokens });
    await this.saveMap(map);
    const stats: RepoMapStats = {
      root: real,
      files: totals.files,
      symbols: totals.symbols,
      totalRefs: totals.refs,
      truncated: map.truncated,
      omittedFiles: map.omittedFiles,
      estimatedTokens: map.estimatedTokens,
      incremental: !indexStats.full,
      builtAt: map.builtAt,
      ms: Date.now() - t0,
    };
    return { map, markdown, stats };
  }

  /** Load the cached map JSON for a root, or null when absent/corrupt. */
  async loadCachedMap(root: string): Promise<RepoMapData | null> {
    const real = await this.resolveRoot(root);
    try {
      const raw = await fs.readFile(mapFilePath(this.cacheDir, real), 'utf8');
      const data = JSON.parse(raw) as RepoMapData;
      if (data.version !== 1 || data.root !== real) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Re-render a cached map as markdown without rebuilding. */
  renderCached(map: RepoMapData): string {
    return renderMarkdown(map);
  }

  private async saveMap(map: RepoMapData): Promise<string> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const dest = mapFilePath(this.cacheDir, map.root);
    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map));
    await fs.rename(tmp, dest);
    return dest;
  }
}
