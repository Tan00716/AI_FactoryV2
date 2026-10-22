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
import { defaultApiBase, authHeaders, api, type TodoItem, type TrojanHit, type BlameLineDto } from '../api';
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

interface SnapshotMeta {
  id: string;
  createdAt: string;
  kind: 'save' | 'pre-restore';
  size: number;
}

/**
 * R3-T9 file nesting (VS Code fileNesting 式, 文件名模式分组).
 * 可配的父子文件名模式: `*` 匹配父文件名中的 stem, 子模式中的 `*`
 * 替换为同一 stem 后必须与子文件名完全一致. 纯文件名模式, 不做语义分析.
 */
const FILE_NESTING_RULES: Array<{ parent: string; children: string[] }> = [
  { parent: 'package.json', children: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] },
  { parent: '*.ts', children: ['*.d.ts', '*.test.ts', '*.spec.ts', '*.stories.ts'] },
  { parent: '*.tsx', children: ['*.test.tsx', '*.spec.tsx', '*.stories.tsx'] },
  { parent: '*.js', children: ['*.test.js', '*.spec.js'] },
  { parent: '*.jsx', children: ['*.test.jsx', '*.spec.jsx'] },
];

const STICKY_SCROLL_KEY = 'ai-factory.editor.stickyScroll';

function readStickyScrollPref(): boolean {
  try {
    const v = localStorage.getItem(STICKY_SCROLL_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

/** 父模式命中时返回 stem (无 `*` 的精确模式返回 ''), 未命中返回 null. */
function matchParentPattern(pattern: string, name: string): string | null {
  if (!pattern.includes('*')) return pattern === name ? '' : null;
  const rx = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)') + '$');
  const m = rx.exec(name);
  return m ? m[1] : null;
}

function isNestingChild(parentName: string, childName: string): boolean {
  if (parentName === childName) return false;
  for (const rule of FILE_NESTING_RULES) {
    const stem = matchParentPattern(rule.parent, parentName);
    if (stem === null) continue;
    for (const cp of rule.children) {
      if (cp.split('*').join(stem) === childName) return true;
    }
  }
  return false;
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
  // R3-T9 Sticky scroll: Monaco 内置吸顶 (默认开, localStorage 持久化).
  const [stickyOn, setStickyOn] = useState<boolean>(readStickyScrollPref);
  // R3-T6 Local History: per-save snapshot browser + restore.
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<SnapshotMeta[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const showHistoryRef = useRef(false);
  showHistoryRef.current = showHistory;

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
      // R4-B9: glyph margin hosts TODO/FIXME markers (todo-glyph-* CSS).
      glyphMargin: true,
      // R3-T9: Monaco 内置粘性滚动 (VS Code stickyScroll 式), 不做自定义吸顶.
      stickyScroll: { enabled: readStickyScrollPref(), maxLineCount: 10 },
    });
    editorRef.current = editor;
    editor.onDidChangeModelContent(() => {
      if (openPathRef.current) setDirty(true);
    });
    // Task ⑨: feed the Design panel's code→preview lookup (editorCursor.ts).
    editor.onDidChangeCursorPosition((e) => {
      if (openPathRef.current) editorCursor.line = e.position.lineNumber;
      // R5-A4: current-line blame annotation (best-effort).
      renderBlameLine(editor, e.position.lineNumber);
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

  // R4-B9 TODO gutter + overview-ruler markers. Best-effort: a failed
  // fetch clears stale markers but never breaks editing.
  const todoDecorIdsRef = useRef<string[]>([]);
  const refreshTodoDecorations = useCallback(
    async (editor: monaco.editor.IStandaloneCodeEditor, path: string) => {
      const colors: Record<TodoItem['severity'], string> = {
        error: '#f14c4c',
        warning: '#cca700',
        info: '#3794ff',
      };
      try {
        const { items } = await api.todoFileItems(path);
        const decs = items.slice(0, 200).map((it) => ({
          range: new monaco.Range(it.line, 1, it.line, 1),
          options: {
            glyphMarginClassName: `todo-glyph todo-glyph-${it.severity}`,
            glyphMarginHoverMessage: { value: `**${it.tag}**${it.message ? ` — ${it.message}` : ''}` },
            overviewRuler: {
              color: colors[it.severity],
              position: monaco.editor.OverviewRulerLane.Right,
            },
          },
        }));
        todoDecorIdsRef.current = editor.deltaDecorations(todoDecorIdsRef.current, decs);
      } catch {
        todoDecorIdsRef.current = editor.deltaDecorations(todoDecorIdsRef.current, []);
      }
    },
    [],
  );

  // R5-A5 Trojan Source 防护：可疑 Unicode 字符内联高亮 + 悬停码点。
  // Best-effort：扫描失败清掉旧标记，绝不打断编辑。只在打开文件时扫一次
  // （快照语义）；悬停显示码点/字符名/类别——只标注、不自动改写。
  const trojanDecorIdsRef = useRef<string[]>([]);
  const refreshTrojanDecorations = useCallback(
    async (editor: monaco.editor.IStandaloneCodeEditor, path: string, text: string) => {
      const kindLabel: Record<TrojanHit['kind'], string> = {
        'bidi-control': t('trojan.kindBidi'),
        'zero-width': t('trojan.kindZeroWidth'),
        confusable: t('trojan.kindConfusable'),
      };
      try {
        const { findings } = await api.trojanScanText(path, text);
        const decs = findings.slice(0, 200).map((f) => {
          const extra =
            f.kind === 'confusable' && f.script && f.latin
              ? ` (${t('trojan.looksLike')} '${f.latin}', ${f.script})`
              : '';
          return {
            range: new monaco.Range(f.line, f.column, f.line, f.column + f.length),
            options: {
              inlineClassName: `trojan-hit trojan-hit-${f.kind === 'bidi-control' ? 'bidi' : f.kind === 'zero-width' ? 'zerowidth' : 'confusable'}`,
              hoverMessage: {
                value: `**${kindLabel[f.kind]}** \`${f.codePoint}\` ${f.name}${extra}`,
              },
              ...(f.severity === 'error'
                ? {
                    overviewRuler: {
                      color: '#f14c4c',
                      position: monaco.editor.OverviewRulerLane.Right,
                    },
                  }
                : {}),
            },
          };
        });
        trojanDecorIdsRef.current = editor.deltaDecorations(trojanDecorIdsRef.current, decs);
      } catch {
        trojanDecorIdsRef.current = editor.deltaDecorations(trojanDecorIdsRef.current, []);
      }
    },
    [t],
  );

  // R5-A4 Git blame: per-file line attribution cache + current-line inline
  // annotation (VS Code "inline blame" style). Best-effort: a failed fetch
  // clears the cache and removes the annotation, never breaking editing.
  const blameCacheRef = useRef<{ path: string; byLine: Map<number, BlameLineDto> } | null>(null);
  const blameDecorIdsRef = useRef<string[]>([]);
  const renderBlameLine = useCallback((editor: monaco.editor.IStandaloneCodeEditor, lineNumber: number) => {
    const cache = blameCacheRef.current;
    if (!cache) return;
    const bl = cache.byLine.get(lineNumber);
    const text = bl
      ? bl.uncommitted
        ? `  ${bl.shortHash} · ${'uncommitted'}`
        : `  ${bl.shortHash} · ${bl.author} · ${new Date(bl.authorTime * 1000).toLocaleDateString()}`
      : null;
    blameDecorIdsRef.current = editor.deltaDecorations(blameDecorIdsRef.current, [
      {
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: text
          ? {
              after: {
                content: text,
                inlineClassName: 'blame-inline',
              },
            }
          : {},
      },
    ]);
  }, []);
  const refreshBlame = useCallback(
    async (editor: monaco.editor.IStandaloneCodeEditor, path: string) => {
      try {
        const res = await api.blameFile(path);
        const byLine = new Map<number, BlameLineDto>();
        for (const l of res.lines.slice(0, 2000)) byLine.set(l.line, l);
        blameCacheRef.current = { path, byLine };
        renderBlameLine(editor, editor.getPosition()?.lineNumber ?? 1);
      } catch {
        blameCacheRef.current = null;
        blameDecorIdsRef.current = editor.deltaDecorations(blameDecorIdsRef.current, []);
      }
    },
    [renderBlameLine],
  );

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
      // R4-B9: refresh TODO gutter markers for the newly opened file.
      void refreshTodoDecorations(editor, path);
      // R5-A4: refresh git blame attribution for the newly opened file.
      void refreshBlame(editor, path);
      // R5-A5: Trojan Source scan of the opened buffer (snapshot semantics).
      void refreshTrojanDecorations(editor, path, model.getValue());
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('editor.openFailed'));
      setStatus('');
    }
  }, [refreshTrojanDecorations]);

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // R3-T6 Local History: list snapshots of the open file.
  const loadHistory = useCallback(async (path: string) => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`${API_BASE}/file/history?path=${encodeURIComponent(path)}`, { headers: { ...authHeaders() } });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as { snapshots: SnapshotMeta[] };
      setHistory(body.snapshots);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('editor.localHistory.listFailed'));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // R3-T6 Local History: restore a snapshot (explicit confirm; the
  // current content is snapshotted as pre-restore on the server first,
  // so the restore itself is undoable).
  const restoreVersion = useCallback(async (id: string) => {
    const path = openPathRef.current;
    if (!path) return;
    if (!window.confirm(t('editor.localHistory.confirmRestore'))) return;
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/file/history/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ path, id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      await openFileRef.current(path);
      await loadHistory(path);
      setStatus(t('editor.localHistory.restored', { id }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('editor.localHistory.restoreFailed'));
    }
  }, [loadHistory]);

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
      // A save created a new snapshot — refresh the history list if open.
      if (showHistoryRef.current) void loadHistory(openPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('editor.saveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [openPath, loadHistory]);

  // R3-T6: keep the history drawer in sync with the open file.
  useEffect(() => {
    if (showHistory && openPath) void loadHistory(openPath);
  }, [showHistory, openPath, loadHistory]);

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

  // R3-T9: 粘性滚动开关 —— 实时写回 Monaco, 偏好持久化到 localStorage.
  const toggleSticky = () => {
    setStickyOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STICKY_SCROLL_KEY, next ? '1' : '0');
      } catch {
        /* storage unavailable — session-only */
      }
      const ed = editorRef.current;
      ed?.updateOptions({ stickyScroll: { enabled: next } });
      if (next && ed) {
        // Monaco 重开吸顶后不等下一次滚动就重绘: 轻推一次滚动位置触发重渲染.
        const st = ed.getScrollTop();
        ed.setScrollTop(st + 1);
        ed.setScrollTop(st);
      }
      return next;
    });
  };

  // R3-T9: 嵌套组的展开/收起 (key: `${dir}/${parentName}`, 默认展开).
  const [nestCollapsed, setNestCollapsed] = useState<Record<string, boolean>>({});
  const toggleNest = (key: string) => {
    setNestCollapsed((n) => ({ ...n, [key]: !n[key] }));
  };

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
    // R3-T9 file nesting: 同一目录下, 按 FILE_NESTING_RULES 把子文件收进父文件.
    const files = cache.entries.filter((e) => e.type === 'file');
    const claimed = new Set<string>();
    const childrenOf = new Map<string, Entry[]>();
    for (const e of files) {
      if (claimed.has(e.path)) continue;
      const kids = files.filter(
        (g) => g.path !== e.path && !claimed.has(g.path) && isNestingChild(e.name, g.name),
      );
      if (kids.length > 0) {
        childrenOf.set(e.path, kids);
        kids.forEach((k) => claimed.add(k.path));
      }
    }
    const rowStyle = (active: boolean): React.CSSProperties => ({
      padding: '3px 8px',
      cursor: 'pointer',
      fontSize: 12,
      fontFamily: 'monospace',
      background: active ? 'var(--bg3)' : undefined,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
    const renderFileRow = (e: Entry, pad: number, toggle?: { key: string; collapsed: boolean }) => (
      <div key={e.path}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => void openFile(e.path)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void openFile(e.path);
          }}
          style={{ ...rowStyle(openPath === e.path), paddingLeft: 8 + pad * 14 }}
        >
          {toggle && (
            <span
              role="button"
              tabIndex={0}
              title={t('editor.fileNesting.toggle')}
              onClick={(ev) => {
                ev.stopPropagation();
                toggleNest(toggle.key);
              }}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') {
                  ev.stopPropagation();
                  toggleNest(toggle.key);
                }
              }}
              style={{ display: 'inline-block', width: 14, cursor: 'pointer' }}
            >
              {toggle.collapsed ? '▸' : '▾'}
            </span>
          )}
          <FileIcon type="file" />
          {e.name}
        </div>
        {toggle && !toggle.collapsed &&
          (childrenOf.get(e.path) ?? []).map((k) => (
            <div
              key={k.path}
              role="button"
              tabIndex={0}
              onClick={() => void openFile(k.path)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') void openFile(k.path);
              }}
              style={{ ...rowStyle(openPath === k.path), paddingLeft: 8 + (pad + 1) * 14 }}
            >
              <span style={{ display: 'inline-block', width: 14 }} />
              <FileIcon type="file" />
              {k.name}
            </div>
          ))}
      </div>
    );
    const rows: React.ReactNode[] = [];
    for (const e of cache.entries) {
      if (e.type === 'dir') {
        rows.push(
          <div key={e.path}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggleDir(e.path)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') toggleDir(e.path);
              }}
              style={{ ...rowStyle(openPath === e.path), paddingLeft: 8 + depth * 14 }}
            >
              <FileIcon type="dir" />
              {e.name}
            </div>
            {renderEntries(e.path, depth + 1)}
          </div>,
        );
      } else if (!claimed.has(e.path)) {
        const kids = childrenOf.get(e.path);
        rows.push(
          renderFileRow(
            e,
            depth,
            kids ? { key: `${dir}/${e.name}`, collapsed: !!nestCollapsed[`${dir}/${e.name}`] } : undefined,
          ),
        );
      }
    }
    return rows;
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <b>{t('editor.title')}</b> <span className="muted">§65 · Monaco</span>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} title="R3-T9">
          <input type="checkbox" checked={stickyOn} onChange={toggleSticky} />
          {t('editor.stickyScroll')}
        </label>
        {openPath && (
          <>
            <span className="pill" style={{ fontFamily: 'monospace' }}>{openPath}</span>
            {dirty && <span className="pill">{t('editor.unsaved')}</span>}
            <button onClick={() => void saveFile()} disabled={!dirty || saving}>
              {saving ? t('editor.saving') : t('editor.save')}
            </button>
            <button
              onClick={() => {
                const next = !showHistory;
                setShowHistory(next);
                if (next && openPath) void loadHistory(openPath);
              }}
              style={{ fontSize: 12 }}
              title={t('editor.localHistory.title')}
            >
              🕘 {t('editor.localHistory.show')}
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
        {showHistory && openPath && (
          <div style={{ width: 300, borderLeft: '1px solid var(--border)', overflowY: 'auto', padding: '8px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <b>🕘 {t('editor.localHistory.title')}</b>
              <span style={{ flex: 1 }} />
              <button onClick={() => setShowHistory(false)} style={{ fontSize: 12 }}>
                {t('editor.localHistory.close')}
              </button>
            </div>
            {historyLoading && <div className="muted" style={{ fontSize: 12 }}>…</div>}
            {!historyLoading && history.length === 0 && (
              <div className="muted" style={{ fontSize: 12 }}>{t('editor.localHistory.empty')}</div>
            )}
            {history.map((s) => (
              <div key={s.id} style={{ padding: '6px 4px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                <div style={{ fontFamily: 'monospace' }}>{new Date(s.createdAt).toLocaleString()}</div>
                <div className="muted">
                  {s.kind === 'pre-restore' ? t('editor.localHistory.kindPreRestore') : t('editor.localHistory.kindSave')}
                  {' · '}{(s.size / 1024).toFixed(1)} KB
                </div>
                <button onClick={() => void restoreVersion(s.id)} style={{ fontSize: 12, marginTop: 4 }}>
                  {t('editor.localHistory.restore')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
