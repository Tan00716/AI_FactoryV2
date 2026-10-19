/**
 * Electron main process for the AI Engineering Factory IDE.
 * Loads the Vite dev server in development or the built renderer in
 * production. The local backend (apps/server) is spawned as a child process
 * so the desktop app is self-contained (local-first, §104).
 */
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

// Dev means: unpackaged AND not forced to production. A packaged app must
// take the production paths (bundled renderer + spawned backend) even though
// nothing sets NODE_ENV for a double-clicked executable. Unpackaged behavior
// is unchanged: NODE_ENV=production alone still selects production paths.
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
const API_PORT = Number(process.env.PORT ?? 3100);
const UI_PORT = Number(process.env.UI_PORT ?? 5173);

let backend: ChildProcess | null = null;

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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(API_PORT) },
    stdio: 'inherit',
  });
  backend.on('exit', (code) => console.log(`[main] backend exited with ${code}`));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'AI Factory — Engineering IDE',
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
    win.loadURL(`http://localhost:${UI_PORT}?apiPort=${API_PORT}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
      query: { apiPort: String(API_PORT) },
    });
  }
}

app.whenReady().then(() => {
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
  // In dev, `npm run dev` already starts the backend; only spawn it here
  // when this main process is launched standalone (e.g. packaged app).
  if (!isDev || process.env.SPAWN_BACKEND === '1') startBackend();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  backend?.kill();
  if (process.platform !== 'darwin') app.quit();
});
