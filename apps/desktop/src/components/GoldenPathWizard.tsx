import { useEffect, useState } from 'react';
import { useLang } from '../i18n';
import {
  GOLDEN_PATH_STEPS,
  GLOSSARY_TERMS,
  GOTO_TAB_EVENT,
  OPEN_CREATE_EVENT,
  gotoTabDetail,
  loadGoldenPathProgress,
  saveGoldenPathProgress,
} from '../navigation/tiers';

/**
 * First-run golden path wizard (V3-#3).
 *
 * A guided checklist, not an auto-runner: each step jumps to an existing
 * flow (Project / QA / create-task modal / Approvals) and the user marks
 * it done. Never forced: dismiss persists (reopenable from the nav
 * toolbar), plain close only hides it for this session. Progress and
 * dismissal persist in localStorage; no server changes.
 */
export function GoldenPathWizard({ onClose, onDismiss }: {
  onClose: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLang();
  const [done, setDone] = useState<string[]>(() =>
    typeof window === 'undefined'
      ? []
      : loadGoldenPathProgress(window.localStorage).done,
  );
  const [showGlossary, setShowGlossary] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    saveGoldenPathProgress(
      { done, dismissed: loadGoldenPathProgress(window.localStorage).dismissed },
      window.localStorage,
    );
  }, [done]);

  const toggle = (id: string) =>
    setDone((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));

  const jump = (step: (typeof GOLDEN_PATH_STEPS)[number]) => {
    if (step.action === 'open-create') {
      window.dispatchEvent(new CustomEvent(OPEN_CREATE_EVENT));
    } else {
      window.dispatchEvent(new CustomEvent(GOTO_TAB_EVENT, { detail: gotoTabDetail(step.target) }));
    }
  };

  return (
    <div className="golden-wizard">
      <div className="golden-head">
        <strong>{t('golden.title')}</strong>
        <span className="muted">{t('golden.progress', { done: done.length, total: GOLDEN_PATH_STEPS.length })}</span>
        <span className="golden-actions">
          <button onClick={onDismiss}>{t('golden.skip')}</button>
          <button onClick={onClose}>{t('golden.close')}</button>
        </span>
      </div>
      <div className="muted">{t('golden.subtitle')}</div>
      <ol className="golden-steps">
        {GOLDEN_PATH_STEPS.map((step, i) => (
          <li key={step.id}>
            <span>{i + 1}. {t(`golden.step.${step.id}.title`)} — {t(`golden.step.${step.id}.desc`)}</span>
            {' '}
            <button onClick={() => jump(step)}>{t('golden.go')}</button>
            {' '}
            <label>
              <input type="checkbox" checked={done.includes(step.id)} onChange={() => toggle(step.id)} />
              {done.includes(step.id) ? t('golden.done') : t('golden.markDone')}
            </label>
          </li>
        ))}
      </ol>
      <div>
        <button onClick={() => setShowGlossary((v) => !v)}>{t('golden.glossaryTitle')}</button>
        {showGlossary && (
          <ul className="golden-glossary">
            {GLOSSARY_TERMS.map((term) => (
              <li key={term}>{t(`golden.term.${term}`)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
