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
import { authHeaders } from '../api';
import monaco, { languageOf } from '../monacoSetup';

const API_BASE = 'http://localhost:3100/api';

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

export function EditorPanel() {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [root, setRoot] = useState('.');
  const [dirs, setDirs] = useState<Record<string, DirCache>>({});
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const openPathRef = useRef<string | null>(null);
  openPathRef.current = openPath;

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
      setErr(e instanceof Error ? e.message : 'failed to list files');
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
      editor.setModel(
        monaco.editor.createModel(body.content, languageOf(path), monaco.Uri.parse(`inmemory://workspace/${path}`)),
      );
      old?.dispose();
      setOpenPath(path);
      setDirty(false);
      setStatus('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to open file');
      setStatus('');
    }
  }, []);

  const saveFile = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || !openPath) return;
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ path: openPath, content: editor.getValue() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setDirty(false);
      setStatus(`Saved ${openPath}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save failed');
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
        <b>Editor</b> <span className="muted">§65 · Monaco</span>
        {openPath && (
          <>
            <span className="pill" style={{ fontFamily: 'monospace' }}>{openPath}</span>
            {dirty && <span className="pill">unsaved</span>}
            <button onClick={() => void saveFile()} disabled={!dirty}>
              Save (Ctrl+S)
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
              placeholder="workspace root…"
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
