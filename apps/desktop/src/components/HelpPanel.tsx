import { useLang } from '../i18n';
import { GOTO_TAB_EVENT } from '../navigation/tiers';

/** V3R2-#3: the app's first real help entry point. No external links: the
 * jump buttons navigate to existing panels via the same tab event the
 * wizard uses, and the docs note names repo files as plain text (the
 * desktop renderer cannot open local files, so no href is faked). */
const JUMPS: { labelKey: string; tab: string }[] = [
  { labelKey: 'help.jumpBoard', tab: 'Board' },
  { labelKey: 'help.jumpProject', tab: 'Project' },
  { labelKey: 'help.jumpQA', tab: 'QA' },
];

export function HelpPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLang();
  const jump = (tab: string) => {
    window.dispatchEvent(new CustomEvent(GOTO_TAB_EVENT, { detail: { tab } }));
    onClose();
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('help.title')}</h2>
        <p className="hint">{t('help.intro')}</p>
        <div className="btn-row">
          {JUMPS.map((j) => (
            <button key={j.tab} onClick={() => jump(j.tab)}>{t(j.labelKey)}</button>
          ))}
        </div>
        <p className="hint">{t('help.docsNote')}</p>
        <div className="btn-row">
          <button onClick={onClose}>{t('help.close')}</button>
        </div>
      </div>
    </div>
  );
}
