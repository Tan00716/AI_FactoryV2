import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n';
import { rankMatches } from '../utils/cmdk';
import {
  getKeybindingManager,
  canonicalSequence,
} from './manager';
import { useCommandTitle } from './host';
import {
  validateUserKeybindings,
  chordFromEvent,
  type BindingConflict,
  type EffectiveBinding,
  type KeyChord,
  type UserKeybinding,
} from '@ai-factory/keybinding';

interface CaptureState {
  command: string;
  /** Canonical sequence being replaced (null when adding a fresh binding). */
  replaceCanonical: string | null;
  chords: KeyChord[];
}

/**
 * Keyboard shortcuts settings (round-5 R5-S1): every registered command is
 * listed, searchable, and rebindable; conflicts are surfaced, never silent;
 * the user layer persists through /api/keybindings (keybindings.json).
 */
export function KeybindingSettings() {
  const { t } = useLang();
  const titleFor = useCommandTitle();
  const [bindings, setBindings] = useState<EffectiveBinding[]>([]);
  const [userLayer, setUserLayer] = useState<UserKeybinding[]>([]);
  const [conflicts, setConflicts] = useState<BindingConflict[]>([]);
  const [query, setQuery] = useState('');
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [timeoutMs, setTimeoutMs] = useState(() => getKeybindingManager().sequenceTimeoutMs);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const m = getKeybindingManager();
    try {
      const r = await api.keybindingsGet();
      const issues = m.registry.setUserKeybindings(r.keybindings);
      setUserLayer(m.registry.getUserKeybindings());
      if (issues.length > 0) setError(t('keybinding.loadInvalid'));
    } catch {
      setUserLayer(m.registry.getUserKeybindings());
    }
    setBindings(m.registry.effectiveBindings());
    setConflicts(m.registry.detectConflicts());
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveUserLayer = useCallback(
    async (entries: UserKeybinding[]) => {
      setError('');
      try {
        await api.keybindingsSave(entries);
      } catch (err) {
        setError(t('keybinding.saveFailed', { error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      await refresh();
    },
    [refresh, t],
  );

  const removeUserEntriesMatching = useCallback(
    (command: string, canonical: string | null) => {
      const m = getKeybindingManager();
      return userLayer.filter((e) => {
        if (e.command !== command) return true;
        if (canonical === null) return false; // remove all for the command
        if (e.key === null) return canonical === 'unbound';
        try {
          return canonicalSequence(m.parseKeys(e.key)) !== canonical;
        } catch {
          return true;
        }
      });
    },
    [userLayer],
  );

  // ---- capture mode: the next keydown(s) become the new binding ----
  useEffect(() => {
    if (!capture) return undefined;
    const finishCapture = (c: CaptureState) => {
      const m = getKeybindingManager();
      const key = canonicalSequence(c.chords);
      const rest = removeUserEntriesMatching(c.command, c.replaceCanonical);
      void saveUserLayer([...rest, { command: c.command, key }]);
      setCapture(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapture(null);
        return;
      }
      if (e.key === 'Enter') {
        if (capture.chords.length > 0) finishCapture(capture);
        return;
      }
      const chord = chordFromEvent(e);
      // A bare modifier press has an empty key — ignore it.
      if (chord.key === '' || chord.key === 'Control' || chord.key === 'Shift' || chord.key === 'Alt' || chord.key === 'Meta') return;
      const chords = [...capture.chords, chord];
      if (chords.length >= 4) {
        finishCapture({ ...capture, chords });
      } else {
        setCapture({ ...capture, chords });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture]);

  const visible = useMemo(() => {
    if (query.trim() === '') return bindings;
    const texts = bindings.map((b) => `${titleFor(b.command, b.title)} ${b.command} ${b.display.join(' ')}`);
    return rankMatches(query, texts).map((i) => bindings[i]);
  }, [bindings, query, titleFor]);

  const sourceLabel = (s: EffectiveBinding['bindingSource']) =>
    s === 'default' ? t('keybinding.src.default')
    : s === 'user' ? t('keybinding.src.user')
    : s === 'mixed' ? t('keybinding.src.mixed')
    : t('keybinding.src.unbound');

  const onExport = () => {
    const blob = new Blob([JSON.stringify(userLayer, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'keybindings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onImportFile = async (file: File) => {
    setError('');
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const issues = validateUserKeybindings(parsed);
      if (issues.length > 0) {
        setError(t('keybinding.importInvalid', { error: issues[0].message }));
        return;
      }
      await saveUserLayer(parsed as UserKeybinding[]);
    } catch (err) {
      setError(t('keybinding.importInvalid', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const m = getKeybindingManager();
  return (
    <div className="kb-settings">
      <h2>{t('keybinding.title')}</h2>
      <div className="kb-toolbar">
        <input
          className="kb-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('keybinding.search')}
          aria-label={t('keybinding.search')}
        />
        <label className="kb-timeout">
          {t('keybinding.timeout')}
          <input
            type="number"
            min={200}
            max={5000}
            step={100}
            value={timeoutMs}
            onChange={(e) => {
              const v = m.setSequenceTimeout(Number(e.target.value));
              setTimeoutMs(v);
            }}
          />
          {t('keybinding.ms')}
        </label>
        <button type="button" onClick={onExport}>{t('keybinding.export')}</button>
        <button type="button" onClick={() => fileRef.current?.click()}>{t('keybinding.import')}</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportFile(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (window.confirm(t('keybinding.resetAllConfirm'))) {
              void api.keybindingsReset().then(() => refresh());
            }
          }}
        >
          {t('keybinding.resetAll')}
        </button>
      </div>
      {error && <div className="banner err">{error}</div>}

      {conflicts.length > 0 && (
        <div className="kb-conflicts">
          <h3>{t('keybinding.conflicts')} ({conflicts.length})</h3>
          <p className="muted">{t('keybinding.conflictNote')}</p>
          {conflicts.map((c) => (
            <div className="kb-conflict" key={c.sequence}>
              <kbd>{c.sequence}</kbd>
              <span>{c.commands.map((cmd) => `${titleFor(cmd.id, cmd.title)} (${cmd.source})`).join(' ⚠ ')}</span>
            </div>
          ))}
        </div>
      )}

      <table className="kb-table">
        <thead>
          <tr>
            <th>{t('keybinding.colCommand')}</th>
            <th>{t('keybinding.colBindings')}</th>
            <th>{t('keybinding.colSource')}</th>
            <th>{t('keybinding.colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((b) => (
            <tr key={b.command}>
              <td className="kb-cmd">{titleFor(b.command, b.title)}</td>
              <td>
                {b.sequences.length === 0 && <span className="muted">{t('keybinding.unboundHint')}</span>}
                {b.sequences.map((seq, i) => {
                  const canonical = canonicalSequence(seq);
                  const isUser = userLayer.some((e) => {
                    if (e.command !== b.command || e.key === null) return false;
                    try {
                      return canonicalSequence(m.parseKeys(e.key)) === canonical;
                    } catch {
                      return false;
                    }
                  });
                  return (
                    <span className="kb-chip-row" key={i}>
                      <kbd
                        className={`kb-chip${isUser ? ' user' : ''}`}
                        title={t('keybinding.rebindHint')}
                        onClick={() => setCapture({ command: b.command, replaceCanonical: isUser ? canonical : null, chords: [] })}
                      >
                        {b.display[i]}
                      </kbd>
                      {isUser && (
                        <button
                          type="button"
                          className="kb-x"
                          title={t('keybinding.removeBinding')}
                          onClick={() => void saveUserLayer(removeUserEntriesMatching(b.command, canonical))}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  );
                })}
              </td>
              <td><span className="kb-source">{sourceLabel(b.bindingSource)}</span></td>
              <td>
                <button type="button" onClick={() => setCapture({ command: b.command, replaceCanonical: null, chords: [] })}>
                  {t('keybinding.add')}
                </button>{' '}
                <button type="button" onClick={() => void saveUserLayer(removeUserEntriesMatching(b.command, null))}>
                  {t('keybinding.reset')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {visible.length === 0 && <div className="muted">{t('keybinding.noResults')}</div>}

      {capture && (
        <div className="kb-capture-overlay" role="dialog" aria-label={t('keybinding.captureHint')}>
          <div className="kb-capture-panel">
            <div>{t('keybinding.captureHint')}</div>
            <div className="kb-capture-keys">
              {capture.chords.length === 0
                ? '…'
                : capture.chords.map((c, i) => <kbd key={i}>{m.chordDisplay(c)}</kbd>)}
            </div>
          </div>
        </div>
      )}

      <p className="muted kb-boundaries">{t('keybinding.boundaries')}</p>
    </div>
  );
}
