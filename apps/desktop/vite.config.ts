import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths: the packaged app loads the renderer via file://
  // (Electron loadFile), where absolute '/assets/...' URLs would not resolve.
  // The dev server serves the same relative base without change.
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  // Monaco (§65) ships its language services as web workers.
  worker: { format: 'es' },
  optimizeDeps: { include: ['monaco-editor'] },
});
