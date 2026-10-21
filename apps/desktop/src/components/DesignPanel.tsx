/**
 * DesignPanel — Visual Design Mode (v0 Design Mode style, task ⑨).
 *
 * Preview a web page (single self-contained HTML file served from the
 * workspace via the existing /api/file surface), click an element to
 * pick it, locate it back in the source (heuristic: tag + classes +
 * literal text, via POST /api/design/locate), then edit text / Tailwind
 * class tokens visually. Write-back is a deterministic string transform
 * on the server (POST /api/design/apply) guarded by a shadow checkpoint
 * — every edit is undoable from the shadow checkpoint view.
 *
 * Honest boundaries (also in the UI note):
 * - The preview renders ONE self-contained HTML file (inline CSS/JS).
 *   Multi-file asset resolution and framework dev servers are out of
 *   scope for this version.
 * - Locating is heuristic: runtime-generated content (API data) cannot
 *   be traced to source, and repeated identical elements resolve to the
 *   first match.
 * - Write-back only swaps class-name tokens and literal text — no .css
 *   edits, no drag-layout. Non-Tailwind projects get locate + text only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { authHeaders } from '../api';
import { useLang } from '../i18n';
import { editorCursor } from '../editorCursor';

export interface ElementFingerprint {
  tag: string;
  classes: string[];
  text: string;
}

export interface LocateResult {
  found: boolean;
  file: string | null;
  line: number | null;
  column: number | null;
  text: string | null;
  classes: string[];
}

export interface DesignInfo {
  path: string;
  exists: boolean;
  tailwind: boolean;
  tailwindReason: string;
}

export interface DesignApi {
  info(path: string): Promise<DesignInfo>;
  readFile(path: string): Promise<string>;
  locate(fp: ElementFingerprint, path?: string): Promise<LocateResult>;
  apply(
    path: string,
    line: number,
    fp: ElementFingerprint,
    edits: Record<string, string>,
  ): Promise<{ ok: boolean; changed: boolean; checkpointId: string | null; applied?: string[] }>;
}

export function createDesignApi(base: string): DesignApi {
  async function req<T>(p: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${p}`, {
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      ...init,
    });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const err = body as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return body;
  }
  return {
    info: (path) => req(`/design/info?path=${encodeURIComponent(path)}`),
    readFile: async (path) => {
      const r = await req<{ content: string }>(`/file?path=${encodeURIComponent(path)}`);
      return r.content;
    },
    locate: (fp, path) =>
      req(`/design/locate`, {
        method: 'POST',
        body: JSON.stringify(path ? { fingerprint: fp, path } : { fingerprint: fp }),
      }),
    apply: (path, line, fp, edits) =>
      req(`/design/apply`, {
        method: 'POST',
        body: JSON.stringify({ path, line, fingerprint: fp, edits }),
      }),
  };
}

/**
 * Script injected into the preview document (client-side, before
 * </body>). Picking is same-origin (srcdoc), so postMessage to the
 * parent panel is the only bridge — no DOM access crosses over.
 */
const PICKER_SCRIPT = `<script>
(function () {
  var picking = false, pickedEl = null, prevOutline = '';
  function fpOf(el) {
    var cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean);
    var text = (el.textContent || '').trim().slice(0, 120);
    return { tag: el.tagName.toLowerCase(), classes: cls, text: text };
  }
  function clearPicked() {
    if (pickedEl) { pickedEl.style.outline = prevOutline; pickedEl = null; }
  }
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'design-pick') { picking = !!d.enabled; if (!picking) clearPicked(); }
    if (d.type === 'design-highlight') {
      var fp = d.fp || {};
      var nodes = document.querySelectorAll(fp.tag || '*');
      var found = null;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean);
        var ok = (fp.classes || []).every(function (c) { return cls.indexOf(c) !== -1; });
        var txt = (el.textContent || '').trim();
        if (ok && (!fp.text || txt.indexOf(fp.text) !== -1)) { found = el; break; }
      }
      if (found) {
        var old = found.style.outline;
        found.style.outline = '3px dashed orange';
        found.scrollIntoView({ block: 'center' });
        setTimeout(function () { found.style.outline = old; }, 2500);
        parent.postMessage({ type: 'design-highlight-result', found: true }, '*');
      } else {
        parent.postMessage({ type: 'design-highlight-result', found: false }, '*');
      }
    }
  });
  document.addEventListener('click', function (e) {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    clearPicked();
    pickedEl = e.target; prevOutline = pickedEl.style.outline;
    pickedEl.style.outline = '2px solid #22d3ee';
    parent.postMessage({ type: 'design-picked', fp: fpOf(pickedEl) }, '*');
  }, true);
})();
</script>`;

function injectPicker(html: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + PICKER_SCRIPT;
  return html.slice(0, idx) + PICKER_SCRIPT + html.slice(idx);
}

const BG_COLORS = [
  'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-teal-500',
  'bg-blue-500', 'bg-indigo-500', 'bg-purple-500', 'bg-pink-500', 'bg-gray-500',
  'bg-black', 'bg-white',
];
const TEXT_COLORS = [
  'text-red-600', 'text-orange-600', 'text-yellow-600', 'text-green-600',
  'text-blue-600', 'text-purple-600', 'text-gray-900', 'text-gray-500',
  'text-black', 'text-white',
];
const FONT_SIZES = ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl'];
const SPACING = ['0', '1', '2', '3', '4', '6', '8', '10'];
const TEXT_SIZE_SET = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']);

function tokenOf(classes: string[], family: 'bg' | 'text-color' | 'text-size' | 'p' | 'm'): string {
  for (const c of classes) {
    if (family === 'bg' && c.startsWith('bg-')) return c;
    if (family === 'text-color' && c.startsWith('text-') && !TEXT_SIZE_SET.has(c.slice(5))) return c;
    if (family === 'text-size' && c.startsWith('text-') && TEXT_SIZE_SET.has(c.slice(5))) return c;
    if (family === 'p' && /^p-\d/.test(c)) return c;
    if (family === 'm' && /^m-\d/.test(c)) return c;
  }
  return '';
}

export function DesignPanel({ api }: { api: DesignApi }) {
  const { t } = useLang();
  const [entryPath, setEntryPath] = useState('index.html');
  const [info, setInfo] = useState<DesignInfo | null>(null);
  const [previewDoc, setPreviewDoc] = useState<string>('');
  const [frameKey, setFrameKey] = useState(0);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ElementFingerprint | null>(null);
  const [located, setLocated] = useState<LocateResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [textVal, setTextVal] = useState('');
  const [bgVal, setBgVal] = useState('');
  const [tcVal, setTcVal] = useState('');
  const [fsVal, setFsVal] = useState('');
  const [padVal, setPadVal] = useState('');
  const [marVal, setMarVal] = useState('');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const [html, inf] = await Promise.all([api.readFile(entryPath), api.info(entryPath)]);
      setInfo(inf);
      if (!inf.exists) {
        setErr(t('design.fileMissing', { path: entryPath }));
        setPreviewDoc('');
        return;
      }
      setPreviewDoc(injectPicker(html));
      setFrameKey((k) => k + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [api, entryPath, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const postToFrame = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  const togglePick = useCallback(() => {
    setPicking((p) => {
      postToFrame({ type: 'design-pick', enabled: !p });
      return !p;
    });
  }, [postToFrame]);

  const runLocate = useCallback(
    async (fp: ElementFingerprint) => {
      try {
        const r = await api.locate(fp, entryPath);
        if (r.found) {
          setLocated(r);
          setNotFound(false);
          setTextVal(r.text ?? '');
          setBgVal(tokenOf(r.classes, 'bg'));
          setTcVal(tokenOf(r.classes, 'text-color'));
          setFsVal(tokenOf(r.classes, 'text-size'));
          setPadVal(tokenOf(r.classes, 'p'));
          setMarVal(tokenOf(r.classes, 'm'));
        } else {
          setLocated(null);
          setNotFound(true);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [api, entryPath],
  );

  // Preview → panel messages.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      const d = e.data as { type?: string; fp?: ElementFingerprint; found?: boolean } | null;
      if (!d) return;
      if (d.type === 'design-picked' && d.fp) {
        setPicked(d.fp);
        setStatus('');
        void runLocate(d.fp);
      }
      if (d.type === 'design-highlight-result') {
        setStatus(d.found ? t('design.highlightFound') : t('design.highlightMissing'));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [runLocate, t]);

  const openInEditor = useCallback(() => {
    if (!located?.file || located.line === null) return;
    window.dispatchEvent(
      new CustomEvent('ai-factory:open-file', {
        detail: { path: located.file, line: located.line },
      }),
    );
  }, [located]);

  const applyEdits = useCallback(async () => {
    if (!picked || !located?.file || located.line === null) return;
    const edits: Record<string, string> = {};
    if (bgVal) edits['bgColor'] = bgVal;
    if (tcVal) edits['textColor'] = tcVal;
    if (fsVal) edits['fontSize'] = fsVal;
    if (padVal) edits['padding'] = padVal;
    if (marVal) edits['margin'] = marVal;
    if (located.text !== null && textVal !== located.text) edits['text'] = textVal;
    if (Object.keys(edits).length === 0) {
      setStatus(t('design.noChanges'));
      return;
    }
    setErr(null);
    try {
      const r = await api.apply(located.file, located.line, picked, edits);
      setStatus(
        r.changed
          ? t('design.applied', { checkpoint: r.checkpointId ?? '' })
          : t('design.noChanges'),
      );
      await reload();
      void runLocate(picked);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [api, picked, located, bgVal, tcVal, fsVal, padVal, marVal, textVal, reload, runLocate, t]);

  /** Item 3 — code → preview: fingerprint the editor's current line. */
  const highlightFromEditor = useCallback(async () => {
    setErr(null);
    const { path, line } = editorCursor;
    if (!path || !line) {
      setStatus(t('design.noEditorCursor'));
      return;
    }
    try {
      const content = await api.readFile(path);
      const lines = content.split('\n');
      const lineText = lines[line - 1] ?? '';
      const m = /<([A-Za-z][\w.-]*)\b[^>]*?(?:class|className)\s*=\s*(?:"([^"]*)"|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/.exec(lineText);
      const tagOnly = /<([A-Za-z][\w.-]*)\b/.exec(lineText);
      const tag = (m?.[1] ?? tagOnly?.[1] ?? '').toLowerCase();
      if (!tag) {
        setStatus(t('design.lineNotElement'));
        return;
      }
      const classes = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').split(/\s+/).filter(Boolean);
      const after = lineText.slice(lineText.indexOf('>') + 1);
      const text = (after.split('<')[0] ?? '').trim().slice(0, 120);
      postToFrame({ type: 'design-highlight', fp: { tag, classes, text } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [api, postToFrame, t]);

  const tailwind = info?.tailwind === true;
  const styleDisabled = !tailwind;

  return (
    <div className="design-panel">
      <h3>{t('design.title')}</h3>
      <p className="design-note">{t('design.honestNote')}</p>
      <div className="design-toolbar">
        <label>
          {t('design.entryLabel')}{' '}
          <input
            value={entryPath}
            onChange={(e) => setEntryPath(e.target.value)}
            style={{ width: 220 }}
          />
        </label>
        <button onClick={() => void reload()}>{t('design.reload')}</button>
        <button onClick={togglePick} className={picking ? 'active' : ''}>
          {picking ? t('design.pickOn') : t('design.pick')}
        </button>
        <button onClick={() => void highlightFromEditor()}>{t('design.highlightFromEditor')}</button>
      </div>
      {info && !info.tailwind && (
        <p className="design-note">{t('design.notTailwind', { reason: info.tailwindReason })}</p>
      )}
      {err && <div className="banner err">{err}</div>}
      <div className="design-main">
        <iframe
          key={frameKey}
          ref={iframeRef}
          className="design-frame"
          title="design-preview"
          srcDoc={previewDoc}
          sandbox="allow-scripts"
        />
        <div className="design-side">
          {!picked && <p>{t('design.pickHint')}</p>}
          {picked && (
            <>
              <div className="design-fp">
                <code>
                  &lt;{picked.tag}&gt; {picked.classes.join(' ')}
                </code>
                {picked.text && <div className="design-fp-text">“{picked.text.slice(0, 60)}”</div>}
              </div>
              {notFound && <p className="design-warn">{t('design.notLocated')}</p>}
              {located?.file && (
                <button className="design-loc" onClick={openInEditor}>
                  {t('design.locatedAt', { path: located.file, line: String(located.line ?? 0) })}
                </button>
              )}
              {located && (
                <div className="design-form">
                  <label>
                    {t('design.textLabel')}
                    <input
                      value={textVal}
                      disabled={located.text === null}
                      onChange={(e) => setTextVal(e.target.value)}
                    />
                    {located.text === null && <span className="design-note">{t('design.textDynamic')}</span>}
                  </label>
                  <label>
                    {t('design.bgLabel')}
                    <select value={bgVal} disabled={styleDisabled} onChange={(e) => setBgVal(e.target.value)}>
                      <option value="">—</option>
                      {BG_COLORS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('design.textColorLabel')}
                    <select value={tcVal} disabled={styleDisabled} onChange={(e) => setTcVal(e.target.value)}>
                      <option value="">—</option>
                      {TEXT_COLORS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('design.fontSizeLabel')}
                    <select value={fsVal} disabled={styleDisabled} onChange={(e) => setFsVal(e.target.value)}>
                      <option value="">—</option>
                      {FONT_SIZES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('design.paddingLabel')}
                    <select value={padVal} disabled={styleDisabled} onChange={(e) => setPadVal(e.target.value)}>
                      <option value="">—</option>
                      {SPACING.map((n) => (
                        <option key={n} value={`p-${n}`}>{`p-${n}`}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('design.marginLabel')}
                    <select value={marVal} disabled={styleDisabled} onChange={(e) => setMarVal(e.target.value)}>
                      <option value="">—</option>
                      {SPACING.map((n) => (
                        <option key={n} value={`m-${n}`}>{`m-${n}`}</option>
                      ))}
                    </select>
                  </label>
                  <button onClick={() => void applyEdits()}>{t('design.apply')}</button>
                </div>
              )}
            </>
          )}
          {status && <p className="design-status">{status}</p>}
        </div>
      </div>
    </div>
  );
}
