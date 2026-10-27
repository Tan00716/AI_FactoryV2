/**
 * Directory-tree watcher (R6-S3, server-side only — node:fs, never
 * imported by the desktop bundle). Walks the project root once, puts one
 * fs.watch on every directory, and follows directory creation/deletion:
 * a new directory gets a watcher, a deleted one loses its watcher.
 *
 * Fail-closed limits: more than MAX_WATCHED_DIRS directories refuses the
 * start (the rule reports status 'limit', nothing is half-watched).
 * Symlinked directories are never followed (a symlink loop would watch
 * forever). Hidden bookkeeping directories (.git, .ai-factory, node_modules
 * when the caller passes the default ignore) are skipped via the injected
 * shouldIgnore predicate — the route injects the two-tier ignore gate.
 *
 * close() is idempotent and closes every handle: no zombie watchers
 * survive a rule disable or a server shutdown path that calls it.
 */
import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MAX_WATCHED_DIRS, type WatchChangeKind } from './types';
import { toPosixPath } from './glob';

export interface TreeWatcherOptions {
  root: string;
  /** Absolute path, true when the entry must be skipped. */
  shouldIgnore?: (abs: string, isDir: boolean) => boolean;
  onEvent: (relPosix: string, kind: WatchChangeKind) => void;
  onError?: (error: Error) => void;
}

export class TreeWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;

  constructor(private readonly opts: TreeWatcherOptions) {}

  /** Walk + watch. Throws on the directory cap (nothing left watched). */
  start(): void {
    const dirs: string[] = [this.opts.root];
    const seen = new Set<string>();
    let i = 0;
    while (i < dirs.length) {
      const dir = dirs[i++];
      if (seen.has(dir)) continue;
      seen.add(dir);
      let entries: string[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
      } catch {
        continue; // Unreadable directory: skip, do not fail the whole tree.
      }
      for (const name of entries) {
        const abs = join(dir, name);
        let isDir = false;
        try {
          const st = statSync(abs);
          isDir = st.isDirectory();
        } catch {
          continue; // Vanished mid-walk: skip.
        }
        if (this.opts.shouldIgnore?.(abs, isDir)) continue;
        if (isDir) dirs.push(abs);
      }
    }
    if (seen.size > MAX_WATCHED_DIRS) {
      throw new Error(`watch directory limit exceeded: ${seen.size} directories (cap ${MAX_WATCHED_DIRS})`);
    }
    for (const dir of seen) this.watchDir(dir);
  }

  private watchDir(dir: string): void {
    if (this.closed || this.watchers.has(dir)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (eventType, filename) => {
        if (this.closed || typeof filename !== 'string' || filename.length === 0) return;
        const abs = join(dir, filename);
        const rel = toPosixPath(relative(this.opts.root, abs));
        if (eventType === 'rename') {
          // Rename = create or delete; stat distinguishes, and a new
          // directory must gain its own watcher.
          let isDir = false;
          let exists = true;
          try {
            isDir = statSync(abs).isDirectory();
          } catch {
            exists = false;
          }
          if (!exists) {
            this.unwatchDir(abs);
            this.opts.onEvent(rel, 'delete');
            return;
          }
          if (isDir) this.watchDir(abs);
          this.opts.onEvent(rel, 'create');
          return;
        }
        this.opts.onEvent(rel, 'change');
      });
    } catch (e) {
      this.opts.onError?.(e as Error);
      return;
    }
    watcher.on('error', (e) => this.opts.onError?.(e as Error));
    this.watchers.set(dir, watcher);
  }

  private unwatchDir(abs: string): void {
    const w = this.watchers.get(abs);
    if (w) {
      try {
        w.close();
      } catch {
        // Already closed: ignore.
      }
      this.watchers.delete(abs);
    }
    // Children of a deleted directory are gone too.
    for (const dir of [...this.watchers.keys()]) {
      if (dir.startsWith(abs + sep)) {
        try {
          this.watchers.get(dir)?.close();
        } catch {
          // Ignore.
        }
        this.watchers.delete(dir);
      }
    }
  }

  watchedDirCount(): number {
    return this.watchers.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        // Ignore.
      }
    }
    this.watchers.clear();
  }
}
