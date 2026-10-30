import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type NotebookCell,
  type NotebookDoc,
  type NotebookMeta,
  type ScratchLanguageDef,
} from '../api';
import { useLang } from '../i18n';
import monaco from '../monacoSetup';

/**
 * Notebook panel (round-7 task R7-#2) — interactive cells: code cells run
 * through the shared exec safety channel, markdown cells render.
 *
 * HONEST BOUNDARIES (rendered in the UI footer):
 *  - No Jupyter kernel: each code cell runs as its own `node` process.
 *    There is NO shared kernel state between cells — run-all is
 *    ordering, not a session.
 *  - Only node-runnable languages (TypeScript/JavaScript) can run — the
 *    shared exec safety policy whitelists 'node' only. Markdown cells
 *    never execute.
 *  - Running executes arbitrary code: it is explicit user action, never
 *    automatic. Env is credential-scrubbed; output is capped at 64K
 *    chars per stream with a truncation note.
 *  - Notebooks are NOT git-tracked, NOT indexed, NOT snapshotted, NOT
 *    audited; notebook content is NOT covered by the pre-send prompt
 *    secret scan — do not paste secrets into a notebook.
 */

/** Minimal safe markdown renderer: escape first, then block/inline marks. */
export function renderMarkdown(src: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out: string[] = [];
  let list: string[] = [];
  const flushList = (): void => {
    if (list.length) {
      out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      list = [];
    }
  };
  for (const line of src.split('\n')) {
    if (line.startsWith('### ')) {
      flushList();
      out.push(`<h4>${inline(line.slice(4))}</h4>`);
    } else if (line.startsWith('## ')) {
      flushList();
      out.push(`<h3>${inline(line.slice(3))}</h3>`);
    } else if (line.startsWith('# ')) {
      flushList();
      out.push(`<h3>${inline(line.slice(2))}</h3>`);
    } else if (line.startsWith('- ')) {
      list.push(line.slice(2));
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flushList();
  return out.join('');
}

const MONACO_OF: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  markdown: 'markdown',
};

export function NotebookPanel() {
  const { t } = useLang();
  const [notebooks, setNotebooks] = useState<NotebookMeta[]>([]);
  const [languages, setLanguages] = useState<ScratchLanguageDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [runningCell, setRunningCell] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newLang, setNewLang] = useState('typescript');
  const [newName, setNewName] = useState('');
  const [stripExport, setStripExport] = useState(true);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectedCellRef = useRef<string | null>(null);
  selectedCellRef.current = selectedCellId;

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { notebooks: list, languages: langs } = await api.notebooksList();
      setNotebooks(list);
      setLanguages(langs);
      if (!selectedId && list.length > 0) setSelectedId(list[0]!.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

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
      if (selectedCellRef.current) setDirty(true);
    });
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  const openNotebook = useCallback(async (id: string) => {
    setErr(null);
    try {
      const { notebook } = await api.notebookGet(id);
      setSelectedId(id);
      setDoc(notebook);
      const first = notebook.cells[0] ?? null;
      setSelectedCellId(first ? first.id : null);
      const editor = editorRef.current;
      if (editor && first) {
        const model = editor.getModel();
        if (model) {
          model.setValue(first.source);
          monaco.editor.setModelLanguage(model, MONACO_OF[first.language] ?? 'plaintext');
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void openNotebook(selectedId);
  }, [selectedId, openNotebook]);

  const selectCell = useCallback(
    (cell: NotebookCell) => {
      setSelectedCellId(cell.id);
      setDirty(false);
      const editor = editorRef.current;
      if (editor) {
        const model = editor.getModel();
        if (model) {
          model.setValue(cell.source);
          monaco.editor.setModelLanguage(model, MONACO_OF[cell.language] ?? 'plaintext');
        }
      }
    },
    [],
  );

  const create = useCallback(async () => {
    setErr(null);
    try {
      const { notebook } = await api.notebookCreate({
        language: newLang,
        name: newName.trim() || undefined,
      });
      setNewName('');
      await load();
      setSelectedId(notebook.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [load, newLang, newName]);

  const removeNotebook = useCallback(
    async (id: string) => {
      setErr(null);
      try {
        await api.notebookDelete(id);
        if (selectedId === id) {
          setSelectedId(null);
          setDoc(null);
          setSelectedCellId(null);
        }
        await load();
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [load, selectedId],
  );

  const addCell = useCallback(
    async (kind: 'code' | 'markdown', afterId?: string) => {
      if (!selectedId || !doc) return;
      setErr(null);
      try {
        const { notebook, cellId } = await api.notebookAddCell(selectedId, {
          kind,
          language: kind === 'markdown' ? 'markdown' : undefined,
          afterId,
        });
        setDoc(notebook);
        const cell = notebook.cells.find((c) => c.id === cellId);
        if (cell) selectCell(cell);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [selectedId, doc, selectCell],
  );

  const saveCell = useCallback(async () => {
    if (!selectedId || !selectedCellId) return;
    setErr(null);
    try {
      const text = editorRef.current ? editorRef.current.getValue() : '';
      const { notebook } = await api.notebookUpdateCell(selectedId, selectedCellId, text);
      setDoc(notebook);
      setDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [selectedId, selectedCellId]);

  const deleteCell = useCallback(
    async (cellId: string) => {
      if (!selectedId) return;
      setErr(null);
      try {
        const { notebook } = await api.notebookDeleteCell(selectedId, cellId);
        setDoc(notebook);
        if (selectedCellId === cellId) setSelectedCellId(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [selectedId, selectedCellId],
  );

  const moveCell = useCallback(
    async (cellId: string, direction: 'up' | 'down') => {
      if (!selectedId) return;
      setErr(null);
      try {
        const { notebook } = await api.notebookMoveCell(selectedId, cellId, { direction });
        setDoc(notebook);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [selectedId],
  );

  const runCell = useCallback(
    async (cellId: string) => {
      if (!selectedId) return;
      setErr(null);
      setRunningCell(cellId);
      try {
        const { notebook } = await api.notebookRunCell(selectedId, cellId);
        setDoc(notebook);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setRunningCell(null);
      }
    },
    [selectedId],
  );

  const runAll = useCallback(async () => {
    if (!selectedId) return;
    setErr(null);
    setRunningAll(true);
    try {
      const { notebook } = await api.notebookRunAll(selectedId);
      setDoc(notebook);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunningAll(false);
    }
  }, [selectedId]);

  const clearOutputs = useCallback(async () => {
    if (!selectedId) return;
    setErr(null);
    try {
      const { notebook } = await api.notebookClearOutputs(selectedId);
      setDoc(notebook);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [selectedId]);

  const exportDoc = useCallback(async () => {
    if (!selectedId || !doc) return;
    setErr(null);
    try {
      const { notebook } = await api.notebookExport(selectedId, stripExport);
      const blob = new Blob([JSON.stringify(notebook, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${doc.name.replace(/[^\w-]+/g, '_')}.notebook.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [selectedId, doc, stripExport]);

  const selectedCell = doc?.cells.find((c) => c.id === selectedCellId) ?? null;

  return (
    <div className="notebook-panel">
      <div className="panel-row">
        <select value={newLang} onChange={(e) => setNewLang(e.target.value)} aria-label={t('notebook.language')}>
          {languages
            .filter((l) => l.id !== 'markdown')
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
        </select>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('notebook.namePlaceholder')}
        />
        <button onClick={() => void create()}>{t('notebook.create')}</button>
        <button onClick={() => void load()} disabled={loading}>
          {t('notebook.refresh')}
        </button>
      </div>
      {err && <div className="panel-error">{err}</div>}
      <div className="panel-split">
        <div className="panel-list">
          {notebooks.length === 0 && <div className="muted">{t('notebook.empty')}</div>}
          {notebooks.map((n) => (
            <div key={n.id} className={selectedId === n.id ? 'panel-list-item active' : 'panel-list-item'}>
              <button onClick={() => setSelectedId(n.id)}>
                {n.name} ({n.cellCount})
              </button>
              <button onClick={() => void removeNotebook(n.id)} title={t('notebook.delete')}>
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="panel-main">
          {!doc && <div className="muted">{t('notebook.selectHint')}</div>}
          {doc && (
            <>
              <div className="panel-row">
                <strong>{doc.name}</strong>
                <span className="muted">
                  {t('notebook.cellCount', { count: doc.cells.length })}
                </span>
                <button onClick={() => void addCell('code')}>{t('notebook.addCode')}</button>
                <button onClick={() => void addCell('markdown')}>{t('notebook.addMarkdown')}</button>
                <button onClick={() => void runAll()} disabled={runningAll}>
                  {runningAll ? t('notebook.running') : t('notebook.runAll')}
                </button>
                <button onClick={() => void clearOutputs()}>{t('notebook.clearOutputs')}</button>
                <label>
                  <input
                    type="checkbox"
                    checked={stripExport}
                    onChange={(e) => setStripExport(e.target.checked)}
                  />
                  {t('notebook.stripOnExport')}
                </label>
                <button onClick={() => void exportDoc()}>{t('notebook.export')}</button>
              </div>
              {doc.cells.map((cell) => (
                <div
                  key={cell.id}
                  className={selectedCellId === cell.id ? 'nb-cell active' : 'nb-cell'}
                  onClick={() => selectCell(cell)}
                >
                  <div className="panel-row">
                    <span className="muted">
                      {cell.kind === 'code' ? t('notebook.codeCell') : t('notebook.markdownCell')}
                      {' · '}
                      {cell.language}
                    </span>
                    {cell.run && (
                      <span className="muted">
                        {cell.run.ok
                          ? t('notebook.runOk', { ms: cell.run.durationMs })
                          : t('notebook.runFailed', { code: cell.run.exitCode ?? '?' })}
                        {cell.run.timedOut ? ` (${t('notebook.timedOut')})` : ''}
                      </span>
                    )}
                    {cell.kind === 'code' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void runCell(cell.id);
                        }}
                        disabled={runningCell === cell.id}
                      >
                        {runningCell === cell.id ? t('notebook.running') : t('notebook.run')}
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void moveCell(cell.id, 'up');
                      }}
                    >
                      ↑
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void moveCell(cell.id, 'down');
                      }}
                    >
                      ↓
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteCell(cell.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {cell.kind === 'markdown' ? (
                    <div
                      className="nb-markdown"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source) }}
                    />
                  ) : (
                    <pre className="nb-source">{cell.source}</pre>
                  )}
                  {cell.outputs.map((o, i) => (
                    <pre key={i} className={o.kind === 'stderr' ? 'nb-output stderr' : 'nb-output'}>
                      {o.text}
                      {o.truncated ? `\n… ${t('notebook.truncated')}` : ''}
                    </pre>
                  ))}
                </div>
              ))}
              {selectedCell && (
                <>
                  <div ref={hostRef} style={{ height: 220, border: '1px solid #333' }} />
                  <div className="panel-row">
                    <button onClick={() => void saveCell()} disabled={!dirty}>
                      {t('notebook.save')}
                    </button>
                    {dirty && <span className="muted">{t('notebook.unsaved')}</span>}
                  </div>
                </>
              )}
              <div className="panel-footer muted">
                <p>{t('notebook.warningNoKernel')}</p>
                <p>{t('notebook.warningSecrets')}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
