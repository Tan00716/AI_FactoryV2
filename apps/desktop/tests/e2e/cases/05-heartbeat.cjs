/**
 * Case: server heartbeat — killing the backend flips the top-bar indicator to
 * Offline, restarting it flips it back to Running (10s /health heartbeat).
 */
'use strict';
const { connect, installErrorTrap, ensureLang, sleep } = require('../lib.cjs');

module.exports = {
  name: 'heartbeat-recovery',
  timeout: 120000,
  async run(ctx) {
    const { client, Runtime, Page, ev, shot } = await connect(ctx);
    try {
      await ensureLang(ev, Page, 'zh');
      const getErrs = await installErrorTrap(Runtime);
      await sleep(3000);
      const dot = async () => ev(`document.querySelector('.run-status')?.textContent.trim() || '?'`);
      const t0 = await dot();

      await ctx.killServer();
      await sleep(14000); // heartbeat period 10s + margin
      const t1 = await dot();
      await shot('heartbeat-offline');

      await ctx.startServer();
      await sleep(14000);
      const t2 = await dot();
      const errs = await getErrs(ev);
      const pass = /Running/.test(t0) && /Offline/.test(t1) && /Running/.test(t2) && errs.length === 0;
      return {
        pass,
        detail: `up='${t0}' killed='${t1}' restarted='${t2}'; jsErrors=${errs.length}`,
      };
    } finally {
      await client.close();
    }
  },
};
