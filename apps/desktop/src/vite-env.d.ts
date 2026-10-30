/// <reference types="vite/client" />

/** Preload bridge (apps/desktop/electron/preload.ts). Absent in plain browsers. */
interface AiFactoryBridge {
  notify: (title: string, body: string) => void;
  /** Multi-project: open a new window bound to the given projectId. */
  openWindow: (projectId: string) => void;
  /** R3-T1: download the pending app update (explicit user click only). */
  updateDownload: () => Promise<{ downloaded: boolean; version?: string }>;
  /** R3-T1: quit and install the downloaded update. */
  updateQuitAndInstall: () => Promise<{ ok: boolean }>;
  /** V3-#1: per-install API token from the main process (null outside Electron). */
  getApiToken?: () => Promise<string | null>;
}

interface Window {
  aiFactory?: AiFactoryBridge;
}