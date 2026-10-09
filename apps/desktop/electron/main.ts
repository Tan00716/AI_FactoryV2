/**
 * Electron main process for the AI Engineering Factory IDE.
 * Loads the Vite dev server in development or the built renderer in
 * production. The local backend (apps/server) is spawned as a child process
 * so the desktop app is self-contained (local-first, §104).
 */
import { app, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

const isDev = process.env.NODE_ENV !== 'production';
const API_PORT = Number(process.env.PORT ?? 3100);
const UI_PORT = Number(process.env.UI_PORT ?? 5173);

let backend: ChildProcess | null = null;

function startBackend(): void {
  const serverEntry = isDev
    ? path.join(__dirname, '..', '..', 'server', 'dist', 'index.js')
    : path.join(process.resourcesPath, 'server', 'index.js');
  backend = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(API_PORT) },
    stdio: 'inherit',
  });
  backend.on('exit', (code) => console.log(`[main] backend exited with ${code}`));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'AI Factory — Engineering IDE',
    webPreferences: {
      // Prototype: no preload/IPC bridge yet; renderer talks to the local
      // HTTP API. A preload bridge is the planned hardening (§71).
      contextIsolation: true,
    },
  });

  if (isDev) {
    win.loadURL(`http://localhost:${UI_PORT}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

app.whenReady().then(() => {
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
