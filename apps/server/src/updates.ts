/**
 * App update channel — deterministic core (R3-T1, electron-updater 式).
 *
 * Pure node builtins only (+ no relative imports at all): unit-testable
 * straight from src under node's type-stripping ESM loader (dual-mode
 * import rule in AGENTS.md). Zero model dependency; all decisions are
 * string/version comparisons.
 *
 * Responsibilities:
 *  - parse electron-builder generic-provider `latest.yml` feeds (fail-closed)
 *  - semver comparison (current vs feed)
 *  - update configuration from env (feed URL empty by default = no check)
 *  - CHANGELOG.md parsing for the changelog panel
 *  - orchestration of one check run with injected side effects
 *    (fetch / notify / audit) so tests run it with fakes
 *
 * What this module does NOT do (by design):
 *  - download or install anything (that's electron-updater in the Electron
 *    main process, behind an explicit user click)
 *  - silent automatic updates
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface UpdateFeedFile {
  url: string;
  sha512?: string;
  size?: number;
}

export interface UpdateFeed {
  version: string;
  path?: string;
  sha512?: string;
  releaseDate?: string;
  releaseNotes?: string;
  files: UpdateFeedFile[];
}

export interface UpdateConfig {
  /** Update feed URL (electron-builder latest.yml). Empty = not configured = no checks. */
  feedUrl: string;
  /** Periodic check interval, ms. */
  checkIntervalMs: number;
  /** Whether the in-process scheduler performs periodic checks. */
  autoCheck: boolean;
}

export interface ChangelogEntry {
  version: string;
  date: string | null;
  title: string | null;
  notes: string[];
}

export type UpdateCheckResult =
  | { status: 'not-configured' }
  | { status: 'up-to-date'; current: string; latest: string }
  | { status: 'update-available'; current: string; latest: string; feed: UpdateFeed }
  | { status: 'feed-error'; reason: string }
  | { status: 'fetch-error'; reason: string };

/** Minimal structural notification event; the route adapts it to the real engine. */
export interface UpdateNotifyEvent {
  type: 'UPDATE_AVAILABLE';
  actor: string;
  entity: { kind: string; id: string; label?: string };
  detail?: Record<string, unknown>;
}

export interface UpdateCheckDeps {
  config: UpdateConfig;
  currentVersion: string;
  fetchText: (url: string) => Promise<string>;
  notify: (event: UpdateNotifyEvent) => void;
  audit: (action: string, details: Record<string, unknown>) => void;
  now?: () => number;
}

export const DEFAULT_CHECK_INTERVAL_MS = 6 * 3600 * 1000;
export const MIN_CHECK_INTERVAL_MS = 60 * 1000;
export const MAX_FEED_BYTES = 1024 * 1024;

/* ---------------------------------------------------------- semver */

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  nums: [number, number, number];
  pre: string[];
}

/** Parse `X.Y.Z[-prerelease][+build]`; null when not a valid semver. */
export function parseSemver(v: string): ParsedVersion | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1; // numeric identifiers sort before alphanumeric
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two semver strings. Returns -1 / 0 / 1.
 * Unparseable inputs sort below any valid version (fail-closed direction:
 * an unknown current version never claims to be "newer").
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // release > prerelease
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // shorter prerelease = lower precedence
    if (y === undefined) return 1;
    const c = compareIdentifiers(x, y);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

/* ---------------------------------------------------------- feed parsing
 * Minimal line-based subset of the YAML electron-builder writes for the
 * generic provider (latest.yml). Deliberately strict: anything unexpected
 * fails closed to null rather than guessing.
 */

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse an electron-builder generic-provider feed. Returns null
 * (fail-closed) on empty text, missing/invalid version, or malformed input.
 */
export function parseUpdateFeed(text: string): UpdateFeed | null {
  if (!text || !text.trim()) return null;
  const feed: UpdateFeed = { version: '', files: [] };
  let currentFile: UpdateFeedFile | null = null;
  let inFiles = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (inFiles && trimmed.startsWith('- ')) {
      // `  - url: foo` — list item on one line; the inline key must be `url`
      // (electron-builder generic provider format). Anything else is malformed.
      const itemKv = trimmed.slice(2).match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!itemKv || itemKv[1] !== 'url') return null;
      currentFile = { url: unquote(itemKv[2]) };
      feed.files.push(currentFile);
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) return null; // not key: value — malformed
    const key = kv[1];
    const value = unquote(kv[2]);

    if (indent === 0) {
      inFiles = key === 'files';
      currentFile = null;
      if (key === 'files') continue;
      if (key === 'version') feed.version = value;
      else if (key === 'path') feed.path = value;
      else if (key === 'sha512') feed.sha512 = value;
      else if (key === 'releaseDate') feed.releaseDate = value;
      else if (key === 'releaseNotes') feed.releaseNotes = value;
      // unknown top-level keys are ignored (forward-compatible)
      continue;
    }
    if (!inFiles) continue; // nested under an unknown top-level key: ignore
    if (indent >= 2 && currentFile) {
      if (key === 'url') currentFile.url = value;
      else if (key === 'sha512') currentFile.sha512 = value;
      else if (key === 'size') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return null;
        currentFile.size = n;
      }
      continue;
    }
    return null; // unexpected nesting — malformed
  }

  if (!feed.version || !parseSemver(feed.version)) return null;
  for (const f of feed.files) {
    if (!f.url) return null;
  }
  return feed;
}

/* ---------------------------------------------------------- config */

export function getUpdateConfig(env: NodeJS.ProcessEnv = process.env): UpdateConfig {
  const feedUrl = (env['FACTORY_UPDATE_FEED_URL'] ?? '').trim();
  const rawInterval = Number(env['FACTORY_UPDATE_CHECK_INTERVAL_MS']);
  const checkIntervalMs =
    Number.isFinite(rawInterval) && rawInterval >= MIN_CHECK_INTERVAL_MS
      ? Math.floor(rawInterval)
      : DEFAULT_CHECK_INTERVAL_MS;
  return {
    feedUrl,
    checkIntervalMs,
    autoCheck: env['FACTORY_UPDATE_AUTO_CHECK'] !== 'false',
  };
}

/** Feed base URL for electron-updater's generic provider (feed URL minus filename). */
export function feedBaseUrl(feedUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(feedUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const idx = u.pathname.lastIndexOf('/');
  u.pathname = idx >= 0 ? u.pathname.slice(0, idx + 1) : '/';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/* ---------------------------------------------------------- changelog */

const CHANGELOG_HEAD_RE = /^##\s+\[?([0-9A-Za-z][0-9A-Za-z.\-]*)\]?(?:\s*\(([^)]*)\))?(?:\s*[—–\-]+\s*(.*))?\s*$/;

/**
 * Parse CHANGELOG.md (keep-a-changelog-ish `## [x.y.z] (date) — title`
 * headers, `- ` bullets). Unknown formats yield [] (fail-closed), never
 * invented entries.
 */
export function parseChangelog(text: string, limit = 30): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const head = CHANGELOG_HEAD_RE.exec(line.trim());
    if (head) {
      if (entries.length >= limit) break;
      current = { version: head[1], date: head[2]?.trim() || null, title: head[3]?.trim() || null, notes: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*-\s+(.*)$/.exec(line);
    if (bullet && bullet[1].trim()) {
      if (current.notes.length < 200) current.notes.push(bullet[1].trim().slice(0, 500));
    }
  }
  return entries;
}

/* ---------------------------------------------------------- app version */

export function readAppVersion(repoRoot: string): string {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === 'string' && parseSemver(v)) return v;
  } catch {
    /* fall through */
  }
  return '0.0.0';
}

/* ---------------------------------------------------------- orchestration */

/**
 * Run one update check. All side effects are injected; the function itself
 * is deterministic given (config, currentVersion, feedText).
 */
export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const { config, currentVersion, fetchText, notify, audit } = deps;
  const at = (deps.now ?? Date.now)();

  if (!config.feedUrl) {
    audit('UPDATE_CHECK_SKIPPED', { reason: 'feed-not-configured', at });
    return { status: 'not-configured' };
  }
  if (!parseSemver(currentVersion)) {
    audit('UPDATE_CHECK_FAILED', { reason: 'invalid-current-version', currentVersion, at });
    return { status: 'feed-error', reason: 'invalid-current-version' };
  }

  let text: string;
  try {
    text = await fetchText(config.feedUrl);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    audit('UPDATE_CHECK_FAILED', { reason: 'fetch-error', detail: reason.slice(0, 200), at });
    return { status: 'fetch-error', reason };
  }
  const feed = parseUpdateFeed(text);
  if (!feed) {
    audit('UPDATE_CHECK_FAILED', { reason: 'unparseable-feed', at });
    return { status: 'feed-error', reason: 'unparseable-feed' };
  }

  const cmp = compareVersions(currentVersion, feed.version);
  if (cmp < 0) {
    const result: UpdateCheckResult = {
      status: 'update-available',
      current: currentVersion,
      latest: feed.version,
      feed,
    };
    audit('UPDATE_AVAILABLE', {
      current: currentVersion,
      latest: feed.version,
      releaseDate: feed.releaseDate ?? null,
      at,
    });
    notify({
      type: 'UPDATE_AVAILABLE',
      actor: 'system',
      entity: { kind: 'app-update', id: feed.version, label: `AI Factory v${feed.version}` },
      detail: {
        current: currentVersion,
        latest: feed.version,
        releaseDate: feed.releaseDate ?? '',
        releaseNotes: (feed.releaseNotes ?? '').slice(0, 500),
      },
    });
    return result;
  }
  audit('UPDATE_CHECK_OK', { current: currentVersion, latest: feed.version, at });
  return { status: 'up-to-date', current: currentVersion, latest: feed.version };
}
