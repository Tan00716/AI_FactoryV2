import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type BookmarkDtoItem,
  type BookmarkKindDto,
  type BookmarkRelocationStatus,
} from '../api';
import { useLang } from '../i18n';
import {
  BOOKMARK_MNEMONICS,
  mnemonicForJumpCommand,
  onCommand,
} from '../keybinding/commands';

/**
 * Bookmarks tool window (round-5 task B9) — JetBrains Favorites-style.
 * Line/file/dir bookmarks with [0-9a-z] mnemonics, grouped by directory,
 * rename/delete, drift-aware jump (never silently jumps to a wrong line).
 *
 * HONEST BOUNDARIES (rendered in the UI):
 *  - Line bookmarks store 5 context lines at creation; after edits the
 *    server relocates within +/-300 lines or honestly reports "drifted".
 *  - Renamed/deleted files are not followed: resolve 404s and the row is
 *    marked missing until you delete it.
 *  - Bookmarks live in the server user-data dir (per project root), not in
 *    git; there is no cross-machine sync in v1.
 */

export const BOOKMARKS_CHANGED_EVENT = 'ai-factory:bookmarks-changed';

function openInEditor(path: string, line?: number) {
  window.dispatchEvent(
    new CustomEvent('ai-factory:open-file', { detail: { path, line: line ?? 1 } }),
  );
}

const KIND_ICON: Record<BookmarkKindDto, string> = { line: '🔖', file: '📄', dir: '📁' };

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function BookmarksPanel() {
  const { t } = useLang();
  const [bookmarks, setBookmarks] = useState<BookmarkDtoItem[]>([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dirFilter, setDirFilter] = useState<string>('all');
  const [jumpInfo, setJumpInfo] = useState<{ id: string; status: BookmarkRelocationStatus } | null>(null);
  // add form
  const [showAdd, setShowAdd] = useState(false);
  const [kind, setKind] = useState<BookmarkKindDto>('line');
  const [path, setPath] = useState('');
  const [line, setLine] = useState('1');
  const [mnemonic, setMnemonic] = useState('');
  const [label, setLabel] = useState('');
  // inline rename
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // mnemonic editing
  const [mnEdit, setMnEdit] = useState<string | null>(null);
  const [mnValue, setMnValue] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { root: r, bookmarks: bs } = await api.bookmarksList();
      setRoot(r);
      setBookmarks(bs);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(BOOKMARKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(BOOKMARKS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const dirs = useMemo(() => {
    const s = new Set<string>();
    for (const b of bookmarks) s.add(dirOf(b.path));
    return [...s].sort();
  }, [bookmarks]);

  const visible = useMemo(
    () => (dirFilter === 'all' ? bookmarks : bookmarks.filter((b) => dirOf(b.path) === dirFilter)),
    [bookmarks, dirFilter],
  );

  const jump = useCallback(
    async (b: BookmarkDtoItem) => {
      setJumpInfo(null);
      try {
        const r = await api.bookmarksResolve(b.id);
        setJumpInfo({ id: b.id, status: r.status });
        if (r.status === 'drifted') return; // honest: do not jump to a stale line
        openInEditor(r.path, r.line);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  // bookmark.jump.<mnemonic> commands arrive on the S1 command bus.
  useEffect(
    () =>
      onCommand((commandId) => {
        const mn = mnemonicForJumpCommand(commandId);
        if (!mn) return;
        const target = bookmarks.find((b) => b.mnemonic === mn);
        if (target) void jump(target);
      }),
    [bookmarks, jump],
  );

  const doAdd = useCallback(async () => {
    if (!path.trim()) return;
    setErr(null);
    try {
      await api.bookmarksAdd({
        kind,
        path: path.trim(),
        ...(kind === 'line' ? { line: Math.max(1, parseInt(line, 10) || 1) } : {}),
        ...(mnemonic ? { mnemonic } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setShowAdd(false);
      setPath('');
      setLine('1');
      setMnemonic('');
      setLabel('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [kind, path, line, mnemonic, label, refresh]);

  const doDelete = useCallback(
    async (id: string) => {
      try {
        await api.bookmarksDelete(id);
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const doRename = useCallback(
    async (id: string) => {
      try {
        await api.bookmarksPatch(id, { label: renameValue.trim() });
        setRenaming(null);
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [renameValue, refresh],
  );

  const doMnemonic = useCallback(
    async (id: string) => {
      try {
        await api.bookmarksPatch(id, { mnemonic: mnValue ? mnValue : null });
        setMnEdit(null);
        await refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [mnValue, refresh],
  );

  return (
    <div className="bookmarks-panel">
      <div className="bookmarks-toolbar">
        <select
          aria-label={t('bookmark.dirFilter')}
          value={dirFilter}
          onChange={(e) => setDirFilter(e.target.value)}
        >
          <option value="all">{t('bookmark.allDirs')}</option>
          {dirs.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button type="button" onClick={() => setShowAdd((v) => !v)}>
          {t('bookmark.add')}
        </button>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {t('bookmark.refresh')}
        </button>
        <span className="bookmarks-hint" title={t('bookmark.toggleHint')}>
          {t('bookmark.toggleHintShort')}
        </span>
      </div>
      {root && <div className="bookmarks-root">{t('bookmark.root', { root })}</div>}
      {err && <div className="bookmarks-error">{err}</div>}
      {showAdd && (
        <div className="bookmarks-add">
          <select value={kind} onChange={(e) => setKind(e.target.value as BookmarkKindDto)}>
            <option value="line">{t('bookmark.kindLine')}</option>
            <option value="file">{t('bookmark.kindFile')}</option>
            <option value="dir">{t('bookmark.kindDir')}</option>
          </select>
          <input
            placeholder={t('bookmark.pathPlaceholder')}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          {kind === 'line' && (
            <input
              placeholder={t('bookmark.linePlaceholder')}
              value={line}
              inputMode="numeric"
              onChange={(e) => setLine(e.target.value)}
              style={{ width: 70 }}
            />
          )}
          <select value={mnemonic} onChange={(e) => setMnemonic(e.target.value)}>
            <option value="">{t('bookmark.noMnemonic')}</option>
            {BOOKMARK_MNEMONICS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            placeholder={t('bookmark.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button type="button" onClick={() => void doAdd()}>{t('bookmark.save')}</button>
        </div>
      )}
      <div className="bookmarks-list">
        {visible.length === 0 && !loading && (
          <div className="bookmarks-empty">{t('bookmark.empty')}</div>
        )}
        {visible.map((b) => (
          <div className="bookmarks-row" key={b.id}>
            <span className="bookmarks-kind" title={b.kind}>{KIND_ICON[b.kind]}</span>
            {b.mnemonic && <kbd className="bookmarks-mn" title={t('bookmark.mnemonicTitle')}>{b.mnemonic}</kbd>}
            <button type="button" className="bookmarks-jump" onClick={() => void jump(b)} title={t('bookmark.jumpTitle')}>
              {renaming === b.id ? (
                <input
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doRename(b.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="bookmarks-label">{b.label}</span>
              )}
              <span className="bookmarks-path">
                {b.path}{b.kind === 'line' && b.line ? `:${b.line}` : ''}
              </span>
            </button>
            {jumpInfo?.id === b.id && jumpInfo.status !== 'ok' && (
              <span
                className={`bookmarks-drift bookmarks-drift-${jumpInfo.status}`}
                title={t(`bookmark.driftHint.${jumpInfo.status}`)}
              >
                {t(`bookmark.drift.${jumpInfo.status}`)}
              </span>
            )}
            {b.tags.length > 0 && (
              <span className="bookmarks-tags">{b.tags.join(', ')}</span>
            )}
            <span className="bookmarks-actions">
              <button type="button" title={t('bookmark.rename')} onClick={() => { setRenaming(b.id); setRenameValue(b.label); }}>✎</button>
              <button
                type="button"
                title={t('bookmark.setMnemonic')}
                onClick={() => { setMnEdit(mnEdit === b.id ? null : b.id); setMnValue(b.mnemonic ?? ''); }}
              >
                #
              </button>
              <button type="button" title={t('bookmark.delete')} onClick={() => void doDelete(b.id)}>🗑</button>
            </span>
            {renaming === b.id && (
              <span className="bookmarks-inline-actions">
                <button type="button" onClick={() => void doRename(b.id)}>{t('bookmark.save')}</button>
                <button type="button" onClick={() => setRenaming(null)}>{t('bookmark.cancel')}</button>
              </span>
            )}
            {mnEdit === b.id && (
              <span className="bookmarks-inline-actions">
                <select value={mnValue} onChange={(e) => setMnValue(e.target.value)}>
                  <option value="">{t('bookmark.noMnemonic')}</option>
                  {BOOKMARK_MNEMONICS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <button type="button" onClick={() => void doMnemonic(b.id)}>{t('bookmark.save')}</button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="bookmarks-footnote">{t('bookmark.footnote')}</div>
    </div>
  );
}
