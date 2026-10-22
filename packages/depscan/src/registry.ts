/**
 * @ai-factory/depscan — registry metadata providers.
 *
 * Two providers, one interface:
 *  - bundledSnapshotProvider(): offline, always available. Reads the
 *    hand-maintained snapshot shipped with this package
 *    (src/snapshots/registry-snapshot.json -> dist/snapshots/ on build).
 *  - liveNpmProvider(): fetches registry.npmjs.org metadata over HTTPS.
 *    Fail-closed on ANY error (network, parse, shape); the caller decides
 *    whether live mode is even offered (the server gates it behind the
 *    egress firewall + an explicit per-request opt-in).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RegistryMeta } from './types';
import { maxVersion } from './semver';

export interface RegistryProvider {
  /** Where the data came from (snapshot date or 'live'). */
  source: string;
  /** Snapshot date, or null for live data. */
  snapshotDate: string | null;
  /** Number of packages in the source, when known (snapshot honesty). */
  packageCount?: number;
  /** Metadata for the requested names. Missing names are simply absent. */
  fetch(names: string[]): Promise<Map<string, RegistryMeta>>;
}

interface SnapshotFile {
  _meta: { snapshotDate: string; source: string; honestBoundary: string };
  packages: Record<string, { versions: string[]; latest: string; changelogUrl?: string }>;
}

/**
 * Locate the bundled snapshot JSON without import.meta / __dirname
 * (both break one of the dual modes — same rationale as
 * builtinRecipesDir() in apps/server/src/recipes.ts):
 *
 *  1. AI_FACTORY_DEPSCAN_SNAPSHOT_DIR (explicit override; tests use this)
 *  2. resolved through the installed package (CJS dist only; skipped under
 *     type-stripping where require is unavailable)
 *  3. repo-root cwd layouts: packages/depscan/dist/snapshots,
 *     packages/depscan/src/snapshots
 */
function snapshotJsonPath(): string | null {
  const candidates: string[] = [];
  const envDir = process.env.AI_FACTORY_DEPSCAN_SNAPSHOT_DIR;
  if (envDir && envDir.trim()) {
    candidates.push(join(resolve(envDir.trim()), 'registry-snapshot.json'));
  }
  try {
    const req = (globalThis as { require?: { resolve?: (id: string) => string } }).require;
    if (typeof req?.resolve === 'function') {
      const pkgJson = req.resolve('@ai-factory/depscan/package.json');
      candidates.push(join(dirname(pkgJson), 'dist', 'snapshots', 'registry-snapshot.json'));
    }
  } catch {
    /* ignore: fall through to cwd layouts */
  }
  const cwd = process.cwd();
  candidates.push(join(cwd, 'packages', 'depscan', 'dist', 'snapshots', 'registry-snapshot.json'));
  candidates.push(join(cwd, 'packages', 'depscan', 'src', 'snapshots', 'registry-snapshot.json'));
  for (const p of candidates) {
    try {
      readFileSync(p, 'utf8');
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseSnapshotFile(raw: string): SnapshotFile {
  const data = JSON.parse(raw) as SnapshotFile;
  if (!data || typeof data !== 'object' || !data._meta || !data.packages) {
    throw new Error('registry snapshot has an unexpected shape');
  }
  return data;
}

/** Load the bundled snapshot (throws when the JSON is missing/corrupt). */
export function loadBundledSnapshot(): { meta: SnapshotFile['_meta']; registry: Map<string, RegistryMeta> } {
  const p = snapshotJsonPath();
  if (!p) throw new Error('bundled registry snapshot not found (package not built?)');
  const data = parseSnapshotFile(readFileSync(p, 'utf8'));
  const registry = new Map<string, RegistryMeta>();
  for (const [name, entry] of Object.entries(data.packages)) {
    if (!entry || !Array.isArray(entry.versions) || typeof entry.latest !== 'string') continue;
    registry.set(name, {
      name,
      versions: entry.versions.filter((v) => typeof v === 'string'),
      latest: entry.latest,
      changelogUrl: entry.changelogUrl,
    });
  }
  return { meta: data._meta, registry };
}

/** Offline provider: the bundled snapshot. */
export function bundledSnapshotProvider(): RegistryProvider {
  const { meta, registry } = loadBundledSnapshot();
  return {
    source: `bundled-snapshot (${meta.snapshotDate})`,
    snapshotDate: meta.snapshotDate,
    packageCount: registry.size,
    fetch: async (names: string[]) => {
      const out = new Map<string, RegistryMeta>();
      for (const n of names) {
        const m = registry.get(n);
        if (m) out.set(n, m);
      }
      return out;
    },
  };
}

interface NpmDoc {
  name?: string;
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { deprecated?: string }>;
  homepage?: string;
  repository?: { url?: string };
}

function changelogGuess(doc: NpmDoc): string | undefined {
  const repo = doc.repository?.url ?? '';
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(repo.replace(/\/$/, ''));
  if (m) return `https://github.com/${m[1]}/releases`;
  if (doc.homepage && doc.homepage.includes('github.com')) return doc.homepage;
  return undefined;
}

/**
 * Live provider: registry.npmjs.org over HTTPS. Fail-closed on any error.
 * The caller MUST gate this behind the egress firewall + explicit opt-in.
 */
export function liveNpmProvider(fetchImpl: typeof fetch = fetch): RegistryProvider {
  return {
    source: 'live (registry.npmjs.org)',
    snapshotDate: null,
    fetch: async (names: string[]) => {
      const out = new Map<string, RegistryMeta>();
      for (const name of names.slice(0, 200)) {
        let res: Response;
        try {
          res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
            headers: { accept: 'application/json' },
          });
        } catch {
          throw new Error(`live registry unreachable for '${name}'`);
        }
        if (!res.ok) throw new Error(`live registry returned ${res.status} for '${name}'`);
        let doc: NpmDoc;
        try {
          doc = (await res.json()) as NpmDoc;
        } catch {
          throw new Error(`live registry returned bad JSON for '${name}'`);
        }
        const versions = Object.keys(doc.versions ?? {});
        const latest = doc['dist-tags']?.latest ?? maxVersion(versions);
        if (!latest) throw new Error(`live registry has no usable versions for '${name}'`);
        out.set(name, { name, versions, latest, changelogUrl: changelogGuess(doc) });
      }
      return out;
    },
  };
}
