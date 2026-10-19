/// <reference types="vite/client" />

/** Preload bridge (apps/desktop/electron/preload.ts). Absent in plain browsers. */
interface AiFactoryBridge {
  notify: (title: string, body: string) => void;
  /** Multi-project: open a new window bound to the given projectId. */
  openWindow: (projectId: string) => void;
}

interface Window {
  aiFactory?: AiFactoryBridge;
}