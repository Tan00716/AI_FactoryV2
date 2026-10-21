/**
 * EditorPanel — spec §65 (code editor, Monaco recommended).
 *
 * Real Monaco editor with:
 *  - syntax highlighting chosen from the file extension (monacoSetup.languageOf)
 *  - workspace file browser backed by /api/files and /api/file (routes/files.ts)
 *  - save back to the workspace (Ctrl/Cmd+S)
 *
 * Diff views for the Change Review UI (§66) live in DiffViewer.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';
import monaco, { languageOf } from '../monacoSetup';
import { editorCursor } from '../editorCursor';

const API_BASE = defaultApiBase();

interface Entry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

interface DirCache {
  entries: Entry[];
  expanded: boolean;
}

function FileIcon({ type }: { type: 'dir' | 'file' }) {
  return <span style={{ marginRight: 6 }}>{type === 'dir' ? '📁' : '📄'}</span>;
}

/**
 * Design panel (task ⑨) can ask the editor to open a file at a line via
 * the `openRequest` prop — App.tsx sets it from the
 * 'ai-factory:open-file' CustomEvent.
 */
export function EditorPanel({
  openRequest,
}: {
  openRequest?: { path: string; line: number; nonce: number } | null;
}) {
  const { t } = useLang();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const openRequestRef = useRef(openRequest);
  openRequestRef.current = openRequest;
  const [root, setRoot] = useState('.');
  const [dirs, setDirs] = useState<Record<string, DirCache>>({});
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const openPathRef = useRef<string | null>(null);
  openPathRef.current = openPath;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // --- Monaco lifecycle -------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value: '// Open a file from the workspace tree on the left.\n',
      language: 'typescript',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
    });
    editorRef.current = editor;
    editor.onDidChangeModelContent(() => {
      if (openPathRef.current) setDirty(true);
    });
    // Task ⑨: feed the Design panel's code→preview lookup (editorCursor.ts).
    editor.onDidChangeCursorPosition((e) => {
      if (openPathRef.current) editorCursor.line = e.position.lineNumber;
    });
    // An open-request may have arrived while the Editor tab was unmounted.
    const pending = openRequestRef.current;
    if (pending) {
      void (async () => {
        await openFileRef.current(pending.path);
        const ed = editorRef.current;
        if (ed) {
          ed.revealLineInCenter(pending.line);
          ed.setPosition({ lineNumber: pending.line, column: 1 });
        }
      })();
    }
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // --- file tree ---------------------------------------------------------
  const loadDir = useCallback(async (dir: string) => {
    setDirs((d) => ({ ...d, [dir]: d[dir] ?? { entries: [], expanded: true } }));
    try {
      const res = await fetch(`${API_BASE}/files?root=${encodeURIComponent(dir)}`, { headers: { ...authHeaders() } });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as { entries: Entry[] };
      setDirs((d) => ({ ...d, [dir]: { entries: body.entries, expanded: true } }));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('editor.listFailed'));
    }
  }, []);

  useEffect(() => {
    void loadDir(root);
  }, [loadDir, root]);

  const toggleDir = (dir: string) => {
    const cache = dirs[dir];
    if (!cache) {
      void loadDir(dir);
      return;
    }
    setDirs((d) => ({ ...d, [dir]: { ...cache, expanded: !cache.expanded } }));
  };

  const openFile = useCallback(async (path: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    setErr(null);
    setStatus(`Opening ${path}…`);
    try {
      const res = await fetch(`${API_BASE}/file?path=${encodeURIComponent(path)}`, { headers: { ...authHeaders() } });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as { content: string };
      const old = editor.getModel();
      // Reopening the same path must not throw "Model already exists":
      // reuse the model registered for the URI and refresh its content.
      const uri = monaco.Uri.parse(`inmemory://workspace/${path}`);
      const existing = monaco.editor.getModel(uri);
      const model = existing ?? monaco.editor.createModel(body.content, languageOf(path), uri);
      if (existing) existing.setValue(body.content);
      editor.setModel(model);
      if (old && old !== model) old.dispose();
      setOpenPath(path);
      editorCursor.path = path;
      editorCursor.line = 1;
      setDirty(false);
      setStatus('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('editor.openFailed'));
      setStatus('');
    }
  }, []);

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // Task ⑨: open-request while already mounted (the Monaco mount effect
  // covers the request that arrived before the editor existed).
  useEffect(() => {
    if (!openRequest || !editorRef.current) return;
    void (async () => {
      await openFile(openRequest.path);
      const ed = editorRef.current;
      if (ed) {
        ed.revealLineInCenter(openRequest.line);
        ed.setPosition({ lineNumber: openRequest.line, column: 1 });
        ed.focus();
      }
    })();
  }, [openRequest, openFile]);

  const saveFile = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || !openPath) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ path: openPath, content: editor.getValue() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setDirty(false);
      setStatus(t('editor.saved', { path: openPath }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('editor.saveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [openPath]);

  // Ctrl/Cmd+S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveFile]);

  const renderEntries = (dir: string, depth: number): React.ReactNode[] => {
    const cache = dirs[dir];
    if (!cache || !cache.expanded) return [];
    if (cache.entries.length === 0) {
      return [
        <div key={`${dir}:empty`} className="muted" style={{ padding: '3px 8px', paddingLeft: 8 + depth * 14, fontSize: 12 }}>
          {t('editor.dirEmpty')}
        </div>,
      ];
    }
    return cache.entries.map((e) => (
      <div key={e.path}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => (e.type === 'dir' ? toggleDir(e.path) : void openFile(e.path))}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') e.type === 'dir' ? toggleDir(e.path) : void openFile(e.path);
          }}
          style={{
            padding: '3px 8px',
            paddingLeft: 8 + depth * 14,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'monospace',
            background: openPath === e.path ? 'var(--bg3)' : undefined,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <FileIcon type={e.type} />
          {e.name}
        </div>
        {e.type === 'dir' && renderEntries(e.path, depth + 1)}
      </div>
    ));
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <b>{t('editor.title')}</b> <span className="muted">§65 · Monaco</span>
        {openPath && (
          <>
            <span className="pill" style={{ fontFamily: 'monospace' }}>{openPath}</span>
            {dirty && <span className="pill">{t('editor.unsaved')}</span>}
            <button onClick={() => void saveFile()} disabled={!dirty || saving}>
              {saving ? t('editor.saving') : t('editor.save')}
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        {status && <span className="muted" style={{ fontSize: 12 }}>{status}</span>}
      </div>
      {err && <div className="banner err">{err}</div>}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: 260, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '6px 0' }}>
          <div style={{ padding: '0 8px 6px', display: 'flex', gap: 6 }}>
            <input
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder={t('editor.rootPlaceholder')}
              style={{ flex: 1, padding: 4, fontSize: 12 }}
            />
            <button onClick={() => void loadDir(root)} style={{ fontSize: 12 }}>↻</button>
          </div>
          {renderEntries(root, 0)}
        </div>
        <div ref={hostRef} style={{ flex: 1, minWidth: 0 }} />
      </div>
    </div>
  );
}
