/**
 * TerminalPanel — spec §50.1 (integrated terminal: xterm.js + 受控 PTY).
 *
 * Batch 19 rewired this panel from the emulated model (one POST
 * /api/exec per line, no real PTY) to a REAL interactive session:
 * on mount it opens POST /api/terminal/sessions (principal 'human'),
 * streams output over the SSE endpoint with fetch (so the
 * Authorization header keeps working — EventSource cannot send
 * headers), forwards every keystroke to /input, and reports terminal
 * resizes to /resize (the server SIGWINCHes the pty). Backspace,
 * Ctrl+C, job control etc. are all handled by the real pty now —
 * nothing is emulated client-side anymore.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n';
import { defaultApiBase, authHeaders } from '../api';
import { Terminal } from 'xterm';
import type { IMarker, IDecoration } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import {
  scanShellMarkers,
  groupEntriesBySession,
  flattenGroups,
  type HistoryEntryDto,
} from '../terminalHistory';
import 'xterm/css/xterm.css';

const API_BASE = defaultApiBase();

interface SseFrame {
  event: string;
  data: string;
}

function b64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function TerminalPanel() {
  const { t } = useLang();
  const hostRef = useRef<HTMLDivElement>(null);

  // R3-T10: 终端状态条 (Claude Code /statusline 式): 会话状态 / 工作目录 /
  // 退出码 / 连接状态. 退出码只有会话结束时才有 (取不到诚实显示"—").
  interface TermStatus {
    conn: 'connecting' | 'connected' | 'disconnected' | 'closed';
    sessionShort: string | null;
    cwd: string | null;
    exitCode: number | null;
  }
  const [status, setStatus] = useState<TermStatus>({
    conn: 'connecting',
    sessionShort: null,
    cwd: null,
    exitCode: null,
  });
  // 重连: 递增 nonce 触发 effect 重跑 (cleanup 先收掉旧会话).
  const [bootNonce, setBootNonce] = useState(0);
  const reconnect = useCallback(() => setBootNonce((n) => n + 1), []);

  // R4-A8: shell-integration 装饰与历史搜索.
  const termRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingMarkerRef = useRef<IMarker | null>(null);
  const markersRef = useRef<Array<{ marker: IMarker; exitCode: number }>>([]);
  const decorationsRef = useRef<IDecoration[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyEntries, setHistoryEntries] = useState<HistoryEntryDto[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySel, setHistorySel] = useState(0);

  const connLabel = (() => {
    switch (status.conn) {
      case 'connected': return t('terminal.status.connected');
      case 'disconnected': return t('terminal.status.disconnected');
      case 'closed': return t('terminal.status.closed');
      default: return t('terminal.status.connecting');
    }
  })();
  const connColor = (() => {
    switch (status.conn) {
      case 'connected': return '#3fb950';
      case 'connecting': return '#d29922';
      case 'closed': return '#8b949e';
      default: return '#f85149';
    }
  })();

  // R4-A8: 跨会话历史搜索 (服务端 fuzzy, history.jsonl 持久化).
  const fetchHistory = useCallback(async (q: string) => {
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/terminal/history?q=${encodeURIComponent(q)}&limit=50`,
        { headers: authHeaders() },
      );
      if (res.ok) {
        const body = (await res.json()) as { entries: HistoryEntryDto[] };
        setHistoryEntries(Array.isArray(body.entries) ? body.entries : []);
        setHistorySel(0);
      }
    } catch {
      /* 网络抖动: 保留旧结果 */
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    const timer = setTimeout(() => void fetchHistory(historyQuery), 150);
    return () => clearTimeout(timer);
  }, [historyOpen, historyQuery, fetchHistory]);

  // R4-A8: 把选中的历史命令插入当前终端 (不带换行, 用户可再编辑).
  const insertHistoryEntry = useCallback(async (entry: HistoryEntryDto) => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      await fetch(`${API_BASE}/terminal/sessions/${id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ data: entry.command }),
      });
    } catch {
      /* ignore */
    }
    setHistoryOpen(false);
    termRef.current?.focus();
  }, []);

  // R4-A8: 在命令装饰标记之间跳转 (Alt 冲突留给 readline, 用按钮触发).
  const jumpMarker = useCallback((dir: 1 | -1) => {
    const term = termRef.current;
    if (!term) return;
    const live = markersRef.current.filter((m) => !m.marker.isDisposed);
    if (live.length === 0) return;
    const viewportTop = term.buffer.active.viewportY;
    const rows = term.rows;
    let target: number | null = null;
    if (dir === 1) {
      const next = live.find((m) => m.marker.line > viewportTop + rows - 1);
      target = next ? next.marker.line : null;
    } else {
      const prev = [...live].reverse().find((m) => m.marker.line < viewportTop);
      target = prev ? prev.marker.line : null;
    }
    if (target !== null) term.scrollToLine(target);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let sessionId: string | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#0d1117', foreground: '#c9d1d9' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;

    term.writeln(t('terminal.banner'));
    term.writeln(t('terminal.connecting'));

    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });

    const streamSession = async (id: string): Promise<void> => {
      const res = await fetch(`${API_BASE}/terminal/sessions/${id}/stream`, {
        headers: { ...authHeaders(), Accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) {
        term.writeln(`\r\n\x1b[31mstream failed: HTTP ${res.status}\x1b[0m`);
        setStatus((s) => ({ ...s, conn: 'disconnected' }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // R4-A8: shell-integration 装饰. 标记混在输出流里, 按段写入,
      // 在 C(命令开始)处 registerMarker(0)(相对光标, 正好落在命令
      // 行), 在 D(命令结束)处按退出码挂 overview-ruler 装饰
      // (绿=成功, 红=失败). 标记被 xterm 的 OSC 解析器消费, 不可见.
      const writeWithMarkers = (text: string): void => {
        let pos = 0;
        for (const m of scanShellMarkers(text)) {
          if (m.index > pos) term.write(text.slice(pos, m.index));
          if (m.kind === 'C') {
            const old = pendingMarkerRef.current;
            pendingMarkerRef.current = null;
            if (old && !old.isDisposed) {
              try { old.dispose(); } catch { /* ignore */ }
            }
            try {
              pendingMarkerRef.current = term.registerMarker(0) ?? null;
            } catch {
              pendingMarkerRef.current = null;
            }
          } else if (m.kind === 'D') {
            const pm = pendingMarkerRef.current;
            pendingMarkerRef.current = null;
            const code = /^\d+$/.test(m.payload) ? parseInt(m.payload, 10) : NaN;
            if (pm && !pm.isDisposed && Number.isFinite(code)) {
              try {
                const deco = term.registerDecoration({
                  marker: pm,
                  overviewRulerOptions: { color: code === 0 ? '#3fb950' : '#f85149' },
                });
                if (deco) {
                  decorationsRef.current.push(deco);
                  markersRef.current.push({ marker: pm, exitCode: code });
                  while (markersRef.current.length > 300) {
                    const oldest = markersRef.current.shift();
                    try { oldest?.marker.dispose(); } catch { /* ignore */ }
                  }
                  while (decorationsRef.current.length > 300) {
                    const od = decorationsRef.current.shift();
                    try { od?.dispose(); } catch { /* ignore */ }
                  }
                }
              } catch {
                /* 装饰是 best-effort */
              }
            } else if (pm && !pm.isDisposed) {
              try { pm.dispose(); } catch { /* ignore */ }
            }
          }
          pos = m.index + m.length;
        }
        if (pos < text.length) term.write(text.slice(pos));
      };
      const handleFrame = (frame: SseFrame): void => {
        if (frame.event === 'output') {
          try {
            writeWithMarkers(b64ToText((JSON.parse(frame.data) as { b64: string }).b64));
          } catch {
            /* malformed frame — ignore */
          }
        } else if (frame.event === 'denied') {
          try {
            const d = JSON.parse(frame.data) as { line: string; reason: string };
            term.write(`\r\n\x1b[33m[denied] ${d.reason}: ${d.line}\x1b[0m\r\n`);
          } catch {
            /* ignore */
          }
        } else if (frame.event === 'close') {
          try {
            const c = JSON.parse(frame.data) as { exitCode: number | null; signal: string | null };
            term.writeln(`\r\n\x1b[33m[${t('terminal.sessionClosedDetail', { exit: c.exitCode ?? '?', signal: c.signal ?? '-' })}]\x1b[0m`);
            setStatus((s) => ({ ...s, conn: 'closed', exitCode: c.exitCode }));
          } catch {
            term.writeln('\r\n\x1b[33m[' + t('terminal.sessionClosed') + ']\x1b[0m');
            setStatus((s) => ({ ...s, conn: 'closed' }));
          }
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disposed) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            const dataLines: string[] = [];
            for (const line of raw.split('\n')) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length > 0 || event === 'close') {
              handleFrame({ event, data: dataLines.join('\n') });
            }
          }
        }
      } catch {
        if (!disposed) {
          term.writeln('\r\n\x1b[31m' + t('terminal.streamInterrupted') + '\x1b[0m');
          setStatus((s) => (s.conn === 'connected' ? { ...s, conn: 'disconnected' } : s));
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    };

    const boot = async (): Promise<void> => {
      setStatus({ conn: 'connecting', sessionShort: null, cwd: null, exitCode: null });
      try {
        const res = await post('/terminal/sessions', {
          principal: 'human',
          cols: term.cols || 80,
          rows: term.rows || 24,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          term.writeln(`\r\n\x1b[31msession refused: ${body.error ?? `HTTP ${res.status}`}\x1b[0m`);
          setStatus((s) => ({ ...s, conn: 'disconnected' }));
          return;
        }
        const created = (await res.json()) as { id: string; cwd?: string };
        if (disposed) {
          // Panel went away during boot — close the orphaned session.
          await fetch(`${API_BASE}/terminal/sessions/${created.id}`, {
            method: 'DELETE',
            headers: authHeaders(),
          }).catch(() => {});
          return;
        }
        sessionId = created.id;
        sessionIdRef.current = created.id;
        setStatus({
          conn: 'connected',
          sessionShort: created.id.slice(0, 8),
          cwd: typeof created.cwd === 'string' ? created.cwd : null,
          exitCode: null,
        });
        term.writeln(`\x1b[32mconnected: session ${created.id.slice(0, 8)}…\x1b[0m`);
        await streamSession(created.id);
      } catch (e) {
        if (!disposed) {
          term.writeln(`\r\n\x1b[31msession failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
          setStatus((s) => ({ ...s, conn: 'disconnected' }));
        }
      }
    };

    // Every keystroke goes to the real pty (the line discipline echoes).
    const dataDispose = term.onData((data) => {
      if (!sessionId) return;
      post(`/terminal/sessions/${sessionId}/input`, { data }).catch(() => {});
    });

    // Terminal resize → server resize (SIGWINCH), debounced.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCols = 0;
    let lastRows = 0;
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (!sessionId) return;
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (sessionId && !disposed) {
          post(`/terminal/sessions/${sessionId}/resize`, {
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        }
      }, 300);
    });
    ro.observe(host);

    void boot();

    // R3-T10: 5s 轮询服务端会话列表 —— 服务端重启/会话被收割时 SSE
    // 不一定收到 close 帧, 这里把连接态诚实地打成"已断开".
    const poll = async (): Promise<void> => {
      const id = sessionId;
      if (!id || disposed) return;
      try {
        const res = await fetch(`${API_BASE}/terminal/sessions?includeClosed=1`, {
          headers: authHeaders(),
        });
        if (!res.ok || disposed) return;
        const body = (await res.json()) as {
          sessions: Array<{ id: string }>;
          closed?: Array<{ id: string; exit?: { exitCode: number | null } }>;
        };
        if (body.sessions.some((s) => s.id === id)) return; // 仍然存活
        const archived = (body.closed ?? []).find((s) => s.id === id);
        if (archived) {
          setStatus((s) => ({
            ...s,
            conn: 'closed',
            exitCode: s.exitCode ?? archived.exit?.exitCode ?? null,
          }));
        } else {
          setStatus((s) => (s.conn === 'connected' ? { ...s, conn: 'disconnected' } : s));
        }
      } catch {
        /* 网络抖动不改状态, 下一轮再看 */
      }
    };
    const pollTimer = setInterval(() => void poll(), 5000);

    return () => {
      disposed = true;
      dataDispose.dispose();
      ro.disconnect();
      clearInterval(pollTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      // R4-A8: 收掉本会话的装饰与标记
      const pm = pendingMarkerRef.current;
      pendingMarkerRef.current = null;
      if (pm && !pm.isDisposed) {
        try { pm.dispose(); } catch { /* ignore */ }
      }
      for (const d of decorationsRef.current) {
        try { d.dispose(); } catch { /* ignore */ }
      }
      decorationsRef.current = [];
      for (const m of markersRef.current) {
        try { m.marker.dispose(); } catch { /* ignore */ }
      }
      markersRef.current = [];
      termRef.current = null;
      sessionIdRef.current = null;
      const id = sessionId;
      term.dispose();
      if (id) {
        // Best-effort: don't leak server-side sessions when the tab closes.
        fetch(`${API_BASE}/terminal/sessions/${id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        }).catch(() => {});
      }
    };
  }, [bootNonce]);

  const historyGroups = groupEntriesBySession(historyEntries);
  const historyFlat = flattenGroups(historyGroups);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        <b>{t('terminal.title')}</b> <span className="muted">{t('terminal.subtitle')}</span>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: 4 }} />
      {/* R3-T10: 终端状态条 (DOM, xterm 宿主下方) */}
      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: '4px 10px',
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          fontSize: 12,
        }}
        className="muted"
      >
        <span>{t('terminal.status.session')}: <b style={{ color: 'var(--fg)' }}>{status.sessionShort ?? '—'}</b></span>
        <span>{t('terminal.status.cwd')}: <span style={{ fontFamily: 'monospace' }}>{status.cwd ?? '—'}</span></span>
        <span>{t('terminal.status.exitCode')}: <b style={{ color: 'var(--fg)' }}>{status.exitCode ?? '—'}</b></span>
        <span style={{ flex: 1 }} />
        {/* R4-A8: 命令装饰跳转 + 历史搜索 */}
        <button onClick={() => jumpMarker(-1)} style={{ fontSize: 12 }} title={t('terminal.history.prevCommand')}>
          ↑
        </button>
        <button onClick={() => jumpMarker(1)} style={{ fontSize: 12 }} title={t('terminal.history.nextCommand')}>
          ↓
        </button>
        <button onClick={() => setHistoryOpen(true)} style={{ fontSize: 12 }}>
          {t('terminal.history.open')}
        </button>
        <span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: connColor, marginRight: 6 }} />
          {connLabel}
        </span>
        {(status.conn === 'disconnected' || status.conn === 'closed') && (
          <button onClick={reconnect} style={{ fontSize: 12 }}>
            {t('terminal.status.reconnect')}
          </button>
        )}
      </div>
      {/* R4-A8: 历史命令搜索浮层 (跨会话 fuzzy, ↑↓ 导航, 回车插入) */}
      {historyOpen && (
        <div
          style={{
            position: 'absolute',
            top: 40,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(560px, 90%)',
            maxHeight: '70%',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
            zIndex: 20,
          }}
        >
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <b style={{ fontSize: 13 }}>{t('terminal.history.title')}</b>
            <span style={{ flex: 1 }} />
            <button onClick={() => setHistoryOpen(false)} style={{ fontSize: 12 }}>
              {t('terminal.history.close')}
            </button>
          </div>
          <div style={{ padding: '8px 12px' }}>
            <input
              autoFocus
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHistorySel((s) => Math.min(s + 1, historyFlat.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHistorySel((s) => Math.max(s - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const hit = historyFlat[historySel];
                  if (hit) void insertHistoryEntry(hit);
                } else if (e.key === 'Escape') {
                  setHistoryOpen(false);
                }
              }}
              placeholder={t('terminal.history.searchPlaceholder')}
              style={{ width: '100%', fontSize: 13, padding: '6px 8px' }}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {t('terminal.history.insertHint')}
            </div>
          </div>
          <div style={{ overflowY: 'auto', padding: '0 12px 12px' }}>
            {historyLoading && <div className="muted" style={{ fontSize: 12 }}>…</div>}
            {!historyLoading && historyFlat.length === 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                {historyQuery ? t('terminal.history.empty') : t('terminal.history.noHistory')}
              </div>
            )}
            {historyGroups.map((g) => (
              <div key={g.key} style={{ marginTop: 8 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{g.label}</div>
                {g.entries.map((e) => {
                  const idx = historyFlat.indexOf(e);
                  const selected = idx === historySel;
                  return (
                    <div
                      key={e.id}
                      onClick={() => void insertHistoryEntry(e)}
                      onMouseEnter={() => setHistorySel(idx)}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'baseline',
                        padding: '4px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: selected ? 'var(--hover)' : 'transparent',
                        fontSize: 12,
                      }}
                    >
                      <span
                        title={e.exitCode === 0 ? t('terminal.history.exitOk') : t('terminal.history.exitFail', { code: e.exitCode })}
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: e.exitCode === 0 ? '#3fb950' : '#f85149',
                        }}
                      />
                      <code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.command.split('\n')[0]}
                        {e.command.includes('\n') ? ' ⏎' : ''}
                      </code>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
