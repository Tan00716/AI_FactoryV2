/**
 * Dependency upgrade advisor routes (round-4 task R4-B10).
 *
 * npm-outdated style: which deps have newer versions, semver safety
 * grading (patch/minor/major), copy-pasteable upgrade plan + CHANGELOG
 * links, CVE cross-reference against the offline advisory snapshot.
 *
 * Endpoints:
 *  POST /api/depscan/advise    — build an upgrade plan for a project
 *  GET  /api/depscan/snapshot  — bundled snapshot metadata (honest boundary)
 *
 * Dual-mode import rule (AGENTS.md): this module is imported straight from
 * src by unit tests under node's type-stripping loader, so it value-imports
 * ONLY node builtins and @ai-factory/depscan. Everything else crosses via
 * the setter injections below (wired by the coordinator in index.ts):
 *  - inspection-root resolver (project jail)
 *  - CVE matcher (built from the hand-maintained blacklist in inspections.ts)
 *  - registry provider override (tests inject fakes; default = bundled snapshot)
 *  - live-registry egress gate (index.ts wires assertEgressAllowed)
 *
 * Default registry source is the OFFLINE bundled snapshot; live mode is
 * explicit per-request opt-in and fail-closed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildUpgradePlan,
  bundledSnapshotProvider,
  liveNpmProvider,
  type CveMatcher,
  type InstalledDep,
  type RegistryProvider,
  type UpgradePlan,
} from '@ai-factory/depscan';
import type { RouteContext } from './context';

const PREFIX = '/api/depscan';
const MAX_JSON_BYTES = 1_000_000;
const MAX_DEPS = 2000;

export class DepscanRouteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number = 400, code: string = 'DEPSCAN_BAD_REQUEST') {
    super(message);
    this.name = 'DepscanRouteError';
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------ injections ------------------------------ */

let inspectionRootResolver: ((root?: string) => string) | null = null;
let cveMatcher: CveMatcher | null = null;
let registryProviderOverride: RegistryProvider | null = null;
let liveRegistryGate: ((host: string) => void) | null = null;

export function setDepscanInspectionRootResolver(fn: ((root?: string) => string) | null): void {
  inspectionRootResolver = fn;
}
export function setDepscanCveMatcher(fn: CveMatcher | null): void {
  cveMatcher = fn;
}
export function setDepscanRegistryProvider(p: RegistryProvider | null): void {
  registryProviderOverride = p;
}
export function setDepscanLiveRegistryGate(fn: ((host: string) => void) | null): void {
  liveRegistryGate = fn;
}

/* ------------------------------ helpers ------------------------------- */

function projectIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > 128) return null;
  return id;
}

function resolveTargetDir(rawDir?: unknown): string {
  if (!inspectionRootResolver) {
    throw new DepscanRouteError('inspection root resolver is not wired', 500, 'DEPSCAN_UNWIRED');
  }
  const dir = typeof rawDir === 'string' && rawDir.trim() ? rawDir.trim() : undefined;
  try {
    return inspectionRootResolver(dir);
  } catch (e) {
    throw new DepscanRouteError((e as Error).message, 400, 'DEPSCAN_BAD_DIR');
  }
}

function readJsonFile(path: string, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new DepscanRouteError(`${what} not found`, 404, 'DEPSCAN_NO_MANIFEST');
  }
  if (raw.length > MAX_JSON_BYTES) {
    throw new DepscanRouteError(`${what} exceeds ${MAX_JSON_BYTES} bytes`, 413, 'DEPSCAN_TOO_LARGE');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new DepscanRouteError(`${what} is not valid JSON`, 400, 'DEPSCAN_BAD_JSON');
  }
}

/** package-lock.json v1/v2/v3 → name → resolved version. */
function lockfileVersions(lock: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!lock || typeof lock !== 'object') return out;
  const l = lock as Record<string, unknown>;
  const pkgs = l.packages;
  if (pkgs && typeof pkgs === 'object') {
    for (const [key, entry] of Object.entries(pkgs as Record<string, unknown>)) {
      if (!key.startsWith('node_modules/') || key.includes('/node_modules/')) continue;
      const name = key.slice('node_modules/'.length);
      if (entry && typeof entry === 'object') {
        const v = (entry as Record<string, unknown>).version;
        if (typeof v === 'string' && v) out.set(name, v);
      }
    }
  }
  const deps = l.dependencies;
  if (deps && typeof deps === 'object') {
    for (const [name, entry] of Object.entries(deps as Record<string, unknown>)) {
      if (out.has(name)) continue;
      if (entry && typeof entry === 'object') {
        const v = (entry as Record<string, unknown>).version;
        if (typeof v === 'string' && v) out.set(name, v);
      }
    }
  }
  return out;
}

function collectInstalled(pkg: unknown, lock: unknown): InstalledDep[] {
  if (!pkg || typeof pkg !== 'object') {
    throw new DepscanRouteError('package.json has an unexpected shape', 400, 'DEPSCAN_BAD_JSON');
  }
  const p = pkg as Record<string, unknown>;
  const locked = lockfileVersions(lock);
  const out: InstalledDep[] = [];
  const seen = new Set<string>();
  for (const [section, dev] of [
    ['dependencies', false],
    ['devDependencies', true],
  ] as const) {
    const table = p[section];
    if (!table || typeof table !== 'object') continue;
    for (const [name, range] of Object.entries(table as Record<string, unknown>)) {
      if (typeof range !== 'string' || !name || seen.has(name)) continue;
      seen.add(name);
      // resolved version wins; otherwise the declared range itself (may grade 'unknown').
      const current = locked.get(name) ?? range.trim();
      out.push({ name, current, declaredRange: range.trim(), dev });
      if (out.length > MAX_DEPS) {
        throw new DepscanRouteError(`more than ${MAX_DEPS} dependencies`, 413, 'DEPSCAN_TOO_LARGE');
      }
    }
  }
  return out;
}

async function registryFor(source: string): Promise<RegistryProvider> {
  if (registryProviderOverride) return registryProviderOverride;
  if (source === 'live') {
    if (!liveRegistryGate) {
      throw new DepscanRouteError(
        'live registry is not enabled in this build (bundled snapshot is the default)',
        501,
        'DEPSCAN_LIVE_DISABLED',
      );
    }
    liveRegistryGate('registry.npmjs.org');
    return liveNpmProvider();
  }
  try {
    return bundledSnapshotProvider();
  } catch (e) {
    throw new DepscanRouteError(
      `bundled registry snapshot unavailable: ${(e as Error).message}`,
      503,
      'DEPSCAN_SNAPSHOT_MISSING',
    );
  }
}

/* -------------------------------- routes ------------------------------- */

export async function handleDepscanRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  const actor = 'human';

  // GET /api/depscan/snapshot — bundled snapshot metadata (viewer).
  if (method === 'GET' && path === `${PREFIX}/snapshot`) {
    try {
      const provider = await registryFor('snapshot');
      ctx.json(res, 200, {
        source: provider.source,
        snapshotDate: provider.snapshotDate,
        packageCount: provider.packageCount ?? 0,
        honestBoundary:
          'Hand-maintained snapshot; lags the real registry and covers only a small package set. Not a substitute for a live registry query.',
      });
      return true;
    } catch (e) {
      const err = e as DepscanRouteError;
      ctx.json(res, err.status ?? 503, { error: err.message, code: err.code ?? 'DEPSCAN_SNAPSHOT_MISSING' });
      return true;
    }
  }

  // POST /api/depscan/advise — build an upgrade plan (operator).
  if (method === 'POST' && path === `${PREFIX}/advise`) {
    try {
      const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
      const projectId = projectIdOf(body.projectId);
      if (!projectId) {
        ctx.json(res, 400, { error: 'projectId is required', code: 'DEPSCAN_NO_PROJECT' });
        return true;
      }
      const source = body.source === 'live' ? 'live' : 'snapshot';
      const targetDir = resolveTargetDir(body.dir);
      const pkg = readJsonFile(join(targetDir, 'package.json'), 'package.json');
      let lock: unknown = null;
      try {
        lock = readJsonFile(join(targetDir, 'package-lock.json'), 'package-lock.json');
      } catch (e) {
        if ((e as DepscanRouteError).code !== 'DEPSCAN_NO_MANIFEST') throw e;
        lock = null; // lockfile optional; declared ranges still advise (may grade 'unknown')
      }
      const installed = collectInstalled(pkg, lock);
      const provider = await registryFor(source);
      const metas = await provider.fetch(installed.map((d) => d.name));
      const plan: UpgradePlan = buildUpgradePlan(installed, metas, {
        cveMatcher,
        registrySource: provider.source,
        snapshotDate: provider.snapshotDate,
      });
      ctx.audit.record(actor, 'DEPSCAN_ADVISED', 'depscan', `${projectId}:advise`, {
        source: provider.source,
        ...plan.summary,
      });
      ctx.json(res, 200, { projectId, plan });
      return true;
    } catch (e) {
      if (e instanceof DepscanRouteError) {
        ctx.json(res, e.status, { error: e.message, code: e.code });
        return true;
      }
      // Egress-gate denials surface as their own error type; keep the code honest.
      const msg = (e as Error).message ?? 'unknown error';
      const blocked = /egress|blocked|denied/i.test(msg);
      ctx.json(res, blocked ? 403 : 500, {
        error: msg,
        code: blocked ? 'DEPSCAN_EGRESS_BLOCKED' : 'DEPSCAN_FAILED',
      });
      return true;
    }
  }

  return false;
}
