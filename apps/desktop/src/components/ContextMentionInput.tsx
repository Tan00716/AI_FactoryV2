import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultApiBase, authHeaders } from '../api';
import { useLang } from '../i18n';

/**
 * @-mention textarea for deterministic context providers (task ⑥).
 *
 * Typing `@` opens a dropdown of the five providers (fetched from
 * GET /api/context-providers — never hardcoded); picking one inserts
 * `@name` (or `@name()` with the cursor inside the parens when the
 * provider takes an argument). References already in the text render as
 * chips above the textarea. Resolution happens server-side at run
 * creation — this component never resolves anything itself.
 */
export interface ContextProviderMeta {
  name: string;
  description: string;
  usage: string;
  takesArg: boolean;
  argHint?: string;
}

const REF_RE = /@([a-z][a-z0-9_-]*)(\([^()]*\))?/g;

export function parseMentionRefs(text: string): Array<{ name: string; arg: string | null }> {
  const out: Array<{ name: string; arg: string | null }> = [];
  let m: RegExpExecArray | null;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text)) !== null) {
    out.push({ name: m[1], arg: m[2] !== undefined ? m[2].slice(1, -1) : null });
  }
  return out;
}

export function ContextMentionInput({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const { t } = useLang();
  const [providers, setProviders] = useState<ContextProviderMeta[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [atIndex, setAtIndex] = useState(-1);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${defaultApiBase()}/context-providers`, {
          headers: { ...authHeaders() },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { providers?: ContextProviderMeta[] };
        if (!cancelled && Array.isArray(body.providers)) setProviders(body.providers);
      } catch {
        /* provider list is enhancement-only; typing still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const detectAt = useCallback(
    (text: string, cursor: number) => {
      const before = text.slice(0, cursor);
      const m = /@([a-z0-9_-]*)$/.exec(before);
      // Only trigger on a fresh @ (start of text or after whitespace),
      // never inside emails.
      if (m && (m.index === 0 || /\s/.test(before[m.index - 1]))) {
        setFilter(m[1]);
        setAtIndex(m.index);
        setOpen(true);
      } else {
        setOpen(false);
      }
    },
    [],
  );

  const insert = useCallback(
    (p: ContextProviderMeta) => {
      const ta = taRef.current;
      const cursor = ta?.selectionStart ?? value.length;
      const at = atIndex >= 0 ? atIndex : cursor;
      const insertText = p.takesArg ? `@${p.name}()` : `@${p.name}`;
      const next = value.slice(0, at) + insertText + value.slice(cursor);
      onChange(next);
      setOpen(false);
      // Place the caret inside the parens for arg-taking providers.
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        const pos = at + insertText.length - (p.takesArg ? 1 : 0);
        el.setSelectionRange(pos, pos);
      });
    },
    [atIndex, onChange, value],
  );

  const filtered = filter
    ? providers.filter((p) => p.name.startsWith(filter.toLowerCase()))
    : providers;
  const chips = parseMentionRefs(value);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      {chips.length > 0 && (
        <div className="row" style={{ marginBottom: 4, flexWrap: 'wrap', gap: 4 }}>
          {chips.map((c, i) => (
            <span key={i} className="pill">
              @{c.name}
              {c.arg !== null && c.arg !== '' ? `(${c.arg})` : ''}
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label="run-prompt-with-context-mentions"
        onChange={(e) => {
          onChange(e.target.value);
          detectAt(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          else if (e.key === 'Tab' && open && filtered.length > 0) {
            e.preventDefault();
            insert(filtered[0]);
          }
        }}
        style={{ width: '100%', fontFamily: 'inherit' }}
      />
      {open && filtered.length > 0 && (
        <div className="slash-dropdown" role="listbox" aria-label="context-providers">
          {filtered.map((p) => (
            <button
              key={p.name}
              className="slash-item"
              onMouseDown={(e) => {
                e.preventDefault();
                insert(p);
              }}
            >
              <code>@{p.name}</code>
              <span className="muted">{p.description}</span>
            </button>
          ))}
          <div className="muted" style={{ padding: '4px 8px', fontSize: 12 }}>
            {t('ctx.hintDeterministic')}
          </div>
        </div>
      )}
    </div>
  );
}
