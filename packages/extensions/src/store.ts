/**
 * Extension store for @ai-factory/extensions (round-6 R6-S1).
 *
 * Layout (project-local, mirrors snippets.json placement):
 *   <root>/.ai-factory/extensions/<name>/extension.json
 *   <root>/.ai-factory/extensions/<name>/main.js
 *   <root>/.ai-factory/extensions/<name>/state.json   { enabled: boolean }
 *
 * Writes are atomic (tmp dir + rename). Directory entries are never
 * followed through symlinks (lstat check on install-from-dir and on
 * read). Names come from validated manifests, and every path is
 * re-checked to stay under the extensions home (defense in depth).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { validateMainSource, validateManifest } from './manifest.js';
import { loadExtension } from './sandbox.js';
import {
  ExtensionError,
  type ExtensionCheckerDef,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionState,
} from './types.js';

export function extensionsHome(root: string): string {
  return join(root, '.ai-factory', 'extensions');
}

function extDir(root: string, name: string): string {
  const home = extensionsHome(root);
  const dir = resolve(home, name);
  if (dir !== home && !dir.startsWith(home + sep)) {
    throw new ExtensionError(`extension name escapes the extensions home: ${name}`);
  }
  return dir;
}

function readJsonFile(path: string, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ExtensionError(`${what} is missing or unreadable: ${path}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ExtensionError(`${what} is not valid JSON: ${path}`);
  }
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** Read one installed extension (manifest + main + state), fully validated. */
export function readExtension(
  root: string,
  name: string,
): { manifest: ExtensionManifest; main: string; state: ExtensionState } {
  const dir = extDir(root, name);
  const manifest = validateManifest(readJsonFile(join(dir, 'extension.json'), 'extension manifest'));
  if (manifest.name !== name) {
    throw new ExtensionError(`extension directory name does not match manifest name: ${name}`);
  }
  let main: string;
  try {
    main = readFileSync(join(dir, 'main.js'), 'utf8');
  } catch {
    throw new ExtensionError(`extension main.js is missing: ${name}`);
  }
  main = validateMainSource(main);
  let state: ExtensionState = { enabled: true };
  const statePath = join(dir, 'state.json');
  if (existsSync(statePath)) {
    const raw = readJsonFile(statePath, 'extension state');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) ||
        typeof (raw as Record<string, unknown>).enabled !== 'boolean') {
      throw new ExtensionError(`extension state is invalid: ${name}`);
    }
    state = { enabled: (raw as Record<string, unknown>).enabled as boolean };
  }
  return { manifest, main, state };
}

export function toInfo(
  manifest: ExtensionManifest,
  state: ExtensionState,
): ExtensionInfo {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    permissions: manifest.permissions,
    enabled: state.enabled,
    commands: manifest.contributes.commands,
    panels: manifest.contributes.panels,
    checkers: manifest.contributes.checkers,
    providers: manifest.contributes.providers,
  };
}

/** List installed extensions (skips unreadable entries, never throws for one bad dir). */
export function listExtensions(root: string): ExtensionInfo[] {
  const home = extensionsHome(root);
  let names: string[] = [];
  try {
    names = readdirSync(home).sort();
  } catch {
    return [];
  }
  const out: ExtensionInfo[] = [];
  for (const name of names) {
    try {
      const dir = join(home, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue;
      const { manifest, state } = readExtension(root, name);
      out.push(toInfo(manifest, state));
    } catch {
      // One broken extension must not hide the rest; the list endpoint
      // reports broken entries separately via listExtensionsVerbose.
      continue;
    }
  }
  return out;
}

/** Like listExtensions, but also reports broken directories with their error. */
export function listExtensionsVerbose(
  root: string,
): { installed: ExtensionInfo[]; broken: Array<{ name: string; error: string }> } {
  const home = extensionsHome(root);
  let names: string[] = [];
  try {
    names = readdirSync(home).sort();
  } catch {
    return { installed: [], broken: [] };
  }
  const installed: ExtensionInfo[] = [];
  const broken: Array<{ name: string; error: string }> = [];
  for (const name of names) {
    try {
      const dir = join(home, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
        broken.push({ name, error: 'not a directory or is a symlink' });
        continue;
      }
      const { manifest, state } = readExtension(root, name);
      installed.push(toInfo(manifest, state));
    } catch (e) {
      broken.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { installed, broken };
}

/**
 * Install an extension (inline manifest + main). The bundle is dry-run
 * loaded in the sandbox BEFORE anything is written, so a broken or
 * handler-mismatched extension never lands on disk. Throws ExtensionError.
 */
export function installExtension(
  root: string,
  manifestInput: unknown,
  mainInput: unknown,
): ExtensionInfo {
  const manifest = validateManifest(manifestInput);
  const main = validateMainSource(mainInput);
  loadExtension(manifest, main);
  const dir = extDir(root, manifest.name);
  if (existsSync(dir)) {
    throw new ExtensionError(`extension is already installed: ${manifest.name}`);
  }
  const tmpDir = `${dir}.tmp-${process.pid}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    writeFileSync(join(tmpDir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8');
    writeFileSync(join(tmpDir, 'main.js'), main, 'utf8');
    writeFileSync(join(tmpDir, 'state.json'), JSON.stringify({ enabled: true }), 'utf8');
    renameSync(tmpDir, dir);
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e instanceof ExtensionError ? e : new ExtensionError(`install failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return toInfo(manifest, { enabled: true });
}

/** Install from a local directory (manifest + main.js read from it). */
export function installExtensionFromDir(root: string, sourceDir: string): ExtensionInfo {
  const resolved = resolve(sourceDir);
  const st = lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ExtensionError('sourceDir must be a real directory (no symlinks)');
  }
  const manifest = validateManifest(readJsonFile(join(resolved, 'extension.json'), 'extension manifest'));
  let main: string;
  try {
    main = readFileSync(join(resolved, 'main.js'), 'utf8');
  } catch {
    throw new ExtensionError('sourceDir is missing main.js');
  }
  return installExtension(root, manifest, main);
}

export function setExtensionEnabled(root: string, name: string, enabled: boolean): ExtensionInfo {
  const { manifest } = readExtension(root, name);
  writeFileAtomic(join(extDir(root, name), 'state.json'), JSON.stringify({ enabled }));
  return toInfo(manifest, { enabled });
}

export function uninstallExtension(root: string, name: string): void {
  const dir = extDir(root, name);
  if (!existsSync(dir)) throw new ExtensionError(`extension is not installed: ${name}`);
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ExtensionError(`extension entry is not a real directory: ${name}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Enabled extensions (for panels/providers/checkers aggregation). */
export function enabledExtensions(
  root: string,
): Array<{ manifest: ExtensionManifest; main: string }> {
  const out: Array<{ manifest: ExtensionManifest; main: string }> = [];
  for (const info of listExtensions(root)) {
    if (!info.enabled) continue;
    try {
      const { manifest, main } = readExtension(root, info.name);
      out.push({ manifest, main });
    } catch {
      continue;
    }
  }
  return out;
}

/** Translate a checker filePattern glob (* and ?) to a RegExp. */
export function filePatternToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Does one declarative checker flag this line of this file? */
export function checkLine(checker: ExtensionCheckerDef, relFile: string, line: string): boolean {
  if (checker.filePattern && !filePatternToRegExp(checker.filePattern).test(relFile)) return false;
  const re = new RegExp(checker.pattern, checker.flags ?? '');
  return re.test(line);
}
