/**
 * Minimal Electron type shim for the prototype.
 * The real `electron` npm package (with its platform binary) is only needed
 * when actually launching/packaging the desktop shell:
 *   npm install -D electron   # then: npm run electron
 * This shim lets `electron/main.ts` typecheck without that heavy download.
 */
declare module 'electron' {
  export interface BrowserWindowOptions {
    width?: number;
    height?: number;
    title?: string;
    webPreferences?: { contextIsolation?: boolean; preload?: string };
  }
  export class BrowserWindow {
    constructor(opts?: BrowserWindowOptions);
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    static getAllWindows(): BrowserWindow[];
  }
  export interface App {
    whenReady(): Promise<void>;
    on(event: 'activate' | 'window-all-closed', cb: () => void): void;
    quit(): void;
  }
  export const app: App;
  export interface IpcMain {
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  }
  export const ipcMain: IpcMain;
  export interface IpcRenderer {
    send(channel: string, ...args: any[]): void;
  }
  export const ipcRenderer: IpcRenderer;
  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };
  export interface NotificationOptions {
    title: string;
    body?: string;
  }
  export class Notification {
    constructor(opts: NotificationOptions);
    show(): void;
  }
}

declare namespace NodeJS {
  interface Process {
    resourcesPath: string;
  }
}
