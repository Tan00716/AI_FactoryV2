#!/usr/bin/env node
/**
 * Desktop regression suite (H1 test infra): `npm run test:desktop`.
 *
 * Brings up a hermetic stack — real server (isolated PORT/DB/secrets) +
 * vite dev + Xvfb + real Electron — then runs the CDP e2e cases in
 * apps/desktop/tests/e2e/cases/*.cjs, plus the pure unit tests first.
 *
 * Any case failure => non-zero exit with the failing case named.
 * Env overrides: DT_PORT, DT_UI_PORT, DT_CDP_PORT, DT_DISPLAY.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.DT_PORT || 32121);
const UI_PORT = Number(process.env.DT_UI_PORT || 5182);
const CDP_PORT = Number(process.env.DT_CDP_PORT || 19231);
const DISPLAY = process.env.DT_DISPLAY || ':99';

const procs = [];
let tmpRoot = null;

function log(...a) { console.log('[test:desktop]', ...a); }

async function portInUse(port) {
  for (const host of ['127.0.0.1', 'localhost']) {
    try {
      const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1500) });
      await res.body?.cancel?.().catch(() => {});
      return true;
    } catch { /* try next host */ }
  }
  return false;
}

async function waitForHttp(urls, timeoutMs, label) {
  const list = Array.isArray(urls) ? urls : [urls];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const url of list) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        await res.body?.cancel?.().catch(() => {});
        if (res.ok || res.status < 500) return;
      } catch { /* try next candidate */ }
    }
    if (Date.now() > deadline) throw new Error(`${label} not ready: ${list.join(' / ')}`);
    await sleep(1000);
  }
}

function startProc(name, cmd, args, opts) {
  // detached:true => own process group, so killAll can SIGKILL the whole tree
  // (npx/sh -c wrappers otherwise orphan their real child, as seen with vite).
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  p.on('error', (e) => log(`${name} spawn error: ${e.message}`));
  procs.push({ name, p });
  log(`${name} started (pid ${p.pid})`);
  return p;
}

/** Precise kill by recorded PID only — never pkill -f (it matches our own shell). */
async function killAll() {
  for (const { name, p } of procs.reverse()) {
    try {
      if (p.exitCode === null) {
        try { process.kill(-p.pid, 'SIGKILL'); } catch { process.kill(p.pid, 'SIGKILL'); }
        log(`${name} (pid ${p.pid}, group) killed`);
      }
    } catch { /* already gone */ }
  }
  procs.length = 0;
}

async function cleanup(exitCode) {
  await killAll();
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(exitCode);
}
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

// ---------- preconditions ----------
for (const f of ['apps/desktop/dist/index.html', 'apps/server/dist/index.js', 'apps/desktop/dist-electron/main.js']) {
  if (!existsSync(join(repoRoot, f))) {
    console.error(`[test:desktop] missing build artifact: ${f}\nRun \`npm run build\` first, then retry.`);
    process.exit(2);
  }
}
for (const [port, label] of [[PORT, 'server'], [UI_PORT, 'vite'], [CDP_PORT, 'CDP']]) {
  if (await portInUse(port)) {
    console.error(`[test:desktop] port ${port} (${label}) already in use. Set DT_PORT/DT_UI_PORT/DT_CDP_PORT to free ports.`);
    process.exit(2);
  }
}

// ---------- phase 1: pure unit tests ----------
log('phase 1: unit tests');
{
  const unitDir = join(repoRoot, 'apps', 'desktop', 'tests', 'unit');
  const unitFiles = readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => join('apps', 'desktop', 'tests', 'unit', f));
  if (unitFiles.length === 0) throw new Error('no unit test files found');
  log(`unit files: ${unitFiles.join(', ')}`);
  const r = spawnSync('node', ['--test', ...unitFiles],
    { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[test:desktop] unit tests FAILED — skipping e2e');
    process.exit(1);
  }
}

// ---------- phase 2: hermetic stack ----------
log('phase 2: starting stack');
tmpRoot = mkdtempSync(join(homedir(), 'test-desktop-'));
const dbPath = join(tmpRoot, 'db', 'factory.db');
const secretsDir = join(tmpRoot, 'secrets');
mkdirSync(join(tmpRoot, 'db'), { recursive: true });
mkdirSync(secretsDir, { recursive: true });
const shotsDir = join(tmpRoot, 'shots');
mkdirSync(shotsDir, { recursive: true });

let serverProc = null;
async function startServer() {
  serverProc = startProc('server', 'node', [join(repoRoot, 'apps/server/dist/index.js')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, FACTORY_SECRETS_DIR: secretsDir },
  });
  await waitForHttp(`http://127.0.0.1:${PORT}/api/health`, 30000, 'server');
  log('server healthy');
}
async function killServer() {
  if (serverProc && serverProc.exitCode === null) {
    try { process.kill(-serverProc.pid, 'SIGKILL'); } catch { try { process.kill(serverProc.pid, 'SIGKILL'); } catch { /* gone */ } }
    const i = procs.findIndex((x) => x.p === serverProc);
    if (i >= 0) procs.splice(i, 1);
    log(`server (pid ${serverProc.pid}) killed`);
    serverProc = null;
  }
  await sleep(1500);
}

try {
  await startServer();
  startProc('vite', 'npx', ['vite', '--port', String(UI_PORT), '--strictPort'], { cwd: join(repoRoot, 'apps/desktop') });
  // NOTE: vite dev binds [::1] only on this machine — probe localhost (resolves ::1) as well.
  await waitForHttp([`http://localhost:${UI_PORT}/`, `http://[::1]:${UI_PORT}/`], 60000, 'vite');
  startProc('Xvfb', 'Xvfb', [DISPLAY, '-screen', '0', '1600x900x24'], {});
  await sleep(2500);
  const electronBin = join(repoRoot, 'node_modules/electron/dist/electron');
  const env = { ...process.env, DISPLAY, PORT: String(PORT), UI_PORT: String(UI_PORT) };
  delete env.ELECTRON_RUN_AS_NODE; // set (even =0) => electron runs as plain node
  startProc('electron', electronBin, [join(repoRoot, 'apps/desktop/dist-electron/main.js'), '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], { cwd: repoRoot, env });
  log('stack up; running cases');

  // ---------- phase 3: cases ----------
  const caseDir = join(repoRoot, 'apps/desktop/tests/e2e/cases');
  const files = readdirSync(caseDir).filter((f) => f.endsWith('.cjs')).sort();
  const ctx = {
    cdpPort: CDP_PORT, uiPort: UI_PORT, repoRoot, shotsDir, sleep, log,
    killServer, startServer,
  };
  const results = [];
  for (const f of files) {
    const mod = (await import(join(caseDir, f))).default;
    const name = mod.name || f;
    const timeout = mod.timeout || 60000;
    log(`case: ${name} (timeout ${timeout}ms)`);
    const t0 = Date.now();
    try {
      const r = await Promise.race([
        mod.run(ctx),
        sleep(timeout).then(() => { throw new Error(`case timeout after ${timeout}ms`); }),
      ]);
      results.push({ name, pass: !!r.pass, detail: r.detail || '', ms: Date.now() - t0 });
    } catch (e) {
      results.push({ name, pass: false, detail: `threw: ${e.message}`, ms: Date.now() - t0 });
    }
    log(`  -> ${results[results.length - 1].pass ? 'PASS' : 'FAIL'} (${results[results.length - 1].ms}ms) ${results[results.length - 1].detail}`);
  }

  console.log('\n===== test:desktop summary =====');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms}ms)  ${r.detail}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} cases passed`);
  await cleanup(failed.length ? 1 : 0);
} catch (e) {
  console.error('[test:desktop] FATAL:', e.message);
  await cleanup(1);
}
