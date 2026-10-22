import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ScratchFile, type ScratchLanguageDef, type ScratchMeta, type ScratchRunResult } from '../api';
import { useLang } from '../i18n';
import monaco from '../monacoSetup';

/**
 * Scratch files panel (round-5 task R5-B10) — temporary draft buffers
 * outside any project tree (AI_FACTORY_DATA_DIR/scratches/).
 *
 * HONEST BOUNDARIES (rendered in the UI footer):
 *  - Scratches are NOT git-tracked, NOT indexed, NOT snapshotted, NOT
 *    audited; closing the IDE never deletes them; there is no cloud sync.
 *  - Only node-runnable languages (TypeScript/JavaScript) can run — the
 *    shared exec safety policy whitelists 'node' only. Everything else
 *    is edit-only.
 *  - Running executes arbitrary code: it is explicit user action, never
 *    automatic. Env is credential-scrubbed; output is capped at 512KB.
 *  - Scratch content is NOT covered by the pre-send prompt secret scan —
 *    do not paste secrets into a scratch.
 */

const MONACO_OF: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
  markdown: 'markdown',
  plaintext: 'plaintext',
};

export function ScratchesPanel() {
  const { t } = useLang();
  const [scratches, setScratches] = useState<ScratchMeta[]>([]);
  const [languages, setLanguages] = useState<ScratchLanguageDef[]>([]);
  const [filterLang, setFilterLang] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newLang, setNewLang] = useState('typescript');
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [runResult, setRunResult] = useState<ScratchRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { scratches: list, languages: langs } = await api.scratchesList();
      setScratches(list);
      setLanguages(langs);
      if (!selectedRef.current && list.length > 0) {
        setSelectedId(list[0]!.id);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // --- Monaco lifecycle -------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host || editorRef.current) return;
    const editor = monaco.editor.create(host, {
      value: '',
      language: 'typescript',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
    });
    editorRef.current = editor;
    editor.onDidChangeModelContent(() => {
      if (selectedRef.current) setDirty(true);
    });
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  const openScratch = useCallback(
    async (id: string) => {
      setErr(null);
      setRunResult(null);
      try {
        const { scratch }: { scratch: ScratchFile } = await api.scratchGet(id);
        setSelectedId(id);
        setContent(scratch.content);
        setDirty(false);
        const editor = editorRef.current;
        if (editor) {
          const model = editor.getModel();
          if (model) {
            model.setValue(scratch.content);
            monaco.editor.setModelLanguage(model, MONACO_OF[scratch.language] ?? 'plaintext');
          }
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedId) void openScratch(selectedId);
  }, [selectedId, openScratch]);

  const create = useCallback(async () => {
    setErr(null);
    try {
      const { scratch } = await api.scratchCreate({
        language: newLang,
        name: newName.trim() || undefined,
      });
      setNewName('');
      await load();
      setSelectedId(scratch.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [newLang, newName, load]);

  const save = useCallback(async () => {
    if (!selectedId) return;
    setErr(null);
    try {
      const editor = editorRef.current;
      const text = editor ? editor.getValue() : content;
      await api.scratchUpdate(selectedId, { content: text });
      setContent(text);
      setDirty(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [selectedId, content, load]);

  const commitRename = useCallback(async () => {
    if (!selectedId) return;
    setErr(null);
    try {
      await api.scratchUpdate(selectedId, { name: renameValue.trim() });
      setRenaming(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [selectedId, renameValue, load]);

  const remove = useCallback(async () => {
    if (!selectedId) return;
    if (!window.confirm(t('scratch.confirmDelete'))) return;
    setErr(null);
    try {
      await api.scratchDelete(selectedId);
      setSelectedId(null);
      setContent('');
      setRunResult(null);
      const editor = editorRef.current;
      editor?.getModel()?.setValue('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [selectedId, load, t]);

  const run = useCallback(async () => {
    if (!selectedId) return;
    setErr(null);
    setRunning(true);
    setRunResult(null);
    try {
      if (dirty) await save();
      const { run: result } = await api.scratchRun(selectedId);
      setRunResult(result);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [selectedId, dirty, save]);

  const selected = scratches.find((s) => s.id === selectedId) ?? null;
  const selectedLang = languages.find((l) => l.id === selected?.language) ?? null;
  const visible = filterLang === 'all' ? scratches : scratches.filter((s) => s.language === filterLang);

  return (
    <div className="scratches-panel">
      <div className="scratches-left">
        <div className="scratches-new">
          <select value={newLang} onChange={(e) => setNewLang(e.target.value)} aria-label={t('scratch.language')}>
            {languages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('scratch.namePlaceholder')}
            maxLength={80}
          />
          <button onClick={() => void create()}>{t('scratch.create')}</button>
        </div>
        <div className="scratches-filter">
          <select value={filterLang} onChange={(e) => setFilterLang(e.target.value)} aria-label={t('scratch.filter')}>
            <option value="all">{t('scratch.filterAll')}</option>
            {languages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        {loading && <div className="scratches-empty">{t('scratch.loading')}</div>}
        {!loading && visible.length === 0 && <div className="scratches-empty">{t('scratch.empty')}</div>}
        <ul className="scratches-list">
          {visible.map((s) => (
            <li key={s.id} className={s.id === selectedId ? 'active' : ''}>
              <button className="scratch-item" onClick={() => setSelectedId(s.id)}>
                <span className="scratch-name">{s.name}</span>
                <span className="scratch-lang">{s.language}</span>
                <span className="scratch-date">{new Date(s.updatedAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="scratches-right">
        {err && <div className="scratches-error">{err}</div>}
        {!selected && <div className="scratches-empty">{t('scratch.selectHint')}</div>}
        {selected && (
          <>
            <div className="scratches-toolbar">
              {renaming ? (
                <>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    maxLength={80}
                    autoFocus
                  />
                  <button onClick={() => void commitRename()}>{t('scratch.renameConfirm')}</button>
                  <button onClick={() => setRenaming(false)}>{t('scratch.cancel')}</button>
                </>
              ) : (
                <>
                  <strong>{selected.name}</strong>
                  <span className="scratch-lang">{selected.language}</span>
                  {dirty && <span className="scratch-dirty">{t('scratch.unsaved')}</span>}
                  <button onClick={() => void save()} disabled={!dirty}>
                    {t('scratch.save')}
                  </button>
                  <button
                    onClick={() => {
                      setRenameValue(selected.name);
                      setRenaming(true);
                    }}
                  >
                    {t('scratch.rename')}
                  </button>
                  <button onClick={() => void remove()}>{t('scratch.delete')}</button>
                  {selectedLang?.runnable ? (
                    <button onClick={() => void run()} disabled={running}>
                      {running ? t('scratch.running') : t('scratch.run')}
                    </button>
                  ) : (
                    <span className="scratch-editonly" title={t('scratch.editOnlyTip')}>
                      {t('scratch.editOnly')}
                    </span>
                  )}
                </>
              )}
            </div>
            <div ref={hostRef} className="scratches-editor" />
            {runResult && (
              <div className="scratches-output">
                <div className="scratches-output-head">
                  {t('scratch.exitCode')}: {runResult.exitCode ?? '—'}
                  {runResult.timedOut && ` (${t('scratch.timedOut')})`}
                  {runResult.truncated && ` (${t('scratch.truncated')})`}
                  {!runResult.ok && !runResult.timedOut && ` (${t('scratch.failed')})`}
                </div>
                {runResult.stdout && <pre className="out">{runResult.stdout}</pre>}
                {runResult.stderr && <pre className="err">{runResult.stderr}</pre>}
                {!runResult.stdout && !runResult.stderr && (
                  <div className="scratches-empty">{t('scratch.noOutput')}</div>
                )}
              </div>
            )}
          </>
        )}
        <div className="scratches-boundaries">{t('scratch.boundaries')}</div>
      </div>
    </div>
  );
}
