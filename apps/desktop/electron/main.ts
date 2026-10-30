/**
 * Electron main process for the AI Engineering Factory IDE.
 * Loads the Vite dev server in development or the built renderer in
 * production. The local backend (apps/server) is spawned as a child process
 * so the desktop app is self-contained (local-first, §104).
 */
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Dev means: unpackaged AND not forced to production. A packaged app must
// take the production paths (bundled renderer + spawned backend) even though
// nothing sets NODE_ENV for a double-clicked executable. Unpackaged behavior
// is unchanged: NODE_ENV=production alone still selects production paths.
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
const API_PORT = Number(process.env.PORT ?? 3100);
const UI_PORT = Number(process.env.UI_PORT ?? 5173);

let backend: ChildProcess | null = null;

/** Feed base URL for electron-updater's generic provider (feed URL minus filename). */
function feedBaseUrl(feedUrl: string): string {
  const u = new URL(feedUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('update feed URL must be http(s)');
  }
  const i = u.pathname.lastIndexOf('/');
  u.pathname = i >= 0 ? u.pathname.slice(0, i + 1) : '/';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Minimal numeric version compare for the main-process second gate (x.y.z). */
function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split('.').map((x) => Number(x));
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false; // unparseable: fail closed
    if (x !== y) return x > y;
  }
  return false;
}

function startBackend(): void {
  const serverEntry = isDev
    ? path.join(__dirname, '..', '..', 'server', 'dist', 'index.js')
    : path.join(process.resourcesPath, 'server', 'index.js');
  backend = spawn(process.execPath, [serverEntry], {
    // ELECTRON_RUN_AS_NODE is load-bearing: a packaged Electron binary
    // ignores a script-path argument and would relaunch the whole app
    // (which spawns another "backend", ad infinitum). Run-as-node makes the
    // child execute serverEntry as plain Node, in dev and packaged builds
    // alike.
    //
    // V3-#1: the backend is never spawned unauthenticated anymore. The
    // per-install token file (0600, see ensureInstallToken) is injected
    // as FACTORY_API_TOKEN_FILE, so the server's fail-closed default
    // (no credential refuses to start) is satisfied by construction.
    // The renderer obtains the same token through the preload bridge
    // ('ai-factory:api-token'), never through the URL or localStorage.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(API_PORT),
      FACTORY_API_TOKEN_FILE: installTokenPath(),
    },
    stdio: 'inherit',
  });
  backend.on('exit', (code) => console.log(`[main] backend exited with ${code}`));
}

/**
 * V3-#1 per-install API token. Path: <userData>/api-token. Created once
 * (256-bit hex) with mode 0600; an existing file is reused and
 * re-tightened to 0600 on every launch. The value is never logged and
 * never leaves the main process except through the 'ai-factory:api-token'
 * IPC handler, which the renderer calls once at startup.
 */
function installTokenPath(): string {
  return path.join(app.getPath('userData'), 'api-token');
}

function ensureInstallToken(): string {
  const file = installTokenPath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort: a loose mode on an existing file is tightened when possible */
      }
      return existing;
    }
  } catch {
    /* missing or unreadable: fall through to creation */
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return token;
}

function createWindow(initialProject?: string): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // Window title follows the bound project; the renderer sets
    // document.title once it resolves the project name (see App.tsx),
    // and Electron mirrors page titles onto the native window.
    title: initialProject ? `AI Factory — ${initialProject}` : 'AI Factory — Engineering IDE',
    // Product icon, shipped in the packaged app via electron-builder.yml
    // `files` (apps/desktop/build/icon.png). Same relative layout in dev
    // (__dirname = apps/desktop/dist-electron) and packaged
    // (__dirname = <app>/apps/desktop/dist-electron).
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      // Preload bridge (preload.ts): exposes window.aiFactory.notify()
      // for OS-level desktop notifications; the renderer still talks to
      // the local HTTP API otherwise. Context isolation stays on (§71).
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  if (isDev) {
    const q = new URLSearchParams({ apiPort: String(API_PORT) });
    if (initialProject) q.set('project', initialProject);
    win.loadURL(`http://localhost:${UI_PORT}?${q.toString()}`);
  } else {
    const query: Record<string, string> = { apiPort: String(API_PORT) };
    if (initialProject) query['project'] = initialProject;
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query });
  }
}

app.whenReady().then(() => {
  // V3-#1: create the per-install token before anything spawns the
  // backend or loads a window, and serve it to the renderer on demand
  // (fresh read each call, so a server-side rotation is picked up
  // without relaunching the app). Never logged, never in the URL.
  ensureInstallToken();
  ipcMain.handle('ai-factory:api-token', () => {
    try {
      const token = fs.readFileSync(installTokenPath(), 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  });
  // OS desktop notifications from the renderer's notification center.
  // The console line doubles as a test hook (headless Xvfb has no
  // notification daemon, so "shown" can't be observed there).
  ipcMain.on('ai-factory:notify', (_event, payload: unknown) => {
    const p = (payload ?? {}) as { title?: unknown; body?: unknown };
    const title = String(p.title ?? 'AI Factory').slice(0, 120);
    const body = String(p.body ?? '').slice(0, 300);
    console.log(`[main] desktop notification: ${title}`);
    try {
      new Notification({ title, body }).show();
    } catch (e) {
      console.error('[main] Notification.show failed:', (e as Error).message);
    }
  });
  // Multi-project windows (§multi-project): every window binds its own
  // projectId via the ?project= query param. The backend is project-scoped
  // per request (no global current-project singleton), so all windows share
  // the ONE backend process — no extra servers, no port conflicts.
  ipcMain.on('ai-factory:open-window', (_event, payload: unknown) => {
    const p = (payload ?? {}) as { projectId?: unknown };
    const raw = typeof p.projectId === 'string' ? p.projectId : '';
    // Same allowlist as the renderer's project-query helper: fail closed.
    const projectId = /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : undefined;
    createWindow(projectId);
  });
  // R3-T1: app update download + install via electron-updater (generic
  // provider). Explicit user click only — never automatic, never silent.
  // The renderer already ran the server-side check; the main process
  // re-validates the feed config and re-compares versions as a second gate.
  ipcMain.handle('ai-factory:update-download', async () => {
    const feedUrl = (process.env.FACTORY_UPDATE_FEED_URL ?? '').trim();
    if (!feedUrl) throw new Error('update feed not configured (FACTORY_UPDATE_FEED_URL)');
    if (!app.isPackaged) {
      throw new Error('update download is only available in the packaged app, not in dev');
    }
    let autoUpdater: typeof import('electron-updater').autoUpdater;
    try {
      ({ autoUpdater } = await import('electron-updater'));
    } catch {
      throw new Error('electron-updater is not installed');
    }
    const base = feedBaseUrl(feedUrl); // throws on non-http(s)
    autoUpdater.autoDownload = false;
    autoUpdater.setFeedURL({ provider: 'generic', url: base });
    const check = await autoUpdater.checkForUpdates();
    const latest = check?.updateInfo?.version;
    if (!latest) throw new Error('update feed returned no version');
    console.log(`[main] update check: running=${app.getVersion()} latest=${latest}`);
    if (!isNewerVersion(latest, app.getVersion())) {
      return { downloaded: false, version: latest };
    }
    await autoUpdater.downloadUpdate();
    console.log(`[main] update downloaded: ${latest}`);
    return { downloaded: true, version: latest };
  });
  ipcMain.handle('ai-factory:update-quit-install', async () => {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
  // In dev, `npm run dev` already starts the backend; only spawn it here
  // when this main process is launched standalone (e.g. packaged app).
  if (!isDev || process.env.SPAWN_BACKEND === '1') startBackend();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** Kill the spawned backend if it is still alive. Safe to call twice:
 * an already-exited child is a no-op, and kill failures are swallowed
 * because quit-time cleanup must never block the app from exiting. */
function killBackend(): void {
  try {
    if (backend && backend.exitCode === null && !backend.killed) backend.kill();
  } catch {
    /* noop: backend already gone */
  }
}

app.on('window-all-closed', () => {
  killBackend();
  if (process.platform !== 'darwin') app.quit();
});

// Belt-and-braces (V3 closeout): window-all-closed covers the normal user
// path, but quit paths that bypass it (CDP Browser.close, verified
// 2026-10-30 to exit 0 while the backend survived) must not leak the
// backend either. before-quit runs on every app.quit() path and will-quit
// is the last synchronous hook before the process exits; on macOS neither
// fires for a mere window close (the app stays alive), so this does not
// change the darwin window lifecycle.
app.on('before-quit', killBackend);
app.on('will-quit', killBackend);
