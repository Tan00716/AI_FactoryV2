/**
 * Desktop e2e shared helpers (H1 test infra).
 *
 * Each case module exports: { name, timeout?, run(ctx) }
 * ctx: { cdpPort, uiPort, repoRoot, connect(), killServer(), startServer(),
 *        shotsDir, sleep, log }
 * run() must return { pass: boolean, detail: string }; throwing also fails the case.
 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCDP(repoRoot) {
  const candidates = [
    `${repoRoot}/node_modules`,
    '/home/hatch/b97-verify/node_modules',
  ];
  for (const dir of candidates) {
    try {
      const resolved = require.resolve('chrome-remote-interface', { paths: [dir] });
      return require(resolved);
    } catch { /* try next */ }
  }
  throw new Error(
    'chrome-remote-interface not found. Install it (npm i -D chrome-remote-interface) ' +
    'or make it resolvable from one of: ' + candidates.join(', ')
  );
}

/** Connect to the renderer page served by vite dev. Returns { client, Runtime, Page, ev, shot }. */
async function connect(ctx) {
  const CDP = loadCDP(ctx.repoRoot);
  const deadline = Date.now() + 60000;
  let page = null;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const targets = await CDP.List({ port: ctx.cdpPort });
      page = targets.find((t) => t.type === 'page' && t.url.includes(String(ctx.uiPort)));
      if (page) break;
    } catch (e) { lastErr = e; }
    await sleep(1000);
  }
  if (!page) throw new Error(`renderer page (vite :${ctx.uiPort}) not on CDP :${ctx.cdpPort}` + (lastErr ? `: ${lastErr.message}` : ''));
  const client = await CDP({ target: page, port: ctx.cdpPort });
  const { Runtime, Page } = client;
  await Runtime.enable();
  await Page.enable();
  const ev = async (expr) => (await Runtime.evaluate({ expression: expr, returnByValue: true })).result.value;
  // Wait for the React app to actually render (the CDP target exists before first paint).
  {
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const n = await ev(`document.querySelectorAll('.center-tabs button').length`);
        if (n > 0) break;
      } catch { /* page may still be navigating */ }
      if (Date.now() > deadline) throw new Error('app never rendered (.center-tabs button not found)');
      await sleep(1000);
    }
  }
  const fs = require('fs');
  const path = require('path');
  const shot = async (name) => {
    const s = await Page.captureScreenshot({ format: 'png' });
    const p = path.join(ctx.shotsDir, `${name}.png`);
    fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
    return p;
  };
  return { client, Runtime, Page, ev, shot };
}

/**
 * Install in-page JS error trap. Returns a function returning collected errors.
 * NOTE: filters the known dev-only xterm viewport noise ("dimensions") — proven
 * harmless in production builds (QA-R1 verified on file:// renderer, PTY works).
 */
async function installErrorTrap(Runtime) {
  await Runtime.evaluate({
    expression: `
      window.__dtErrs = [];
      window.addEventListener('error', (e) => {
        if (/dimensions/.test(e.message || '')) return; // dev-only xterm noise
        window.__dtErrs.push('ONERROR: ' + (e.message || '').slice(0, 200));
      });
      window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        window.__dtErrs.push('UNHANDLED: ' + String((r && (r.stack || r.message)) || r).slice(0, 200));
      });
    `,
  });
  return async (ev) => ev(`JSON.stringify(window.__dtErrs || [])`).then((s) => JSON.parse(s));
}

/** Force UI language and reload if it changed. */
async function ensureLang(ev, Page, lang) {
  const cur = await ev(`localStorage.getItem('ai-factory:lang') || 'zh'`);
  if (cur !== lang) {
    await ev(`localStorage.setItem('ai-factory:lang', '${lang}')`);
    await Page.reload({ ignoreCache: true });
    await sleep(5000);
  }
  return ev(`localStorage.getItem('ai-factory:lang') || 'zh'`);
}

/** Click a button whose trimmed text exactly matches `label`. Returns clicked bool. */
async function clickButtonByText(ev, label) {
  const esc = label.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='${esc}'); if(b){b.click(); return true;} return false; })()`);
}

module.exports = { sleep, loadCDP, connect, installErrorTrap, ensureLang, clickButtonByText };
