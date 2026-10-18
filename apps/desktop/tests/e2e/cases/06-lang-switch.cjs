/** Case: 中/EN toggle switches the UI language (tab labels as the probe). */
'use strict';
const { connect, installErrorTrap, clickButtonByText, sleep } = require('../lib.cjs');

module.exports = {
  name: 'lang-switch',
  timeout: 90000,
  async run(ctx) {
    const { client, Runtime, Page, ev, shot } = await connect(ctx);
    try {
      const getErrs = await installErrorTrap(Runtime);
      await sleep(3000);
      const firstTab = async () => ev(`document.querySelectorAll('.center-tabs button')[0]?.textContent.trim() || '?'`);

      await clickButtonByText(ev, 'EN');
      await sleep(2000);
      const enTab = await firstTab();
      const enLang = await ev(`localStorage.getItem('ai-factory:lang')`);
      await shot('lang-en');

      await clickButtonByText(ev, '中');
      await sleep(2000);
      const zhTab = await firstTab();
      const zhLang = await ev(`localStorage.getItem('ai-factory:lang')`);

      const errs = await getErrs(ev);
      const pass = enTab === 'Dashboard' && enLang === 'en' && zhTab === '仪表盘' && zhLang === 'zh' && errs.length === 0;
      return {
        pass,
        detail: `en: tab='${enTab}' lang='${enLang}'; zh: tab='${zhTab}' lang='${zhLang}'; jsErrors=${errs.length}`,
      };
    } finally {
      await client.close();
    }
  },
};
