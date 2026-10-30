import { useLang } from '../i18n';
import { GOTO_TAB_EVENT, gotoTabDetail, PANEL_GUIDE_TARGETS } from '../navigation/tiers';
import type { PanelGuideKey } from '../navigation/tiers';

/**
 * Empty-state guide (V3-#3): when a list panel has no data yet, say what
 * the panel is and what to do next, instead of rendering a blank area.
 * Additive only: panels render this alongside their normal content when
 * their list is empty; it never replaces error or loading states.
 */
export function EmptyState({ panel }: { panel: PanelGuideKey }) {
  const { t } = useLang();
  const target = PANEL_GUIDE_TARGETS[panel];
  const go = () => {
    window.dispatchEvent(new CustomEvent(GOTO_TAB_EVENT, { detail: gotoTabDetail(target) }));
  };
  return (
    <div className="empty-guide">
      <div>{t(`guide.${panel}.what`)}</div>
      <div className="muted">{t(`guide.${panel}.next`)}</div>
      <button onClick={go}>{t('guide.go')}</button>
    </div>
  );
}
