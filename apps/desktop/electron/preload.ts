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
});
