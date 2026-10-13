/**
 * SBOM generation from lockfiles — SPEC v2 §40 (Batch 25).
 *
 * What "SBOM" means in this product, honestly:
 *
 *  - SOURCE. The SBOM is derived from the lockfile(s) found in the
 *    build worktree BEFORE it is deleted (see BuildRunner). It is an
 *    inventory of the revision's DECLARED/RESOLVED dependencies, not a
 *    scan of installed files and not a proof of what the built artifact
 *    actually linked. The document carries this provenance in
 *    metadata.properties so no consumer mistakes it for an
 *    install-tree attestation.
 *  - FORMAT. A minimal CycloneDX 1.5 subset: bomFormat/specVersion/
 *    metadata/components. Only `library` components with name, version
 *    and a purl-style bom-ref. No hashes (we hash the lockfile bytes
 *    for the §40 digest separately), no licenses (lockfiles do not
 *    reliably carry them — inventing them would be fabrication).
 *  - HONESTY RULES. Every lockfile is parsed best-effort; an
 *    unparseable lockfile is SKIPPED with a named reason, never a
 *    crash and never silent. Duplicate name@version entries collapse.
 *    Components are sorted for determinism. When the component count
 *    exceeds the cap, the document says so (metadata.truncated) and
 *    the caller's note must say so too.
 *  - NO-LOCKFILE. No parsable lockfile → no SBOM (document null +
 *    note). A repository without a lockfile has no honest dependency
 *    inventory to derive; generating one from node_modules or from
 *    package.json ranges would be a different (weaker) claim.
 *
 * Supported lockfiles: package-lock.json (npm v1/v2/v3),
 * yarn.lock (classic v1), pnpm-lock.yaml (packages: section),
 * Cargo.lock. Anything else in LOCKFILE_NAMES (bun.lockb, go.sum,
 * poetry.lock, ...) is reported as skipped/unsupported — parsing half
 * a format would be worse than admitting the gap.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectLockfiles } from './build';

export const SBOM_SPEC_VERSION = '1.5';
export const SBOM_TOOL_NAME = 'ai-factory-sbom-generator';
export const SBOM_TOOL_VERSION = '0.1.0';
/** Hard cap on components per document — bounds memory and file size. */
export const MAX_SBOM_COMPONENTS = 20_000;
/**
 * Batch 26 — filenames the build runner writes: sbom-<buildId>.json
 * where buildId is a randomUUID. Retention only ever touches files
 * matching this shape; anything else in the directory is left alone
 * (retention never deletes blind). Tight on purpose: if buildId
 * formats ever change, old files are kept, never swept.
 */
export const SBOM_FILE_RE =
  /^sbom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export interface SbomComponent {
  type: 'library';
  name: string;
  version: string;
  /** purl-style reference: pkg:<ecosystem>/<name>@<version>. */
  'bom-ref': string;
}

export interface SbomSource {
  /** Repo-relative lockfile path, e.g. "package-lock.json". */
  lockfile: string;
  ecosystem: string;
  componentCount: number;
}

export interface SbomDocument {
  bomFormat: 'CycloneDX';
  specVersion: typeof SBOM_SPEC_VERSION;
  version: 1;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: {
      type: 'application';
      'bom-ref': string;
      name: string;
    };
    properties: Array<{ name: string; value: string }>;
    /** Present and true when the component list was truncated at the cap. */
    truncated?: true;
  };
  components: SbomComponent[];
}

export interface GenerateSbomResult {
  /** The document, or null when no lockfile yielded components. */
  document: SbomDocument | null;
  /** One entry per lockfile that contributed components. */
  sources: SbomSource[];
  /** Lockfiles seen but not parsed, with reasons (never silent). */
  skipped: Array<{ lockfile: string; reason: string }>;
  /**
   * Human-readable outcome note for the build record's sbomNote:
   * empty on success, naming the gap otherwise.
   */
  note: string;
}

interface Parsed {
  ecosystem: string;
  components: Array<{ name: string; version: string }>;
}

function pkgRef(ecosystem: string, name: string, version: string): string {
  return `pkg:${ecosystem}/${name}@${version}`;
}

/** npm package-lock.json — lockfileVersion 1 (dependencies map),
 *  v2/v3 (packages map keyed by node_modules/<path>). */
function parsePackageLock(text: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const d = data as Record<string, unknown>;
  const out = new Map<string, string>();
  const put = (name: string, version: unknown) => {
    if (typeof version === 'string' && version.length > 0 && name) {
      const key = `${name}@${version}`;
      if (!out.has(key)) out.set(key, version);
    }
  };
  // v2/v3: packages["node_modules/<name>"] = { version }
  const packages = d['packages'];
  if (packages && typeof packages === 'object') {
    for (const [p, meta] of Object.entries(packages as Record<string, unknown>)) {
      if (!p.startsWith('node_modules/')) continue;
      // Nested: node_modules/a/node_modules/b → the real package is b.
      const rest = p.slice('node_modules/'.length);
      const segs = rest.split('/node_modules/');
      const name = segs[segs.length - 1];
      const version = (meta as Record<string, unknown> | null)?.['version'];
      put(name, version);
    }
  }
  // v1 (and v2's legacy mirror): dependencies = { name: { version } }
  const deps = d['dependencies'];
  if (deps && typeof deps === 'object') {
    for (const [name, meta] of Object.entries(deps as Record<string, unknown>)) {
      const version = (meta as Record<string, unknown> | null)?.['version'];
      put(name, version);
    }
  }
  if (out.size === 0) {
    // A lockfile with zero parseable entries is not an inventory.
    throw new Error('no parseable package entries');
  }
  return {
    ecosystem: 'npm',
    components: [...out.entries()].map(([nv, version]) => ({
      name: nv.slice(0, nv.lastIndexOf('@')),
      version,
    })),
  };
}

/** yarn classic v1: `"name@range":` blocks followed by `  version "x"`. */
function parseYarnLock(text: string): Parsed {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  let pendingName: string | null = null;
  for (const line of lines) {
    // A header line is non-indented and ends with ':'.
    if (/^\S/.test(line) && line.trimEnd().endsWith(':')) {
      // Take the first selector, strip quotes: "name@^1.0.0", name@npm:...
      const first = line
        .trimEnd()
        .slice(0, -1)
        .split(/,\s*/)[0]
        .replace(/^"|"$/g, '');
      // Scoped names keep their scope: "@scope/name@^1.0" → "@scope/name".
      const at = first.lastIndexOf('@');
      pendingName = at > 0 ? first.slice(0, at) : null;
      continue;
    }
    const m = /^ {2}version "([^"]+)"\s*$/.exec(line);
    if (m && pendingName) {
      const key = `${pendingName}@${m[1]}`;
      if (!out.has(key)) out.set(key, m[1]);
      pendingName = null;
    }
  }
  if (out.size === 0) throw new Error('no parseable package entries');
  return {
    ecosystem: 'npm',
    components: [...out.entries()].map(([nv, version]) => ({
      name: nv.slice(0, nv.lastIndexOf('@')),
      version,
    })),
  };
}

/** pnpm-lock.yaml: entries under the top-level `packages:` key look
 *  like `  name@1.2.3:` or `  /@scope/name@1.2.3:`. Best-effort line
 *  scan — a YAML parser is not vendored, so anything exotic is
 *  skipped loudly by the caller, not misread. */
function parsePnpmLock(text: string): Parsed {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^[^\s#]/.test(line)) break; // next top-level key
    if (!inPackages) continue;
    const m = /^ {2}\/?([^@\s][^:\s]*?)@([^:\s(]+)/.exec(line);
    if (m) {
      const key = `${m[1]}@${m[2]}`;
      if (!out.has(key)) out.set(key, m[2]);
    }
  }
  if (out.size === 0) throw new Error('no parseable package entries');
  return {
    ecosystem: 'npm',
    components: [...out.entries()].map(([nv, version]) => ({
      name: nv.slice(0, nv.lastIndexOf('@')),
      version,
    })),
  };
}

/** Cargo.lock: `[[package]]` blocks with name = / version = lines. */
function parseCargoLock(text: string): Parsed {
  const out = new Map<string, string>();
  let name: string | null = null;
  const flush = () => {
    name = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '[[package]]') {
      name = null;
      continue;
    }
    const nm = /^name\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (nm) {
      name = nm[1];
      continue;
    }
    const vm = /^version\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (vm && name) {
      const key = `${name}@${vm[1]}`;
      if (!out.has(key)) out.set(key, vm[1]);
      flush();
    }
  }
  if (out.size === 0) throw new Error('no parseable package entries');
  return {
    ecosystem: 'cargo',
    components: [...out.entries()].map(([nv, version]) => ({
      name: nv.slice(0, nv.lastIndexOf('@')),
      version,
    })),
  };
}

const PARSERS: Record<string, (text: string) => Parsed> = {
  'package-lock.json': parsePackageLock,
  'yarn.lock': parseYarnLock,
  'pnpm-lock.yaml': parsePnpmLock,
  'Cargo.lock': parseCargoLock,
};

/**
 * Generate a CycloneDX-lite SBOM from the lockfiles in a build
 * worktree. Never throws on bad input — every problem is reported in
 * `skipped` / `note`. `revision` identifies the built application in
 * metadata. `maxComponents` is injectable for tests.
 */
export function generateSbom(
  workDir: string,
  revision: string,
  opts: { maxComponents?: number; now?: () => string } = {},
): GenerateSbomResult {
  const maxComponents = opts.maxComponents ?? MAX_SBOM_COMPONENTS;
  const now = opts.now ?? (() => new Date().toISOString());
  const lockfiles = detectLockfiles(workDir);
  const seen = new Map<string, SbomComponent>();
  const sources: SbomSource[] = [];
  const skipped: Array<{ lockfile: string; reason: string }> = [];

  for (const abs of lockfiles) {
    const base = basename(abs);
    const rel = abs.startsWith(workDir + '/') ? abs.slice(workDir.length + 1) : abs;
    const parse = PARSERS[base];
    if (!parse) {
      skipped.push({ lockfile: rel, reason: `unsupported lockfile format: ${base}` });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      skipped.push({ lockfile: rel, reason: `unreadable: ${(err as Error).message}` });
      continue;
    }
    let parsed: Parsed;
    try {
      parsed = parse(text);
    } catch (err) {
      skipped.push({ lockfile: rel, reason: `unparseable: ${(err as Error).message}` });
      continue;
    }
    let count = 0;
    for (const c of parsed.components) {
      const key = `${parsed.ecosystem}|${c.name}|${c.version}`;
      if (!seen.has(key)) {
        seen.set(key, {
          type: 'library',
          name: c.name,
          version: c.version,
          'bom-ref': pkgRef(parsed.ecosystem, c.name, c.version),
        });
        count++;
      }
    }
    sources.push({ lockfile: rel, ecosystem: parsed.ecosystem, componentCount: count });
  }

  if (seen.size === 0) {
    const why =
      lockfiles.length === 0
        ? 'no lockfile found in the build worktree — no SBOM generated (nothing honest to derive from)'
        : `no parsable lockfile (${skipped.map((s) => `${s.lockfile}: ${s.reason}`).join('; ')})`;
    return { document: null, sources, skipped, note: why };
  }

  const sorted = [...seen.values()].sort((a, b) =>
    a['bom-ref'] < b['bom-ref'] ? -1 : a['bom-ref'] > b['bom-ref'] ? 1 : 0,
  );
  const truncated = sorted.length > maxComponents;
  const components = truncated ? sorted.slice(0, maxComponents) : sorted;

  const document: SbomDocument = {
    bomFormat: 'CycloneDX',
    specVersion: SBOM_SPEC_VERSION,
    version: 1,
    metadata: {
      timestamp: now(),
      tools: [{ vendor: 'ai-factory', name: SBOM_TOOL_NAME, version: SBOM_TOOL_VERSION }],
      component: {
        type: 'application',
        'bom-ref': `build:${revision}`,
        name: `build@${revision.slice(0, 12)}`,
      },
      properties: [
        {
          name: 'ai-factory:sbom:provenance',
          value:
            'derived from lockfile(s): inventory of declared/resolved ' +
            'dependencies at the built revision, not a scan of installed ' +
            'files and not proof of what the artifact linked',
        },
        {
          name: 'ai-factory:sbom:sources',
          value: sources.map((s) => `${s.lockfile}(${s.componentCount})`).join(','),
        },
      ],
      ...(truncated ? { truncated: true as const } : {}),
    },
    components,
  };

  const note = truncated
    ? `SBOM truncated at ${maxComponents} components (lockfile inventory larger) — see metadata.truncated`
    : '';
  return { document, sources, skipped, note };
}
