#!/usr/bin/env node
/**
 * Post-build boot smoke (F6, Batch 22-1).
 *
 * Why this exists: Batch 21's first-run walkthrough hit F6 — building only
 * some packages can leave `dist/` cross-package inconsistent (e.g. the
 * server's dist calling a function that the mcp package's dist does not
 * export yet), and the compiled server then crashes on boot with exit 1.
 * The root `npm test` gate never runs the server suite, so nothing caught
 * "the compiled artifact cannot boot". This smoke closes that hole:
 *
 *   1. boot the COMPILED server (apps/server/dist/index.js) — no ts-node,
 *      no type-stripping, the exact artifact that ships;
 *   2. poll GET /api/health until it returns 200 (60s deadline);
 *   3. any early process exit or timeout is a loud non-zero failure with
 *      the crash output on stderr.
 *
 * Run it AFTER `npm run build` (root). The boot is hermetic: temp DB_PATH
 * and temp FACTORY_SECRETS_DIR, so it never touches the developer's local
 * data/secrets/ vault (a stale ignored vault would fail-closed and poison
 * the smoke — same lesson as the Batch 21 walkthrough closeout).
 *
 * No auth tokens are set: the server binds loopback only in that state,
 * which is exactly what we want for a smoke.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverMain = join(root, 'apps', 'server', 'dist', 'index.js');

if (!existsSync(serverMain)) {
  console.error(
    `[boot-smoke] FAIL: compiled server not found at ${serverMain} — run \`npm run build\` (root) first`,
  );
  process.exit(1);
}

const port = 31_000 + Math.floor(Math.random() * 20_000);
const dir = mkdtempSync(join(tmpdir(), 'factory-boot-smoke-'));
const child = spawn(process.execPath, [serverMain], {
  cwd: join(root, 'apps', 'server'),
  env: {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dir, 'factory.db'),
    FACTORY_SECRETS_DIR: join(dir, 'secrets'),
  },
  stdio: 'inherit', // keep the crash stack loud on failure
});

let earlyExit = null;
child.on('exit', (code, signal) => {
  earlyExit = { code, signal };
});

const deadline = Date.now() + 60_000;
for (;;) {
  if (earlyExit) {
    console.error(
      `[boot-smoke] FAIL: server exited early (code=${earlyExit.code}, signal=${earlyExit.signal}) ` +
        `before /api/health ever returned 200 — see the crash output above`,
    );
    process.exit(1);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) break;
  } catch {
    // not up yet
  }
  if (Date.now() > deadline) {
    child.kill('SIGKILL');
    console.error('[boot-smoke] FAIL: /api/health never returned 200 within 60s');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

child.kill('SIGTERM');
await new Promise((r) => {
  child.on('exit', r);
  setTimeout(r, 5_000);
});
console.log('[boot-smoke] OK: compiled server booted, GET /api/health -> 200');
process.exit(0);
