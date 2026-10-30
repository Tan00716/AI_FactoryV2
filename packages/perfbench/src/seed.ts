/**
 * Deterministic synthetic-repo generator (V3-#4).
 *
 * Fixed-seed PRNG (mulberry32) so the same seed always yields the same
 * tree: same file count, same names, same byte sizes. A benchmark number
 * is only comparable when the input is identical, so the seed travels
 * with every report. Content is deliberately ordinary TypeScript: a
 * module header, one sibling import, a handful of exported functions
 * with bodies that reference each other — enough for the heuristic
 * symbol extractor to find symbols, without pretending to be a real
 * codebase (see README: synthetic results are an upper/lower bound
 * hint, not a real-repo promise).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'alpha', 'beta', 'gamma', 'delta', 'order', 'invoice', 'ledger',
  'cache', 'queue', 'router', 'policy', 'audit', 'metric', 'tenant',
  'session', 'worker', 'broker', 'schema', 'index', 'cursor', 'vault',
];

function pick(rnd: () => number, arr: string[]): string {
  return arr[Math.floor(rnd() * arr.length)] as string;
}

function fileContent(rnd: () => number, mod: string, i: number): string {
  const fns = 2 + Math.floor(rnd() * 4);
  const lines: string[] = [
    `// Synthetic module ${mod}/${i} (perfbench seed fixture, not real code).`,
    `import { helper${i % 50} } from '../common/util${i % 50}';`,
    '',
  ];
  // ~10% of files carry the probe token the search benchmark looks for.
  if (rnd() < 0.1) lines.push('// perfbenchProbeToken: searchable marker line.');
  for (let f = 0; f < fns; f++) {
    const name = `${pick(rnd, WORDS)}${pick(rnd, WORDS)}${f}`;
    lines.push(`export function ${name}(input: number): number {`);
    lines.push(`  const base = helper${i % 50}(input);`);
    lines.push(`  return base + ${Math.floor(rnd() * 1000)};`);
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Generate `fileCount` .ts files under root/src/mod_<m>/file_<n>.ts plus
 * 50 shared util modules. Returns { files, bytes }.
 */
export function generateRepo(
  root: string,
  fileCount: number,
  seed: number,
): { files: number; bytes: number } {
  const rnd = mulberry32(seed);
  mkdirSync(root, { recursive: true });
  let bytes = 0;
  let files = 0;
  for (let m = 0; m < 50; m++) {
    const util = `export function helper${m}(input: number): number {\n  return input * ${m + 2};\n}\n`;
    const p = join(root, 'src', 'common', `util${m}.ts`);
    mkdirSync(join(root, 'src', 'common'), { recursive: true });
    writeFileSync(p, util);
    bytes += Buffer.byteLength(util);
    files++;
  }
  const mods = 20;
  for (let i = 0; i < fileCount; i++) {
    const mod = `mod_${i % mods}`;
    const dir = join(root, 'src', mod);
    mkdirSync(dir, { recursive: true });
    const content = fileContent(rnd, mod, i);
    writeFileSync(join(dir, `file_${i}.ts`), content);
    bytes += Buffer.byteLength(content);
    files++;
  }
  return { files, bytes };
}

/** Generate one large text file of at least targetBytes bytes. */
export function generateLargeFile(path: string, targetBytes: number): number {
  const line = 'export const row = { id: 0, label: "perfbench-large-file-line", ok: true };\n';
  const reps = Math.ceil(targetBytes / Buffer.byteLength(line));
  const parts: string[] = [];
  for (let i = 0; i < reps; i++) {
    parts.push(line.replace('id: 0', `id: ${i}`));
  }
  const text = parts.join('');
  writeFileSync(path, text);
  return Buffer.byteLength(text);
}
