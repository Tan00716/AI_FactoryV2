import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';
import { getKeybindingManager, type WhichKeyState } from './manager';
import {
  BUILTIN_TABS,
  tabCommandId,
  PALETTE_TOGGLE_COMMAND,
  LANGUAGE_SWITCH_COMMAND,
  commandTitleKey,
} from './commands';

/** Resolve a display title for a command id (i18n, with id fallback). */
export function useCommandTitle(): (commandId: string, fallback: string) => string {
  const { t } = useLang();
  return (commandId: string, fallback: string) => {
    const key = commandTitleKey(commandId);
    if (!key) return fallback;
    const translated = t(key as never);
    // t() returns the key itself when missing — fall back to the id then.
    return translated === key ? fallback : (translated as string);
  };
}

/**
 * Host: creates the keybinding manager once, registers builtin commands,
 * loads the user layer from the server, attaches the global listener, and
 * renders the which-key popup while a prefix is pending.
 */
export function KeybindingHost() {
  const [wk, setWk] = useState<WhichKeyState | null>(null);
  const titleFor = useCommandTitle();

  useEffect(() => {
    const m = getKeybindingManager();
    if (!m.builtinsRegistered) {
      m.builtinsRegistered = true;
      m.registry.registerCommand({
        id: PALETTE_TOGGLE_COMMAND,
        title: 'Toggle Command Palette',
        defaultKeys: ['mod+k'],
        source: 'builtin',
      });
      m.registry.registerCommand({
        id: LANGUAGE_SWITCH_COMMAND,
        title: 'Switch Language',
        source: 'builtin',
      });
      for (const tab of BUILTIN_TABS) {
        m.registry.registerCommand({ id: tabCommandId(tab), title: `Go to ${tab}`, source: 'builtin' });
      }
    }
    let cancelled = false;
    api
      .keybindingsGet()
      .then((r) => {
        if (cancelled) return;
        const issues = m.registry.setUserKeybindings(r.keybindings);
        if (issues.length > 0) {
          // The stored file failed validation (e.g. hand-edited): keep the
          // defaults and say so in the console rather than half-applying.
          // eslint-disable-next-line no-console
          console.warn('[keybinding] stored keybindings.json invalid, using defaults:', issues);
        }
      })
      .catch(() => {
        /* offline backend: defaults only */
      });
    const unsub = m.subscribe(setWk);
    m.attach();
    return () => {
      cancelled = true;
      unsub();
      m.detach();
    };
  }, []);

  if (!wk) return null;
  return <WhichKeyPopup state={wk} titleFor={titleFor} />;
}

function WhichKeyPopup({
  state,
  titleFor,
}: {
  state: WhichKeyState;
  titleFor: (commandId: string, fallback: string) => string;
}) {
  const { t } = useLang();
  return (
    <div className="whichkey-overlay" role="dialog" aria-label={t('keybinding.whichkey.title')}>
      <div className="whichkey-panel">
        <div className="whichkey-prefix">
          <span className="whichkey-prefix-keys">{state.prefixDisplay}</span>
          <span className="whichkey-hint">{t('keybinding.whichkey.hint')}</span>
        </div>
        <div className="whichkey-list">
          {state.candidates.map((c) => (
            <div className="whichkey-item" key={c.display}>
              <kbd className="whichkey-key">{c.display}</kbd>
              <span className="whichkey-cmds">
                {c.commands.map((cmd) => titleFor(cmd.id, cmd.title)).join(' · ')}
              </span>
            </div>
          ))}
        </div>
        {state.timeoutCommand && (
          <div className="whichkey-timeout">
            {t('keybinding.whichkey.timeoutFires', {
              command: titleFor(state.timeoutCommand, state.timeoutCommand),
            })}
          </div>
        )}
      </div>
    </div>
  );
}
