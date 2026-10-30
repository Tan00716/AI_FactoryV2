/**
 * Electron preload bridge for the AI Factory desktop shell.
 *
 * Exposes a minimal, purpose-built API to the renderer (context
 * isolation stays on). Currently: OS-level desktop notifications —
 * the notification center calls window.aiFactory.notify() when new
 * notifications arrive so the human is pinged even when the app is
 * in the background. The main process shows them via Electron's
 * Notification API (works in the packaged app too).
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aiFactory', {
  notify: (title: string, body: string): void => {
    ipcRenderer.send('ai-factory:notify', { title, body });
  },
  // Multi-project: open a new window bound to a projectId. The new
  // window shares the single backend process; only its ?project=
  // query param differs.
  openWindow: (projectId: string): void => {
    ipcRenderer.send('ai-factory:open-window', { projectId });
  },
  // R3-T1: app update download + install (explicit user click only).
  // Resolves/rejects with the main-process errors (feed not configured,
  // dev mode, electron-updater missing) — the Updates tab shows them.
  updateDownload: (): Promise<{ downloaded: boolean; version?: string }> =>
    ipcRenderer.invoke('ai-factory:update-download'),
  updateQuitAndInstall: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ai-factory:update-quit-install'),
  // V3-#1: the per-install API token, served by the main process from
  // the 0600 token file. The renderer calls this once at startup and
  // keeps the token in memory only (never localStorage, never the URL).
  // Absent in plain browsers (vite dev), where the localStorage token
  // fallback in api.ts still applies.
  getApiToken: (): Promise<string | null> => ipcRenderer.invoke('ai-factory:api-token'),
});
