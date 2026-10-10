import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Monaco (§65) ships its language services as web workers.
  worker: { format: 'es' },
  optimizeDeps: { include: ['monaco-editor'] },
});
