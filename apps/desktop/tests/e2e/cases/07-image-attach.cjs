/** Case: paste an image into the create-task modal → thumbnails → create → server stores the attachment. */
'use strict';
const { connect, installErrorTrap, ensureLang, clickButtonByText, sleep } = require('../lib.cjs');

// 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const API_PORT = Number(process.env.DT_PORT || 32121);

module.exports = {
  name: 'image-attach-paste',
  timeout: 120000,
  async run(ctx) {
    const { client, Runtime, Page, ev, shot } = await connect(ctx);
    try {
      await ensureLang(ev, Page, 'zh');
      const getErrs = await installErrorTrap(Runtime);
      await sleep(2500);
      await clickButtonByText(ev, '看板');
      await sleep(1500);

      // EN check first (ensureLang reloads the page, so the modal flow
      // stays in zh afterwards): the new attach UI must render in EN.
      await ensureLang(ev, Page, 'en');
      await sleep(1500);
      await clickButtonByText(ev, 'Board');
      await sleep(1500);
      await ev(`[...document.querySelectorAll('button')].find(x=>/New Task/.test(x.textContent))?.click()`);
      await sleep(1000);
      const attachLabel = await ev(`[...document.querySelectorAll('.modal button')].some(x=>/Attach images/.test(x.textContent)) ? 'ok' : 'missing'`);
      const hintLabel = await ev(`[...document.querySelectorAll('.modal .hint')].some(x=>/Paste/.test(x.textContent)) ? 'ok' : 'missing'`);
      // Esc closes the modal (QA-R1 behavior).
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(500);
      await ensureLang(ev, Page, 'zh');
      await sleep(1500);
      await clickButtonByText(ev, '看板');
      await sleep(1500);
      if (attachLabel !== 'ok' || hintLabel !== 'ok') {
        return { pass: false, detail: `EN attach UI labels missing (button=${attachLabel} hint=${hintLabel}; i18n key gap?)` };
      }
      await ev(`[...document.querySelectorAll('button')].find(x=>/新建任务/.test(x.textContent))?.click()`);
      await sleep(1000);

      // Simulate a real paste of a PNG file into the modal, then poll for
      // the thumbnail (React flushes state async after the event).
      await ev(`(() => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), c => c.charCodeAt(0));
        const file = new File([bytes], 'paste-shot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const modal = document.querySelector('.modal');
        modal.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
        return true;
      })()`);
      let thumbs = 0;
      for (let i = 0; i < 25 && thumbs !== 1; i++) {
        await sleep(200);
        thumbs = await ev(`document.querySelectorAll('.thumb img').length`);
      }
      if (thumbs !== 1) {
        return { pass: false, detail: `expected 1 thumbnail after paste, got ${thumbs}` };
      }
      await shot('image-pasted');

      const title = 'E2E 图片附件 ' + Date.now();
      await ev(`(() => { const input = document.querySelector('.modal input'); input.focus(); document.execCommand('selectAll',false,null); document.execCommand('insertText', false, ${JSON.stringify(title)}); })()`);
      await sleep(400);
      await ev(`[...document.querySelectorAll('.modal button')].find(x=>/^创建/.test(x.textContent))?.click()`);
      await sleep(4000);

      // Verify server-side: the task exists and carries exactly 1 attachment.
      const tasksRes = await fetch(`http://127.0.0.1:${API_PORT}/api/tasks`);
      const tasks = await tasksRes.json();
      const task = tasks.find((t) => t.title === title);
      if (!task) return { pass: false, detail: 'task not found after create' };
      const attRes = await fetch(`http://127.0.0.1:${API_PORT}/api/tasks/${task.id}/attachments`);
      const attBody = await attRes.json();
      const n = (attBody.attachments || []).length;
      const errs = await getErrs(ev);
      await shot('image-attached');
      return {
        pass: n === 1 && errs.length === 0,
        detail: `attachments=${n} (expect 1); jsErrors=${errs.length}`,
      };
    } finally {
      await client.close();
    }
  },
};
