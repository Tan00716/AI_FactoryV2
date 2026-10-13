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
import { useEffect, useRef } from 'react';
import { authHeaders } from '../api';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

const API_BASE = 'http://localhost:3100/api';

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
  const hostRef = useRef<HTMLDivElement>(null);

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

    term.writeln('AI Factory integrated terminal (§50.1) — interactive PTY session, human principal.');
    term.writeln('Connecting…');

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
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handleFrame = (frame: SseFrame): void => {
        if (frame.event === 'output') {
          try {
            term.write(b64ToText((JSON.parse(frame.data) as { b64: string }).b64));
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
            term.writeln(`\r\n\x1b[33m[session closed: exit=${c.exitCode ?? '?'} signal=${c.signal ?? '-'}]\x1b[0m`);
          } catch {
            term.writeln('\r\n\x1b[33m[session closed]\x1b[0m');
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
        if (!disposed) term.writeln('\r\n\x1b[31mstream interrupted\x1b[0m');
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    };

    const boot = async (): Promise<void> => {
      try {
        const res = await post('/terminal/sessions', {
          principal: 'human',
          cols: term.cols || 80,
          rows: term.rows || 24,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          term.writeln(`\r\n\x1b[31msession refused: ${body.error ?? `HTTP ${res.status}`}\x1b[0m`);
          return;
        }
        const created = (await res.json()) as { id: string };
        if (disposed) {
          // Panel went away during boot — close the orphaned session.
          await fetch(`${API_BASE}/terminal/sessions/${created.id}`, {
            method: 'DELETE',
            headers: authHeaders(),
          }).catch(() => {});
          return;
        }
        sessionId = created.id;
        term.writeln(`\x1b[32mconnected: session ${created.id.slice(0, 8)}…\x1b[0m`);
        await streamSession(created.id);
      } catch (e) {
        if (!disposed) {
          term.writeln(`\r\n\x1b[31msession failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
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

    return () => {
      disposed = true;
      dataDispose.dispose();
      ro.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
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
  }, []);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        <b>Terminal</b> <span className="muted">§50.1 · interactive PTY session (human)</span>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: 4 }} />
    </div>
  );
}
