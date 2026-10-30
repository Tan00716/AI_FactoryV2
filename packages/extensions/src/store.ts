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
  EXTENSION_TRUST_FILE,
  bundleSha256,
  checkApiVersion,
  computeTrust,
  parseSignature,
  recordTrust,
  revokeTrust,
  verifyBundleSignature,
  TrustRequiredError,
} from './trust.js';
import {
  ExtensionError,
  type ExtensionCheckerDef,
  type ExtensionInfo,
  type ExtensionManifest,
  type ExtensionSignature,
  type ExtensionState,
  type ExtensionTrust,
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

/** Read one installed extension (manifest + main + state + signature), fully validated. */
export function readExtension(
  root: string,
  name: string,
): { manifest: ExtensionManifest; main: string; state: ExtensionState; signature?: ExtensionSignature } {
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
  // A present-but-unreadable signature file is corruption, not absence:
  // fail-closed (the extension shows as broken) rather than silently unsigned.
  let signature: ExtensionSignature | undefined;
  const sigPath = join(dir, 'signature.json');
  if (existsSync(sigPath)) {
    signature = parseSignature(readJsonFile(sigPath, 'extension signature'));
  }
  return { manifest, main, state, signature };
}

export function toInfo(
  manifest: ExtensionManifest,
  state: ExtensionState,
  trust: ExtensionTrust,
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
    apiVersion: manifest.apiVersion ?? null,
    trust,
  };
}

/** Trust verdict for an installed bundle (recomputed from disk each call). */
export function trustOf(
  root: string,
  name: string,
  manifest: ExtensionManifest,
  main: string,
  signature?: ExtensionSignature,
): ExtensionTrust {
  return computeTrust(root, name, manifest, main, signature);
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
    if (name === EXTENSION_TRUST_FILE) continue;
    try {
      const dir = join(home, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue;
      const { manifest, main, state, signature } = readExtension(root, name);
      checkApiVersion(manifest);
      out.push(toInfo(manifest, state, computeTrust(root, name, manifest, main, signature)));
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
    if (name === EXTENSION_TRUST_FILE) continue;
    try {
      const dir = join(home, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
        broken.push({ name, error: 'not a directory or is a symlink' });
        continue;
      }
      const { manifest, main, state, signature } = readExtension(root, name);
      checkApiVersion(manifest);
      installed.push(toInfo(manifest, state, computeTrust(root, name, manifest, main, signature)));
    } catch (e) {
      broken.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { installed, broken };
}

export interface InstallOptions {
  /** Bundle signature object (stored as signature.json when present). */
  signature?: unknown;
  /**
   * Explicit user trust for an unsigned inline bundle. Without it (and
   * without a valid signature) install throws TrustRequiredError — the
   * V3-#9 "ask" step. Ignored when localDev is true.
   */
  trust?: boolean;
  /**
   * Local-dev install (install-from-dir): the author is present, so the
   * bundle installs directly and a 'local-dev' trust decision is
   * recorded for the exact bundle hash (voided on any bundle change).
   */
  localDev?: boolean;
}

/**
 * Install an extension (inline manifest + main). The bundle is dry-run
 * loaded in the sandbox BEFORE anything is written, so a broken or
 * handler-mismatched extension never lands on disk. Throws ExtensionError.
 *
 * Trust order (V3-#9): manifest validation -> API version compat ->
 * main validation -> sandbox dry-run -> signature verification (an
 * invalid signature is fail-closed, not "ask") -> trust gate (unsigned
 * bundles need { trust: true } or a local-dev install).
 */
export function installExtension(
  root: string,
  manifestInput: unknown,
  mainInput: unknown,
  opts: InstallOptions = {},
): ExtensionInfo {
  const manifest = validateManifest(manifestInput);
  checkApiVersion(manifest);
  const main = validateMainSource(mainInput);
  loadExtension(manifest, main);
  let signature: ExtensionSignature | undefined;
  if (opts.signature !== undefined) {
    signature = parseSignature(opts.signature);
    if (!verifyBundleSignature(manifest, main, signature)) {
      throw new ExtensionError(
        `extension signature verification failed for ${manifest.name}: the bundle does not match its signature`,
      );
    }
  }
  const preTrust = computeTrust(root, manifest.name, manifest, main, signature);
  if (!opts.localDev && signature === undefined && opts.trust !== true) {
    throw new TrustRequiredError(manifest.name, preTrust);
  }
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
    if (signature !== undefined) {
      writeFileSync(join(tmpDir, 'signature.json'), JSON.stringify(signature, null, 2), 'utf8');
    }
    renameSync(tmpDir, dir);
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw e instanceof ExtensionError ? e : new ExtensionError(`install failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const hash = bundleSha256(manifest, main);
  if (opts.localDev) recordTrust(root, manifest.name, hash, 'local-dev');
  else if (signature === undefined && opts.trust === true) recordTrust(root, manifest.name, hash, 'user');
  return toInfo(manifest, { enabled: true }, computeTrust(root, manifest.name, manifest, main, signature));
}

/** Install from a local directory (manifest + main.js + optional signature.json). */
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
  let signature: unknown;
  const sigPath = join(resolved, 'signature.json');
  if (existsSync(sigPath)) {
    signature = readJsonFile(sigPath, 'extension signature');
  }
  return installExtension(root, manifest, main, { signature, localDev: true });
}

export function setExtensionEnabled(root: string, name: string, enabled: boolean): ExtensionInfo {
  const { manifest, main, signature } = readExtension(root, name);
  writeFileAtomic(join(extDir(root, name), 'state.json'), JSON.stringify({ enabled }));
  return toInfo(manifest, { enabled }, computeTrust(root, name, manifest, main, signature));
}

export function uninstallExtension(root: string, name: string): void {
  const dir = extDir(root, name);
  if (!existsSync(dir)) throw new ExtensionError(`extension is not installed: ${name}`);
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ExtensionError(`extension entry is not a real directory: ${name}`);
  }
  rmSync(dir, { recursive: true, force: true });
  try {
    revokeTrust(root, name);
  } catch {
    // Trust cleanup is best-effort; the uninstall itself succeeded.
  }
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
