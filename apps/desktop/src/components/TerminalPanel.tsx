/**
 * TerminalPanel — spec §64 (integrated terminal).
 *
 * xterm.js rendering + fit addon. Prototype execution model: each line is
 * POSTed once to /api/exec (routes/exec.ts) and the output is echoed back
 * into the terminal — no real PTY. `cd` is handled client-side by tracking
 * the cwd that is sent with every request.
 */
import { useEffect, useRef } from 'react';
import { authHeaders } from '../api';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

const API_BASE = 'http://localhost:3100/api';

function writeLines(term: Terminal, text: string) {
  for (const chunk of text.split('\n')) {
    term.write(chunk.replace(/\r/g, ''));
    term.write('\r\n');
  }
}

export function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement>(null);
  const cwdRef = useRef('.');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* host hidden */
      }
    });
    ro.observe(host);

    let line = '';
    let busy = false;
    const prompt = () => {
      term.write(`\r\n\x1b[1;32mai-factory\x1b[0m:\x1b[1;34m${cwdRef.current}\x1b[0m$ `);
    };

    term.writeln('AI Factory integrated terminal (§64) — type a command, Enter to run.');
    term.writeln('Whitelisted read-only/build commands only (ls, cat, pwd, echo, git, npm, node…). `cd` changes the directory.');
    prompt();

    term.onData(async (data) => {
      if (busy) return;
      const code = data.charCodeAt(0);

      if (data === '\r') {
        // Enter — execute
        const command = line.trim();
        line = '';
        if (!command) {
          prompt();
          return;
        }
        busy = true;
        // local `cd` handling
        if (command === 'cd' || command.startsWith('cd ')) {
          cwdRef.current = command.slice(2).trim() || '.';
          busy = false;
          prompt();
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ command, cwd: cwdRef.current }),
          });
          const body = (await res.json()) as {
            output?: string;
            error?: string;
            exitCode?: number;
            truncated?: boolean;
          };
          term.write('\r\n');
          if (!res.ok) {
            writeLines(term, `\x1b[31mrefused: ${body.error ?? `HTTP ${res.status}`}\x1b[0m`);
          } else {
            const out = (body.output ?? '').replace(/\s+$/, '');
            if (out) writeLines(term, out);
            if (body.exitCode) {
              term.write(`\x1b[31m[exit ${body.exitCode}]\x1b[0m\r\n`);
            }
            if (body.truncated) term.write('\x1b[33m[output truncated]\x1b[0m\r\n');
          }
        } catch (e) {
          term.write(`\r\n\x1b[31mexec failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`);
        } finally {
          busy = false;
          prompt();
        }
        return;
      }
      if (code === 127) {
        // Backspace
        if (line.length > 0) {
          line = line.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }
      if (code === 3) {
        // Ctrl+C — cancel line
        line = '';
        term.write('^C');
        prompt();
        return;
      }
      if (code === 12) {
        // Ctrl+L — clear screen
        term.clear();
        term.write(line);
        return;
      }
      if (code < 32) return; // ignore other control keys
      line += data;
      term.write(data);
    });

    return () => {
      ro.disconnect();
      term.dispose();
    };
  }, []);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        <b>Terminal</b> <span className="muted">§64 · controlled execution via /api/exec</span>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: 4 }} />
    </div>
  );
}
