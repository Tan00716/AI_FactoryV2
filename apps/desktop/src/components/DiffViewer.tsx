/**
 * DiffViewer — Monaco DiffEditor for the AI Change Review UI (§66).
 *
 * Fetches before/after file content for a change from
 * GET /api/changes/:id/file?repo=&file= and shows the side-by-side diff.
 */
import { useEffect, useRef, useState } from 'react';
import { authHeaders } from '../api';
import monaco, { languageOf } from '../monacoSetup';

const API_BASE = 'http://localhost:3100/api';

export function DiffViewer({
  repo,
  changeId,
  file,
  title,
  onClose,
}: {
  repo: string;
  changeId: string;
  file: string;
  title: string;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const diffEditor = monaco.editor.createDiffEditor(host, {
      theme: 'vs-dark',
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: true,
      fontSize: 13,
      minimap: { enabled: false },
    });

    (async () => {
      try {
        const q = `/changes/${encodeURIComponent(changeId)}/file?file=${encodeURIComponent(file)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`;
        const res = await fetch(`${API_BASE}${q}`, { headers: { ...authHeaders() } });
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        const body = (await res.json()) as { before: string; after: string };
        if (disposed) return;
        const lang = languageOf(file);
        diffEditor.setModel({
          original: monaco.editor.createModel(body.before, lang, monaco.Uri.parse(`inmemory://diff/before/${file}`)),
          modified: monaco.editor.createModel(body.after, lang, monaco.Uri.parse(`inmemory://diff/after/${file}`)),
        });
        setLoading(false);
      } catch (e) {
        if (!disposed) {
          setErr(e instanceof Error ? e.message : 'failed to load diff');
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      const model = diffEditor.getModel();
      model?.original.dispose();
      model?.modified.dispose();
      diffEditor.dispose();
    };
  }, [repo, changeId, file]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          width: '90%',
          height: '85%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <b>Diff</b>
          <span className="pill" style={{ fontFamily: 'monospace' }}>{file}</span>
          <span className="muted" style={{ fontSize: 12 }}>{title}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Close</button>
        </div>
        {err ? (
          <div className="banner err">{err}</div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {loading && (
              <div className="muted" style={{ padding: 16 }}>
                Loading diff…
              </div>
            )}
            <div ref={hostRef} style={{ position: 'absolute', inset: 0, visibility: loading ? 'hidden' : 'visible' }} />
          </div>
        )}
      </div>
    </div>
  );
}
