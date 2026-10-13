/**
 * Browser profile isolation — SPEC v2 §33.
 *
 * The only normative sentence on this (SPEC v2 §33): "Browser 在隔离
 * Profile/Host 中运行，下载目录受边界控制；网站文本不成为指令。"
 * ("Browser runs in an isolated Profile/Host; the download directory is
 * boundary-controlled; website text does not become instructions.")
 *
 * This module ships the ISOLATED PROFILE half plus the bounded download
 * directory half, as real on-disk isolation:
 *
 *  - Every profile carries an independent identity (uuid + name) and owns
 *    an INDEPENDENT user-data directory on this machine
 *    (`<root>/browser-profiles/<name>-<id8>/user-data`). Two profiles never
 *    share a user-data dir — no shared cookies/storage between profiles.
 *  - Every profile owns a bounded download directory
 *    (`<root>/browser-profiles/<name>-<id8>/downloads`). Files can only be
 *    placed under it via `resolveDownloadPath`, which rejects bare names
 *    that would escape (absolute paths, `..`, separators) — the download
 *    directory is boundary-controlled, not just a suggestion.
 *  - Profile lifecycle is explicit: create → destroy, plus orphan cleanup.
 *    Every lifecycle step emits an audit intent through the injected sink.
 *  - No browser driver ships with this package (and none exists in this
 *    repo), so `driverAvailability()` honestly reports
 *    `available: false`; `browser.open` stays definition-only. Profiles are
 *    storage/isolation only — a future host-injected driver reads
 *    `userDataDirFor(name)` / `resolveDownloadPath(name, file)` and launches
 *    the browser with the profile's directory.
 *
 * Honest boundaries (also stated in the browser.open builtin gap note):
 *  - This is DIRECTORY isolation on one machine (separate user-data dirs),
 *    NOT OS sandboxing / container / VM isolation. A real browser process
 *    launched against a profile dir can still do everything its OS user can.
 *    The "Host" half of SPEC's "isolated Profile/Host" is not built here.
 *  - "Website text does not become instructions" is a consumption-layer
 *    (prompt-injection) rule that applies where fetched website text is
 *    handed to a model — no fetcher exists yet, so there is nothing to
 *    mark TODAY. The contract the future fetcher must honor already ships
 *    in ./fetched-content.ts: every fetch must emit its text via
 *    markUntrusted() with FetchedProvenance (url/fetchedAt/profile
 *    identity), and prompt assemblers must route external text through
 *    assertQuarantined()/renderQuarantined() before adapter.invoke.
 *  - Registry metadata is in-memory; profile directories survive restarts.
 *    Unknown-but-valid profile dirs under the root are treated as orphans
 *    by `cleanupOrphanedProfiles` (deleted + audited), never silently
 *    adopted — adoption without provenance would fabricate identity.
 *  - Cleanup never deletes directories that do not match the profile
 *    naming pattern (`<name>-<id8>`); retention's "never deletes blind"
 *    rule applies here too.
 */

import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A registered browser profile — independent identity, independent dirs. */
export interface BrowserProfileDescriptor {
  /** Stable unique id (uuid). */
  id: string;
  /** Operator-chosen name. Unique within the registry. */
  name: string;
  /**
   * The profile's OWN user-data directory. A browser driver launches with
   * this as --user-data-dir; nothing outside this directory is the
   * profile's storage.
   */
  userDataDir: string;
  /** Bounded download directory — downloads resolve only under here. */
  downloadDir: string;
  /** ISO timestamp of creation (injected clock for tests). */
  createdAt: string;
}

export interface CreateBrowserProfileInput {
  name: string;
}

/** Audit intents emitted by the registry. */
export type BrowserAuditIntentType =
  | 'BROWSER_PROFILE_CREATED'
  | 'BROWSER_PROFILE_DESTROYED'
  | 'BROWSER_PROFILE_ORPHAN_CLEANED';

export interface BrowserAuditIntent {
  type: BrowserAuditIntentType;
  /** ISO timestamp. */
  at: string;
  profileName: string;
  profileId?: string;
  /** Machine-readable detail; never carries secret values. */
  detail?: string;
}

/** Where audit intents go — injected by the host, like every other sink in this codebase. */
export type BrowserAuditSink = (intent: BrowserAuditIntent) => void;

export interface BrowserProfileRegistryOptions {
  /**
   * Directory under which `browser-profiles/` lives. Defaults to
   * `<cwd>/data/browser-profiles`. Tests inject a tmp dir.
   */
  profileRoot?: string;
  now?: () => number;
  auditSink?: BrowserAuditSink;
}

/** Driver availability — no driver ships; this is the honest marker. */
export interface BrowserDriverAvailability {
  available: false;
  reason: string;
}

const PROFILE_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{8}$/;

function isoNow(now?: () => number): string {
  return new Date(now ? now() : Date.now()).toISOString();
}

function validProfileName(name: string): boolean {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

function copyProfile(d: BrowserProfileDescriptor): BrowserProfileDescriptor {
  return { ...d };
}

/**
 * Registry of isolated browser profiles. Storage-agnostic in memory;
 * the profile DIRECTORIES are real (node:fs), because directory isolation
 * is the whole point — descriptors alone would be a re-labeling of nothing.
 */
export class BrowserProfileRegistry {
  private readonly root: string;
  private readonly profiles = new Map<string, BrowserProfileDescriptor>();
  private readonly now?: () => number;
  private readonly auditSink?: BrowserAuditSink;

  constructor(opts: BrowserProfileRegistryOptions = {}) {
    this.root = resolve(opts.profileRoot ?? join(process.cwd(), 'data', 'browser-profiles'));
    this.now = opts.now;
    this.auditSink = opts.auditSink;
  }

  private emit(intent: Omit<BrowserAuditIntent, 'at'>): void {
    this.auditSink?.({ ...intent, at: isoNow(this.now) });
  }

  /** Absolute directory holding all `browser-profiles/<name>-<id8>` dirs. */
  get profilesRoot(): string {
    return join(this.root, 'browser-profiles');
  }

  private profileDirName(name: string, id: string): string {
    return `${name}-${id.replace(/-/g, '').slice(0, 8)}`;
  }

  /**
   * Create a profile: independent identity + its own user-data and
   * downloads directories on disk. Name must be unique in this registry.
   * Throws on invalid or duplicate names — profiles are never silently
   * aliased to an existing one.
   */
  createProfile(input: CreateBrowserProfileInput): BrowserProfileDescriptor {
    const { name } = input;
    if (!validProfileName(name)) {
      throw new Error(
        `invalid profile name ${JSON.stringify(name)}; expected 1-64 chars of [A-Za-z0-9_-] starting with an alphanumeric (no paths, no separators)`,
      );
    }
    if (this.profiles.has(name)) {
      throw new Error(`browser profile "${name}" already exists — destroy it first or pick another name`);
    }
    const id = randomUUID();
    const dir = join(this.profilesRoot, this.profileDirName(name, id));
    const userDataDir = join(dir, 'user-data');
    const downloadDir = join(dir, 'downloads');
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(downloadDir, { recursive: true });
    const descriptor: BrowserProfileDescriptor = {
      id,
      name,
      userDataDir,
      downloadDir,
      createdAt: isoNow(this.now),
    };
    this.profiles.set(name, descriptor);
    this.emit({
      type: 'BROWSER_PROFILE_CREATED',
      profileName: name,
      profileId: id,
      detail: `user-data dir created at ${userDataDir}`,
    });
    return copyProfile(descriptor);
  }

  /**
   * Destroy a profile: recursively delete its whole directory (user-data +
   * downloads — the profile's cookies/storage are really gone, not
   * unlinked in memory) and drop the registration. Returns false when the
   * name was never registered.
   */
  destroyProfile(name: string): boolean {
    const descriptor = this.profiles.get(name);
    if (!descriptor) return false;
    rmSync(join(this.profilesRoot, this.profileDirName(name, descriptor.id)), {
      recursive: true,
      force: true,
    });
    this.profiles.delete(name);
    this.emit({
      type: 'BROWSER_PROFILE_DESTROYED',
      profileName: name,
      profileId: descriptor.id,
      detail: 'profile directory deleted from disk',
    });
    return true;
  }

  getProfile(name: string): BrowserProfileDescriptor | undefined {
    const d = this.profiles.get(name);
    return d ? copyProfile(d) : undefined;
  }

  listProfiles(): BrowserProfileDescriptor[] {
    return [...this.profiles.values()].map(copyProfile);
  }

  /**
   * The directory a browser driver must launch with for this profile
   * (e.g. Chromium's --user-data-dir). Fail-closed: unknown names throw,
   * we never invent a directory for a profile that isn't registered.
   */
  userDataDirFor(name: string): string {
    const descriptor = this.profiles.get(name);
    if (!descriptor) {
      throw new Error(
        `unknown browser profile "${name}" — profiles must be created first; refusing to guess a user-data directory`,
      );
    }
    return descriptor.userDataDir;
  }

  /**
   * Boundary-controlled download resolution: `fileName` must be a bare
   * file name (no separators, no `..`, not absolute, not empty). Returns
   * the absolute path under the profile's downloads dir. Any escape
   * attempt throws — downloads can never be redirected outside the
   * profile's bounded directory.
   */
  resolveDownloadPath(name: string, fileName: string): string {
    const descriptor = this.profiles.get(name);
    if (!descriptor) {
      throw new Error(`unknown browser profile "${name}" — cannot resolve a download path`);
    }
    if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 255) {
      throw new Error('download file name must be a non-empty string of at most 255 chars');
    }
    if (fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
      throw new Error(
        `download file name ${JSON.stringify(fileName)} would escape the profile's download directory — rejected`,
      );
    }
    return join(descriptor.downloadDir, fileName);
  }

  /**
   * Delete profile directories under the root that match the naming
   * pattern but are NOT registered in this registry (e.g. left behind by a
   * killed process). Returns the cleaned profile dir basenames. Directories
   * that do not match the pattern are never touched.
   */
  cleanupOrphanedProfiles(): string[] {
    const cleaned: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.profilesRoot);
    } catch {
      return cleaned; // no root yet — nothing to clean
    }
    const activeDirs = new Set(
      [...this.profiles.values()].map((d) => this.profileDirName(d.name, d.id)),
    );
    for (const entry of entries) {
      if (!PROFILE_DIR_RE.test(entry)) continue; // never delete blind
      if (activeDirs.has(entry)) continue;
      const full = join(this.profilesRoot, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      rmSync(full, { recursive: true, force: true });
      cleaned.push(entry);
      this.emit({
        type: 'BROWSER_PROFILE_ORPHAN_CLEANED',
        profileName: entry,
        detail: 'unregistered profile directory deleted from disk',
      });
    }
    return cleaned;
  }

  /**
   * No browser driver ships with this package (and none exists in this
   * repo). Profiles are storage/isolation only — a future host-injected
   * driver reads `userDataDirFor` / `resolveDownloadPath` and launches
   * against them. `browser.open` stays definition-only until then.
   */
  driverAvailability(): BrowserDriverAvailability {
    return {
      available: false,
      reason:
        'no browser driver ships with @ai-factory/tools or this repo — profiles are storage/isolation only; ' +
        'a host-injected driver must consume userDataDirFor/resolveDownloadPath',
    };
  }
}
