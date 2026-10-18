/** Case: task-detail and employee drawers open and close with Escape. */
'use strict';
const { connect, installErrorTrap, ensureLang, clickButtonByText, sleep } = require('../lib.cjs');

module.exports = {
  name: 'drawer-esc',
  timeout: 90000,
  async run(ctx) {
    const { client, Runtime, Page, ev } = await connect(ctx);
    try {
      await ensureLang(ev, Page, 'zh');
      const getErrs = await installErrorTrap(Runtime);
      await sleep(2500);
      const hasDrawer = async () => ev(`!!document.querySelector('.detail.wide')`);
      const esc = async () => { await ev(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`); await sleep(800); };

      await clickButtonByText(ev, '看板');
      await sleep(1500);
      await ev(`document.querySelector('.card .card-title')?.click()`);
      await sleep(1500);
      const d1 = await hasDrawer();
      await esc();
      const d2 = await hasDrawer();
      const taskOk = d1 && !d2;

      await ev(`(() => { const el=[...document.querySelectorAll('.org-name')].find(x=>x.textContent.includes('AI PM')); if(el){el.click(); return true;} return false; })()`);
      await sleep(1800);
      const e1 = await hasDrawer();
      await esc();
      const e2 = await hasDrawer();
      const empOk = e1 && !e2;

      const errs = await getErrs(ev);
      return {
        pass: taskOk && empOk && errs.length === 0,
        detail: `taskDrawer open=${d1} afterEsc=${d2}; empDrawer open=${e1} afterEsc=${e2}; jsErrors=${errs.length}`,
      };
    } finally {
      await client.close();
    }
  },
};
