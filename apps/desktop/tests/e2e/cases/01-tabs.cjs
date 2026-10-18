/** Case: every center tab is clickable, renders content, and throws no JS errors. */
'use strict';
const { connect, installErrorTrap, ensureLang, sleep } = require('../lib.cjs');

module.exports = {
  name: 'tabs-clickable',
  timeout: 180000,
  async run(ctx) {
    const { client, Runtime, Page, ev, shot } = await connect(ctx);
    try {
      await ensureLang(ev, Page, 'zh');
      const getErrs = await installErrorTrap(Runtime);
      await sleep(3000);
      const labels = await ev(`JSON.stringify([...document.querySelectorAll('.center-tabs button')].map(b=>b.textContent.trim()))`);
      const tabs = JSON.parse(labels);
      if (tabs.length < 20) return { pass: false, detail: `only ${tabs.length} tabs found` };
      const failures = [];
      for (let i = 0; i < tabs.length; i++) {
        const before = (await getErrs(ev)).length;
        await ev(`document.querySelectorAll('.center-tabs button')[${i}].click()`);
        await sleep(1500);
        const info = await ev(`(() => { const m = document.querySelector('main') || document.body; const t = (m.innerText || '').replace(/\\s+/g,' ').trim(); return JSON.stringify({ len: t.length }); })()`);
        const len = JSON.parse(info).len;
        const newErrs = (await getErrs(ev)).slice(before);
        if (len < 20) failures.push(`${tabs[i]}: empty content (len=${len})`);
        if (newErrs.length) failures.push(`${tabs[i]}: js errors: ${newErrs.join(' | ').slice(0, 200)}`);
      }
      await shot('tabs-last');
      return failures.length
        ? { pass: false, detail: failures.join('; ') }
        : { pass: true, detail: `${tabs.length} tabs clicked, all rendered, 0 js errors` };
    } finally {
      await client.close();
    }
  },
};
