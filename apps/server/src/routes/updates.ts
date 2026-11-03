/**
 * Update channel routes — R3-T1 (electron-updater 式, deterministic).
 *
 *   GET  /api/updates/status      channel status (honest "feed not configured")
 *   POST /api/updates/check       manual check (feed → compare → notify)
 *   GET  /api/updates/changelog   parsed CHANGELOG.md entries
 *
 * The periodic check lives in index.ts (unref'd setInterval) and reuses the
 * same runUpdateCheck() orchestration. Download + install happen in the
 * Electron main process (electron-updater) behind an explicit user click —
 * never silently, never from this route.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import {
  getUpdateConfig,
  MAX_FEED_BYTES,
  parseChangelog,
  readAppVersion,
  runUpdateCheck,
  type UpdateCheckResult,
  type UpdateConfig,
} from '../updates';
import { checkEgress, EGRESS_BLOCKED_CODE } from '../egress';
import type { RouteContext } from './context';

const PREFIX = '/api/updates';
const FETCH_TIMEOUT_MS = 15000;

// Repo root resolves identically in src-run (src/routes) and dist-run
// (dist/routes): four levels up from the route file's directory.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');

/** Last-check state: in-memory copy of the persisted record below. */
let lastCheck: { at: number; result: UpdateCheckResult } | null = null;

/**
 * V3.0 audit round 3, item #10 — lastCheck persistence. The record lives in
 * <dataDir>/update-lastcheck.json (same AI_FACTORY_DATA_DIR convention as
 * the run-history store): atomic tmp+rename writes, best-effort (a corrupt
 * or unwritable file never fails a check; corruption surfaces in the status
 * response and the next successful check overwrites it). Only a timestamp
 * plus the check result is stored — never the feed configuration itself, so
 * persisting lastCheck must not be mistaken for a #3 feed decision.
 */
const LASTCHECK_FILE = 'update-lastcheck.json';
const LASTCHECK_STATUSES = new Set(['not-configured', 'up-to-date', 'update-available', 'feed-error', 'fetch-error']);

let lastCheckDir = '';
let lastCheckLoaded = false;
let lastCheckCorrupt = false;
let lastCheckPersistError: string | null = null;

function lastCheckDataDir(): string {
  const env = (process.env['AI_FACTORY_DATA_DIR'] ?? '').trim();
  if (env) return path.resolve(env);
  return path.resolve(process.cwd(), 'data');
}

function isLastCheck(v: unknown): v is { at: number; result: UpdateCheckResult } {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c['at'] !== 'number' || !Number.isFinite(c['at'])) return false;
  const r = c['result'] as Record<string, unknown> | null;
  if (typeof r !== 'object' || r === null) return false;
  return typeof r['status'] === 'string' && LASTCHECK_STATUSES.has(r['status']);
}

function lastCheckFilePath(): string {
  return path.join(lastCheckDataDir(), LASTCHECK_FILE);
}

/** Load the persisted record once per data dir; invalid content => corrupt flag, never a crash. */
function ensureLastCheckLoaded(): void {
  const dir = lastCheckDataDir();
  if (lastCheckLoaded && lastCheckDir === dir) return;
  lastCheckDir = dir;
  lastCheckLoaded = true;
  lastCheckCorrupt = false;
  try {
    const raw = fs.readFileSync(lastCheckFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isLastCheck(parsed)) {
      lastCheck = parsed;
    } else {
      lastCheck = null;
      lastCheckCorrupt = true;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      lastCheck = null;
    } else {
      lastCheck = null;
      lastCheckCorrupt = true;
    }
  }
}

function setLastCheck(v: { at: number; result: UpdateCheckResult }): void {
  lastCheck = v;
  lastCheckCorrupt = false;
  lastCheckPersistError = null;
  try {
    const dir = lastCheckDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = lastCheckFilePath();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(v), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    lastCheckPersistError = e instanceof Error ? e.message : String(e);
  }
}

function currentVersion(): string {
  return readAppVersion(REPO_ROOT);
}

function config(): UpdateConfig {
  return getUpdateConfig(process.env);
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error('invalid feed URL'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('feed URL must be http(s)'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      u,
      { timeout: FETCH_TIMEOUT_MS, headers: { 'user-agent': 'AI-Factory-Update-Check' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`feed HTTP ${res.statusCode}`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes > MAX_FEED_BYTES) {
            res.destroy();
            reject(new Error('feed too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('feed fetch timeout'));
    });
    req.on('error', reject);
  });
}

/** Shared check used by the manual endpoint and the index.ts scheduler. */
export async function performUpdateCheck(ctx: {
  notify: RouteContext['notify'];
  audit: RouteContext['audit'];
}): Promise<UpdateCheckResult> {
  const cfg = config();
  // Only a *configured* URL goes through the egress firewall; an empty
  // feed URL short-circuits to not-configured inside runUpdateCheck.
  if (cfg.feedUrl) {
    const verdict = checkEgress(cfg.feedUrl, { source: 'update-check' });
    if (!verdict.allowed) {
      ctx.audit.record('system', 'UPDATE_CHECK_FAILED', 'update-feed', verdict.hostname ?? 'unknown', {
        reason: 'egress-blocked',
        detail: verdict.reason,
      });
      const result: UpdateCheckResult = { status: 'fetch-error', reason: 'egress-blocked' };
      setLastCheck({ at: Date.now(), result });
      return result;
    }
  }
  const result = await runUpdateCheck({
    config: cfg,
    currentVersion: currentVersion(),
    fetchText,
    notify: (e) =>
      ctx.notify.emit({
        type: e.type,
        actor: e.actor,
        entity: e.entity,
        detail: e.detail,
      }),
    audit: (action, details) => ctx.audit.record('system', action, 'app-update', 'channel', details),
  });
  setLastCheck({ at: Date.now(), result });
  return result;
}

function readChangelog(): { entries: ReturnType<typeof parseChangelog>; note: string | null } {
  try {
    const resolved = path.resolve(CHANGELOG_PATH);
    // Path jail: the changelog must stay inside the repo tree.
    if (resolved !== CHANGELOG_PATH || !resolved.startsWith(REPO_ROOT + path.sep)) {
      return { entries: [], note: 'path-jail' };
    }
    const text = fs.readFileSync(resolved, 'utf8');
    return { entries: parseChangelog(text, 30), note: null };
  } catch {
    return { entries: [], note: 'no-changelog' };
  }
}

export async function handleUpdateRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const pathName = url.pathname;
  if (pathName !== PREFIX && !pathName.startsWith(PREFIX + '/')) return false;

  // GET /api/updates/status
  if (method === 'GET' && pathName === `${PREFIX}/status`) {
    ensureLastCheckLoaded();
    const cfg = config();
    const feedHost = (() => {
      if (!cfg.feedUrl) return null;
      try {
        return new URL(cfg.feedUrl).hostname;
      } catch {
        return null;
      }
    })();
    return ctx.json(res, 200, {
      currentVersion: currentVersion(),
      feedConfigured: cfg.feedUrl.length > 0,
      feedHost,
      autoCheck: cfg.autoCheck,
      checkIntervalMs: cfg.checkIntervalMs,
      lastCheck,
      lastCheckCorrupt,
      lastCheckPersistError,
    }), true;
  }

  // POST /api/updates/check
  if (method === 'POST' && pathName === `${PREFIX}/check`) {
    const result = await performUpdateCheck(ctx);
    if (result.status === 'fetch-error' && result.reason === 'egress-blocked') {
      return ctx.json(res, 403, {
        error: 'update feed is blocked by the egress firewall',
        code: EGRESS_BLOCKED_CODE,
        result,
      }), true;
    }
    return ctx.json(res, 200, { result, lastCheck, lastCheckCorrupt, lastCheckPersistError }), true;
  }

  // GET /api/updates/changelog
  if (method === 'GET' && pathName === `${PREFIX}/changelog`) {
    const { entries, note } = readChangelog();
    return ctx.json(res, 200, { entries, note }), true;
  }

  return false;
}
