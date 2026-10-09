/**
 * `npm run dev` launcher: builds are done by the npm script first, then this
 * spawns the local API backend and the Vite dev server side by side.
 * Ctrl+C stops both.
 */
import { spawn } from 'child_process';

const root = new URL('..', import.meta.url).pathname;

const backend = spawn('node', ['apps/server/dist/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: '3100', DB_PATH: './data/factory.db' },
  stdio: 'inherit',
});

const ui = spawn(
  'node',
  ['../../node_modules/vite/bin/vite.js', '--port', '5173'],
  {
    cwd: root + 'apps/desktop',
    stdio: 'inherit',
  },
);

function shutdown() {
  backend.kill();
  ui.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

backend.on('exit', (c) => console.log(`[dev] backend exited (${c})`));
ui.on('exit', (c) => console.log(`[dev] vite exited (${c})`));

console.log('[dev] backend → http://localhost:3100');
console.log('[dev] ui      → http://localhost:5173');
