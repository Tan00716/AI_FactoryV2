/**
 * Heuristic symbol extraction — regex-based, zero dependencies.
 *
 * HONEST LIMITATIONS (documented, not hidden):
 *  - This is not a parser. It finds common definition shapes and will
 *    miss metaprogramming, decorators-heavy code, macros, and symbols
 *    built dynamically (e.g. `Object.assign(exports, ...)`).
 *  - One line = one scan: multi-line signatures are only caught when
 *    the name and keyword are on the same line as the definition start.
 *  - False positives are possible (e.g. a comment containing
 *    "function foo("). The indexer is a recall aid for agents, not a
 *    compiler frontend; results always carry file+line so the agent
 *    can verify in source.
 *  - Supported languages: TypeScript/JavaScript (ts, tsx, js, jsx, mjs,
 *    cjs), Python (py), Go (go), Rust (rs). Other extensions get
 *    full-text indexing only (no symbols).
 */

import type { CodeSymbol, SymbolKind } from './types.js';

interface Pattern {
  re: RegExp;
  kind: SymbolKind;
  /** Capture group holding the name. */
  nameGroup: number;
}

const TS_JS: Pattern[] = [
  { re: /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function', nameGroup: 1 },
  { re: /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', nameGroup: 1 },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'variable', nameGroup: 1 },
  { re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', nameGroup: 1 },
  { re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: 'type', nameGroup: 1 },
  { re: /^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', nameGroup: 1 },
  { re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, kind: 'function', nameGroup: 1 },
  { re: /^\s*(?:export\s+default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', nameGroup: 1 },
  { re: /^\s*interface\s+([A-Za-z_$][\w$]*)\b/, kind: 'interface', nameGroup: 1 },
  { re: /^\s*type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type', nameGroup: 1 },
  { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', nameGroup: 1 },
  { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: 'function', nameGroup: 1 },
  { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, kind: 'function', nameGroup: 1 },
  // Class methods (indented, inside a class body — heuristic).
  { re: /^\s{2,}(?:async\s+|static\s+|get\s+|set\s+)*(?!if|for|while|switch|catch|return\b)([A-Za-z_$][\w$]*)\s*\(/, kind: 'method', nameGroup: 1 },
];

const PYTHON: Pattern[] = [
  { re: /^\s*class\s+([A-Za-z_]\w*)\s*[\(:]/, kind: 'class', nameGroup: 1 },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function', nameGroup: 1 },
];

const GO: Pattern[] = [
  { re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/, kind: 'function', nameGroup: 1 },
  { re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, kind: 'struct', nameGroup: 1 },
];

const RUST: Pattern[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', nameGroup: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct', nameGroup: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum', nameGroup: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait', nameGroup: 1 },
];

const BY_EXT: Record<string, Pattern[]> = {
  '.ts': TS_JS, '.tsx': TS_JS, '.js': TS_JS, '.jsx': TS_JS,
  '.mjs': TS_JS, '.cjs': TS_JS, '.mts': TS_JS, '.cts': TS_JS,
  '.py': PYTHON,
  '.go': GO,
  '.rs': RUST,
};

export function supportedExtensions(): string[] {
  return Object.keys(BY_EXT);
}

/**
 * Extract symbols from file text. `rel` is the root-relative posix path
 * used in the returned records.
 */
export function extractSymbols(rel: string, ext: string, text: string): CodeSymbol[] {
  const patterns = BY_EXT[ext.toLowerCase()];
  if (!patterns) return [];
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cheap guard against the most common false-positive source.
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) continue;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m && m[p.nameGroup]) {
        const name = m[p.nameGroup];
        const key = `${i}:${name}`;
        if (seen.has(key)) break;
        seen.add(key);
        out.push({
          name,
          kind: p.kind,
          file: rel,
          line: i + 1,
          snippet: line.trim().slice(0, 160),
        });
        break; // One symbol per line max.
      }
    }
  }
  return out;
}
