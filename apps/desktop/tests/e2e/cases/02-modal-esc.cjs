/** Case: create-task modal opens and closes with Escape. */
'use strict';
const { connect, installErrorTrap, ensureLang, clickButtonByText, sleep } = require('../lib.cjs');

module.exports = {
  name: 'modal-esc',
  timeout: 90000,
  async run(ctx) {
    const { client, Runtime, Page, ev } = await connect(ctx);
    try {
      await ensureLang(ev, Page, 'zh');
      const getErrs = await installErrorTrap(Runtime);
      await sleep(2500);
      await clickButtonByText(ev, '看板');
      await sleep(1500);
      const opened = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/新建任务|New task/.test(x.textContent)); if(b){b.click(); return true;} return false; })()`);
      await sleep(1200);
      const open1 = await ev(`!!document.querySelector('.modal-backdrop')`);
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      await sleep(800);
      const afterEsc = await ev(`!!document.querySelector('.modal-backdrop')`);
      const errs = await getErrs(ev);
      const pass = opened && open1 && !afterEsc && errs.length === 0;
      return {
        pass,
        detail: `openBtn=${opened} open=${open1} afterEsc=${afterEsc} jsErrors=${errs.length}` + (errs.length ? ` :: ${errs.join('|').slice(0, 200)}` : ''),
      };
    } finally {
      await client.close();
    }
  },
};
