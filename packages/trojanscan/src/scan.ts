/**
 * Deterministic scanner: finds bidi controls, zero-width characters and
 * mixed-script confusable lookalikes in text.
 *
 * Column numbers are 1-based UTF-16 code units (Monaco-accurate), line
 * numbers are 1-based. Scanning is pure: no I/O, no model, no guessing.
 */
import { BIDI_CONTROLS, ZERO_WIDTH_CHARS, CONFUSABLES } from './data';
import { TROJAN_SEVERITY, TROJAN_SUPPRESS_MARKER, type TrojanHit, type TrojanKind } from './types';

function codePointLabel(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function isAsciiWordChar(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    cp === 0x5f // _
  );
}

function isAsciiAlnum(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
  );
}

interface CpToken {
  cp: number;
  utf16Start: number;
  utf16Len: number;
}

function tokenize(line: string): CpToken[] {
  const out: CpToken[] = [];
  let i = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0) as number;
    out.push({ cp, utf16Start: i, utf16Len: ch.length });
    i += ch.length;
  }
  return out;
}

/**
 * Scan one line. `lineNo` is 1-based; `globalOffset` is the UTF-16 offset
 * of the line start within the whole text (used for the leading-BOM
 * exemption of U+FEFF).
 */
export function scanLine(line: string, lineNo: number, globalOffset = 0): TrojanHit[] {
  const hits: TrojanHit[] = [];
  const toks = tokenize(line);
  const push = (
    kind: TrojanKind,
    tok: CpToken,
    name: string,
    extra?: Partial<TrojanHit>,
  ): void => {
    hits.push({
      kind,
      severity: TROJAN_SEVERITY[kind],
      codePoint: codePointLabel(tok.cp),
      name,
      line: lineNo,
      column: tok.utf16Start + 1,
      length: tok.utf16Len,
      ...extra,
    });
  };

  for (const tok of toks) {
    const bidiName = BIDI_CONTROLS.get(tok.cp);
    if (bidiName !== undefined) {
      push('bidi-control', tok, bidiName);
      continue;
    }
    const zwName = ZERO_WIDTH_CHARS.get(tok.cp);
    if (zwName !== undefined) {
      // A leading BOM (U+FEFF at the very start of the file) is
      // legitimate; only flag it mid-file.
      if (tok.cp === 0xfeff && globalOffset + tok.utf16Start === 0) continue;
      push('zero-width', tok, zwName);
    }
  }

  // Confusables: only inside mixed-script word tokens. A token is a
  // maximal run of ASCII word chars and tabled lookalikes. Flag the
  // lookalikes iff the token also contains ASCII alphanumerics.
  let run: CpToken[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      const hasAscii = run.some((t) => isAsciiAlnum(t.cp));
      if (hasAscii) {
        for (const t of run) {
          const entry = CONFUSABLES.get(t.cp);
          if (entry !== undefined) {
            push('confusable', t, entry.name, { script: entry.script, latin: entry.latin });
          }
        }
      }
    }
    run = [];
  };
  for (const tok of toks) {
    if (isAsciiWordChar(tok.cp) || CONFUSABLES.has(tok.cp)) {
      run.push(tok);
    } else {
      flushRun();
    }
  }
  flushRun();

  return hits;
}

/**
 * Scan whole text. Returns hits sorted by (line, column).
 * If any line contains the TROJAN_SUPPRESS_MARKER substring, the whole
 * file is skipped (documented per-file ignore for legitimate
 * multilingual text).
 */
export function scanText(text: string): TrojanHit[] {
  const lines = text.split('\n');
  for (const ln of lines) {
    if (ln.includes(TROJAN_SUPPRESS_MARKER)) return [];
  }
  const out: TrojanHit[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    out.push(...scanLine(lines[i] as string, i + 1, offset));
    offset += (lines[i] as string).length + 1; // +1 for the '\n'
  }
  out.sort((a, b) => (a.line - b.line) || (a.column - b.column));
  return out;
}

/** Scan pre-split lines (inspection checker entry point). */
export function scanLines(lines: string[]): TrojanHit[] {
  return scanText(lines.join('\n'));
}
