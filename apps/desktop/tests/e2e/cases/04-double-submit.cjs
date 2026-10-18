/** Case: triple-clicking "create" submits exactly one task (busyRef guard). */
'use strict';
const { connect, installErrorTrap, ensureLang, clickButtonByText, sleep } = require('../lib.cjs');

module.exports = {
  name: 'double-submit-guard',
  timeout: 90000,
  async run(ctx) {
    const { client, Runtime, Page, ev, shot } = await connect(ctx);
    try {
      await ensureLang(ev, Page, 'zh');
      const getErrs = await installErrorTrap(Runtime);
      await sleep(2500);
      await clickButtonByText(ev, '看板');
      await sleep(1500);
      const countOf = async () => ev(`document.body.innerText.match(/待办 (\\d+)/)?.[1] || '?'`);
      const before = await countOf();
      await ev(`[...document.querySelectorAll('button')].find(x=>/新建任务/.test(x.textContent))?.click()`);
      await sleep(1000);
      const title = 'E2E 连击测试 ' + Date.now();
      await ev(`(() => { const input = document.querySelector('.modal input'); input.focus(); document.execCommand('selectAll',false,null); document.execCommand('insertText', false, ${JSON.stringify(title)}); })()`);
      await sleep(400);
      await ev(`(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>/^创建/.test(x.textContent)); b.click(); b.click(); b.click(); })()`);
      await sleep(3000);
      const after = await countOf();
      await shot('double-submit');
      const errs = await getErrs(ev);
      const delta = (parseInt(after, 10) || 0) - (parseInt(before, 10) || 0);
      return {
        pass: delta === 1 && errs.length === 0,
        detail: `before=${before} after=${after} delta=${delta} (expect 1); jsErrors=${errs.length}`,
      };
    } finally {
      await client.close();
    }
  },
};
