#!/usr/bin/env node
/**
 * Packaged-product smoke (V3 audit #2, P0-2 verification part).
 *
 * Why this exists: every earlier verification ran the DEV stack (vite dev
 * server + ts-node-ish server dist + Xvfb Electron pointed at main.js).
 * Nothing ever asserted that the ELECTRON-BUILDER PRODUCT — the thing a
 * user double-clicks — boots, serves its backend, and renders. Batch 60
 * already caught a launch race in dev mode; a packaged-only race would
 * have sailed through. This script closes that hole.
 *
 * Target: an electron-builder unpacked directory (release/linux-unpacked
 * from `electron-builder --linux --dir`) or an AppImage (extracted first
 * with --appimage-extract). It NEVER claims a Windows/macOS result: those
 * platforms get NOT_RUN entries from scripts/cross-platform-check.mjs.
 *
 * Checks (each PASS / FAIL / SKIP, JSON out):
 *   layout-binary / layout-asar / layout-server / layout-packages
 *   launch (process stays up under Xvfb)
 *   health (GET /api/health 200, ok:true)
 *   stats (GET /api/stats 200, when the route exists)
 *   projects (GET /api/projects 200, list shape)
 *   sandbox-probe (bwrap probe result reported, never asserted available:
 *     this VM has no bwrap, so unavailable + audited degrade is EXPECTED)
 *   window (CDP: file:// page, title non-empty, >=20 center tabs,
 *     main content non-empty, 0 page errors observed)
 *   one-backend (exactly one backend child of the app process)
 *   quit (SIGTERM -> clean exit, no backend left behind)
 *
 * Hermeticity: temp home under $HOME (never /tmp — 512MB tmpfs), isolated
 * PORT / DB_PATH / FACTORY_SECRETS_DIR / CDP port, cwd = temp dir, and
 * HOME = temp dir too, so the packaged app's userData (V3-#1 per-install
 * token) lands in temp — never in the real ~/.config. The smoke reads
 * that token back and uses it for authenticated API checks (V3-#1 made
 * every /api route except /api/health require it).
 * ELECTRON_RUN_AS_NODE is deleted (set, even =0, makes electron run as
 * plain node). Root runs need --no-sandbox (smoke-only flag, documented).
 * Quit uses the USER path (CDP window.close) — see cdpWindowClose note.
 *
 * Usage:
 *   node scripts/packaged-smoke.mjs --dir release/linux-unpacked
 *   node scripts/packaged-smoke.mjs --appimage "release/AI Factory-0.2.0.AppImage"
 *   node scripts/packaged-smoke.mjs --dir <dir> --out <json> --display :99
 *
 * Exit 0 only when every non-SKIP check passes.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync, statSync, readdirSync, mkdirSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pure layout contract for an electron-builder linux-unpacked dir. */
export function checkPackagedLayout(dir) {
  const checks = [];
  const binary = join(dir, 'ai-factory');
  checks.push({
    id: 'layout-binary',
    pass: existsSync(binary) && (statSync(binary).mode & 0o111) !== 0,
    detail: existsSync(binary) ? 'ai-factory executable present' : 'missing ai-factory binary',
  });
  const asar = join(dir, 'resources', 'app.asar');
  const asarOk = existsSync(asar) && statSync(asar).size > 1024 * 1024;
  checks.push({
    id: 'layout-asar',
    pass: asarOk,
    detail: existsSync(asar) ? `app.asar ${statSync(asar).size} bytes` : 'missing resources/app.asar',
  });
  const serverEntry = join(dir, 'resources', 'server', 'index.js');
  checks.push({
    id: 'layout-server',
    pass: existsSync(serverEntry),
    detail: existsSync(serverEntry) ? 'resources/server/index.js present' : 'missing packaged backend entry',
  });
  const pkgDir = join(dir, 'resources', 'server', 'node_modules', '@ai-factory');
  let pkgCount = 0;
  try { pkgCount = readdirSync(pkgDir).length; } catch { /* absent */ }
  checks.push({
    id: 'layout-packages',
    pass: pkgCount >= 40,
    detail: `@ai-factory staged packages: ${pkgCount} (need >= 40)`,
  });
  return checks;
}

function parseArgs(argv) {
  const out = { dir: null, appimage: null, out: null, display: ':99' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--appimage') out.appimage = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--display') out.display = argv[++i];
  }
  return out;
}

/** Ancestor chain of this process (self + parents), for /proc scans. */
function ancestorPids() {
  const set = new Set([process.pid]);
  try {
    let pid = process.pid;
    for (let i = 0; i < 64; i++) {
      const stat = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      const ppid = Number(stat);
      if (!Number.isFinite(ppid) || ppid <= 0 || set.has(ppid)) break;
      set.add(ppid);
      pid = ppid;
    }
  } catch { /* best effort */ }
  return set;
}

/** PIDs whose cmdline mentions the packaged backend entry, minus ancestors. */
function findBackendPids(unpackedDir) {
  const skip = ancestorPids();
  const found = [];
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  } catch { return found; }
  for (const pid of pids) {
    if (skip.has(pid)) continue;
    try {
      const cmd = execFileSync('cat', [`/proc/${pid}/cmdline`], { encoding: 'utf8' });
      // Backend child cmdline = packaged electron binary + server/index.js
      // as an argument. The app process itself never carries that string.
      if (cmd.includes('server/index.js')) found.push(pid);
    } catch { /* vanished */ }
  }
  return found;
}

async function pollHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      const body = await res.json();
      if (res.status === 200 && body.ok === true) return { ok: true, body };
      last = `status ${res.status}`;
    } catch (e) { last = e.message; }
    await sleep(1000);
  }
  return { ok: false, detail: last };
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** CDP window.close (the USER quit path: window-all-closed -> backend.kill()).
 * NOTE (verified 2026-10-30): CDP Browser.close() does NOT deliver the
 * backend kill — the app exits 0 but the backend survives. That is a
 * product finding (backend leaks on any quit path that bypasses
 * window-all-closed), recorded in the evidence README; the smoke must
 * exercise the path a real user takes, so it closes the window here and
 * keeps Browser.close only as a fallback. */
async function cdpWindowClose(cdpPort) {
  try {
    const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const pages = Array.isArray(list.json) ? list.json.filter((p) => p.type === 'page') : [];
    const page = pages.find((p) => (p.url || '').startsWith('file://')) || pages[0];
    if (!page || !page.webSocketDebuggerUrl) return false;
    await new Promise((resolve) => {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } resolve(); }, 10000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.close()' } })));
      ws.addEventListener('message', () => { clearTimeout(timer); try { ws.close(); } catch { /* noop */ } resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(); });
    });
    return true;
  } catch { return false; }
}

/** CDP Browser.close (fallback only — see cdpWindowClose note). */
async function cdpBrowserClose(cdpPort) {
  try {
    const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
    const wsUrl = list.json?.webSocketDebuggerUrl;
    if (!wsUrl) return false;
    await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } resolve(); }, 10000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.addEventListener('message', () => { clearTimeout(timer); try { ws.close(); } catch { /* noop */ } resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve(); });
    });
    return true;
  } catch { return false; }
}

/** Read the V3-#1 per-install token from a (temp) HOME's userData dir. */
function readInstallToken(home) {
  for (const name of ['ai-factory', 'AI Factory']) {
    const f = join(home, '.config', name, 'api-token');
    try {
      const t = readFileSync(f, 'utf8').trim();
      if (t) return { file: f, token: t };
    } catch { /* try next */ }
  }
  return null;
}
async function cdpEvaluate(cdpPort) {
  const list = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const pages = Array.isArray(list.json) ? list.json.filter((p) => p.type === 'page') : [];
  const page = pages.find((p) => (p.url || '').startsWith('file://')) || pages[0];
  if (!page || !page.webSocketDebuggerUrl) return { ok: false, detail: `no debuggable page (pages: ${pages.length})` };
  return new Promise((resolve) => {
    const errors = [];
    let settled = false;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const finish = (r) => { if (!settled) { settled = true; try { ws.close(); } catch { /* noop */ } resolve(r); } };
    const timer = setTimeout(() => finish({ ok: false, detail: 'CDP evaluate timeout' }), 30000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({
        id: 2, method: 'Runtime.evaluate',
        params: {
          expression: `JSON.stringify({ title: document.title, ready: document.readyState, tabs: document.querySelectorAll('.center-tabs button').length, mainLen: ((document.querySelector('main') || document.body).innerText || '').replace(/\\s+/g,' ').trim().length })`,
          returnByValue: true,
        },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(String(msg.params?.exceptionDetails?.exception?.description || 'page exception').slice(0, 200));
      if (msg.id === 2) {
        clearTimeout(timer);
        const raw = msg.result?.result?.value;
        let val = null;
        try { val = JSON.parse(raw); } catch { /* unparseable */ }
        if (!val) return finish({ ok: false, detail: 'CDP evaluate returned no value', errors });
        finish({ ok: true, ...val, errors });
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, detail: 'CDP websocket error', errors }); });
  });
}

export async function runPackagedSmoke(opts) {
  const results = [];
  const push = (id, status, detail) => results.push({ id, status, detail });
  // Resolve relative --dir/--appimage against the caller's cwd NOW: the
  // child later runs with cwd = temp home, and a relative binary path
  // would make xvfb-run report "ai-factory: not found" (first-run bug).
  if (opts.dir && !isAbsolute(opts.dir)) opts.dir = resolve(opts.dir);
  if (opts.appimage && !isAbsolute(opts.appimage)) opts.appimage = resolve(opts.appimage);
  let unpackedDir = opts.dir;
  let extracted = null;
  if (opts.appimage) {
    const tmp = join(homedir(), `packaged-smoke-extract-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    const r = spawnSync(opts.appimage, ['--appimage-extract'], { cwd: tmp, encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) {
      push('layout-extract', 'FAIL', `AppImage extract failed: ${(r.stderr || '').slice(0, 300)}`);
      return results;
    }
    extracted = join(tmp, 'squashfs-root');
    unpackedDir = extracted;
    push('layout-extract', 'PASS', `extracted to ${extracted}`);
  }
  if (!unpackedDir || !existsSync(unpackedDir)) {
    push('layout-dir', 'FAIL', `packaged dir not found: ${unpackedDir}`);
    return results;
  }
  for (const c of checkPackagedLayout(unpackedDir)) {
    push(c.id, c.pass ? 'PASS' : 'FAIL', c.detail);
  }
  if (results.some((r) => r.status === 'FAIL')) return results;

  const port = 32000 + Math.floor(Math.random() * 10000);
  const cdpPort = 19300 + Math.floor(Math.random() * 500);
  const home = join(homedir(), `packaged-smoke-${process.pid}-${Date.now()}`);
  mkdirSync(join(home, 'secrets'), { recursive: true });
  const binary = join(unpackedDir, 'ai-factory');
  const haveXvfb = spawnSync('which', ['Xvfb'], { encoding: 'utf8' }).status === 0;
  if (!haveXvfb) {
    push('launch', 'SKIP', 'Xvfb not installed: packaged app cannot start headless here');
    push('window', 'SKIP', 'Xvfb not installed: window render not checked');
    return results;
  }
  // Direct Xvfb (not xvfb-run): xvfb-run swallows SIGTERM, so a graceful
  // quit could never be observed through it. Pick a free display.
  const wanted = opts.display && opts.display !== ':99' ? [opts.display] : [];
  const candidates = [...wanted, ...Array.from({ length: 11 }, (_, i) => `:${99 + i}`)];
  let xvfbProc = null;
  let display = null;
  for (const cand of [...new Set(candidates)]) {
    const p = spawn('Xvfb', [cand, '-screen', '0', '1600x900x24'], { stdio: 'ignore' });
    await sleep(1200);
    if (p.exitCode === null) { xvfbProc = p; display = cand; break; }
  }
  if (!xvfbProc) {
    push('launch', 'FAIL', 'no free X display in :99-109');
    return results;
  }
  const env = {
    ...process.env,
    DISPLAY: display,
    HOME: home,
    PORT: String(port),
    DB_PATH: join(home, 'factory.db'),
    FACTORY_SECRETS_DIR: join(home, 'secrets'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // detached:true makes the app a process-group leader, so the fallback
  // group SIGTERM can take the app AND its backend together.
  const child = spawn(binary, ['--no-sandbox', `--remote-debugging-port=${cdpPort}`], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout?.on('data', (d) => { out += d.toString(); });
  child.stderr?.on('data', (d) => { out += d.toString(); });
  const cleanup = () => {
    try { if (!child.killed) child.kill('SIGKILL'); } catch { /* noop */ }
    try { xvfbProc?.kill('SIGKILL'); } catch { /* noop */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
    if (extracted) { try { rmSync(join(homedir(), `packaged-smoke-extract-${process.pid}`), { recursive: true, force: true }); } catch { /* noop */ } }
  };
  try {
    await sleep(3000);
    if (child.exitCode !== null) {
      push('launch', 'FAIL', `app exited early code=${child.exitCode}: ${out.slice(-500)}`);
      return results;
    }
    push('launch', 'PASS', `app process alive after 3s under Xvfb ${display}`);
    const health = await pollHealth(port, 90000);
    push('health', health.ok ? 'PASS' : 'FAIL', health.ok ? 'GET /api/health 200 ok:true' : `health never ready: ${health.detail}`);
    if (health.ok) {
      // V3-#1: the packaged backend requires the per-install token for
      // every /api route except /api/health. The token lives in the
      // app's userData dir — under our temp HOME, so discovery here also
      // proves the smoke leaked nothing into the real ~/.config.
      const tok = readInstallToken(home);
      push('install-token', tok ? 'PASS' : 'FAIL', tok ? `per-install token found at ${tok.file}` : 'no api-token under temp HOME userData');
      const headers = tok ? { Authorization: `Bearer ${tok.token}` } : {};
      const stats = await fetchJson(`http://127.0.0.1:${port}/api/stats`, headers);
      push('stats', stats.status === 200 ? 'PASS' : 'FAIL', `GET /api/stats status ${stats.status}${tok ? ' (authed)' : ' (no token)'}`);
      const projects = await fetchJson(`http://127.0.0.1:${port}/api/projects`, headers);
      const projOk = projects.status === 200 && projects.json && typeof projects.json === 'object';
      push('projects', projOk ? 'PASS' : 'FAIL', `GET /api/projects status ${projects.status}${tok ? ' (authed)' : ' (no token)'}`);
      // Sandbox probe: reported, never asserted available (this VM: no bwrap).
      try {
        const sb = await import(join(repoRoot, 'apps', 'server', 'dist', 'build-sandbox.js'));
        const probe = await sb.probeSandbox('bwrap');
        push('sandbox-probe', 'PASS', `bwrap probe: available=${probe.available} reason=${probe.reason || 'n/a'} (unavailable + audited degrade is the expected non-Linux/VM result)`);
      } catch (e) {
        push('sandbox-probe', 'SKIP', `probe import failed: ${e.message}`);
      }
      const cdp = await cdpEvaluate(cdpPort);
      if (!cdp.ok) {
        push('window', 'FAIL', cdp.detail);
      } else {
        const winOk = cdp.title && cdp.tabs >= 20 && cdp.mainLen > 20 && cdp.errors.length === 0;
        push('window', winOk ? 'PASS' : 'FAIL', `title=${JSON.stringify(cdp.title)} tabs=${cdp.tabs} mainLen=${cdp.mainLen} pageErrors=${cdp.errors.length}${cdp.errors.length ? ' :: ' + cdp.errors.join('|').slice(0, 200) : ''}`);
      }
      const backends = findBackendPids(unpackedDir);
      push('one-backend', backends.length === 1 ? 'PASS' : 'FAIL', `backend processes found: ${backends.length} (need exactly 1)`);
    }
    // Graceful quit first via the USER path (window.close ->
    // window-all-closed -> backend.kill() -> app.quit()); fall back to
    // Browser.close, then to process-group SIGTERM.
    let quitMethod = 'none';
    await cdpWindowClose(cdpPort);
    let exited = await Promise.race([
      new Promise((r) => child.once('exit', (code) => r(code))),
      sleep(15000).then(() => null),
    ]);
    if (exited !== null) quitMethod = 'window-close';
    if (exited === null) {
      await cdpBrowserClose(cdpPort);
      exited = await Promise.race([
        new Promise((r) => child.once('exit', (code) => r(code))),
        sleep(10000).then(() => null),
      ]);
      if (exited !== null) quitMethod = 'browser-close';
    }
    if (exited === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* noop */ } }
      exited = await Promise.race([
        new Promise((r) => child.once('exit', (code) => r(code))),
        sleep(10000).then(() => null),
      ]);
      if (exited !== null) quitMethod = 'group-sigterm';
    }
    if (exited === null) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      push('quit', 'FAIL', 'app did not exit on Browser.close or group SIGTERM');
    } else {
      push('quit', 'PASS', `app exited code=${exited} via ${quitMethod}`);
    }
    await sleep(1000);
    const leftover = findBackendPids(unpackedDir);
    push('no-leftover-backend', leftover.length === 0 ? 'PASS' : 'FAIL', `backend processes after quit: ${leftover.length}`);
  } finally {
    try { if (!child.killed) child.kill('SIGKILL'); } catch { /* noop */ }
    cleanup();
  }
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir && !opts.appimage) {
    console.error('usage: node scripts/packaged-smoke.mjs --dir <unpacked-dir> | --appimage <file> [--out <json>] [--display :99]');
    process.exit(2);
  }
  const results = await runPackagedSmoke(opts);
  for (const r of results) console.log(`${r.status}  ${r.id}  ${r.detail}`);
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${pass}/${results.length} passed (${fail} fail, ${skip} skip)`);
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify({ results, pass, fail, skip }, null, 2));
  }
  process.exit(fail > 0 ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('[packaged-smoke] FATAL:', e); process.exit(1); });
}
