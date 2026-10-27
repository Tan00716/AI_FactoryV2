/**
 * Fail-closed manifest validation for @ai-factory/extensions (round-6 R6-S1).
 *
 * Rules: unknown top-level or contributes keys are rejected (a typo must
 * not silently drop a contribution); every id must match the contribution
 * pattern and be unique within its kind; checker patterns must compile
 * (flags restricted to 'i'); section text and messages are length-capped.
 * Nothing here executes extension code — that is sandbox.ts's job.
 */
import {
  CONTRIBUTION_ID_RE,
  EXTENSION_NAME_RE,
  EXTENSION_VERSION_RE,
  KNOWN_EXTENSION_PERMISSIONS,
  MAX_CHECKERS,
  MAX_COMMANDS,
  MAX_MAIN_BYTES,
  MAX_PANELS,
  MAX_PROVIDERS,
  PROVIDER_PREFIX_RE,
  type ExtensionCheckerDef,
  type ExtensionCommandDef,
  type ExtensionContributes,
  type ExtensionManifest,
  type ExtensionPanelDef,
  type ExtensionProviderDef,
} from './types.js';
import { ExtensionError } from './types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(obj: Record<string, unknown>, key: string, max: number): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new ExtensionError(`manifest.${key} must be a non-empty string of at most ${max} chars`);
  }
  return v;
}

function optString(obj: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) {
    throw new ExtensionError(`manifest.${key} must be a string of at most ${max} chars`);
  }
  return v;
}

function checkUnknown(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ExtensionError(`${where} has unknown key: ${k}`);
  }
}

function checkUniqueIds(ids: string[], kind: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!CONTRIBUTION_ID_RE.test(id)) {
      throw new ExtensionError(`${kind} id is invalid: ${id}`);
    }
    if (seen.has(id)) throw new ExtensionError(`${kind} id is duplicated: ${id}`);
    seen.add(id);
  }
}

function parseCommands(raw: unknown): ExtensionCommandDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_COMMANDS) {
    throw new ExtensionError(`contributes.commands must be an array of at most ${MAX_COMMANDS}`);
  }
  const out: ExtensionCommandDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) throw new ExtensionError('contributes.commands entries must be objects');
    checkUnknown(item, ['id', 'title', 'description'], 'command');
    out.push({
      id: reqString(item, 'id', 64),
      title: reqString(item, 'title', 200),
      description: optString(item, 'description', 500),
    });
  }
  checkUniqueIds(out.map((c) => c.id), 'command');
  return out;
}

function parsePanels(raw: unknown): ExtensionPanelDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PANELS) {
    throw new ExtensionError(`contributes.panels must be an array of at most ${MAX_PANELS}`);
  }
  const out: ExtensionPanelDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) throw new ExtensionError('contributes.panels entries must be objects');
    checkUnknown(item, ['id', 'title', 'sections'], 'panel');
    const sectionsRaw = item.sections;
    if (!Array.isArray(sectionsRaw) || sectionsRaw.length === 0 || sectionsRaw.length > 20) {
      throw new ExtensionError('panel.sections must be an array of 1..20 sections');
    }
    const sections = sectionsRaw.map((s) => {
      if (!isRecord(s)) throw new ExtensionError('panel sections must be objects');
      checkUnknown(s, ['heading', 'text'], 'panel section');
      return {
        heading: optString(s, 'heading', 200),
        text: reqString(s, 'text', 2000),
      };
    });
    out.push({ id: reqString(item, 'id', 64), title: reqString(item, 'title', 200), sections });
  }
  checkUniqueIds(out.map((p) => p.id), 'panel');
  return out;
}

function parseCheckers(raw: unknown): ExtensionCheckerDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_CHECKERS) {
    throw new ExtensionError(`contributes.checkers must be an array of at most ${MAX_CHECKERS}`);
  }
  const out: ExtensionCheckerDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) throw new ExtensionError('contributes.checkers entries must be objects');
    checkUnknown(item, ['id', 'title', 'pattern', 'flags', 'message', 'severity', 'filePattern'], 'checker');
    const pattern = reqString(item, 'pattern', 500);
    const flags = optString(item, 'flags', 2) ?? '';
    if (flags !== '' && flags !== 'i') {
      throw new ExtensionError('checker.flags may only be "i" (patterns are always non-global)');
    }
    try {
      new RegExp(pattern, flags);
    } catch {
      throw new ExtensionError(`checker.pattern does not compile: ${pattern}`);
    }
    const severity = item.severity === undefined ? 'warning' : item.severity;
    if (severity !== 'error' && severity !== 'warning' && severity !== 'info') {
      throw new ExtensionError('checker.severity must be error, warning or info');
    }
    out.push({
      id: reqString(item, 'id', 64),
      title: reqString(item, 'title', 200),
      pattern,
      flags: flags === '' ? undefined : flags,
      message: reqString(item, 'message', 300),
      severity,
      filePattern: optString(item, 'filePattern', 200),
    });
  }
  checkUniqueIds(out.map((c) => c.id), 'checker');
  return out;
}

function parseProviders(raw: unknown): ExtensionProviderDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PROVIDERS) {
    throw new ExtensionError(`contributes.providers must be an array of at most ${MAX_PROVIDERS}`);
  }
  const out: ExtensionProviderDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) throw new ExtensionError('contributes.providers entries must be objects');
    checkUnknown(item, ['id', 'prefix', 'description'], 'provider');
    const prefix = reqString(item, 'prefix', 33);
    if (!PROVIDER_PREFIX_RE.test(prefix)) {
      throw new ExtensionError(`provider.prefix must look like @name: ${prefix}`);
    }
    out.push({
      id: reqString(item, 'id', 64),
      prefix,
      description: optString(item, 'description', 500),
    });
  }
  checkUniqueIds(out.map((p) => p.id), 'provider');
  return out;
}

/** Validate an unknown value as an ExtensionManifest (throws ExtensionError). */
export function validateManifest(input: unknown): ExtensionManifest {
  if (!isRecord(input)) throw new ExtensionError('manifest must be an object');
  checkUnknown(input, ['name', 'version', 'description', 'author', 'permissions', 'contributes'], 'manifest');
  const name = reqString(input, 'name', 64);
  if (!EXTENSION_NAME_RE.test(name)) throw new ExtensionError(`manifest.name is invalid: ${name}`);
  const version = reqString(input, 'version', 64);
  if (!EXTENSION_VERSION_RE.test(version)) {
    throw new ExtensionError(`manifest.version must be semver-like: ${version}`);
  }
  const description = reqString(input, 'description', 500);
  const author = optString(input, 'author', 200);
  let permissions: ExtensionManifest['permissions'] = [];
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions)) {
      throw new ExtensionError('manifest.permissions must be an array');
    }
    for (const p of input.permissions) {
      if (typeof p !== 'string' || !(KNOWN_EXTENSION_PERMISSIONS as readonly string[]).includes(p)) {
        throw new ExtensionError(`manifest.permissions has unknown permission: ${String(p)}`);
      }
    }
    permissions = input.permissions as ExtensionManifest['permissions'];
  }
  let contributes: ExtensionContributes = { commands: [], panels: [], checkers: [], providers: [] };
  if (input.contributes !== undefined) {
    if (!isRecord(input.contributes)) throw new ExtensionError('manifest.contributes must be an object');
    checkUnknown(input.contributes, ['commands', 'panels', 'checkers', 'providers'], 'contributes');
    contributes = {
      commands: parseCommands(input.contributes.commands),
      panels: parsePanels(input.contributes.panels),
      checkers: parseCheckers(input.contributes.checkers),
      providers: parseProviders(input.contributes.providers),
    };
  }
  return { name, version, description, author, permissions, contributes };
}

/** Validate main.js source (size + NUL bytes). Execution safety is the sandbox's job. */
export function validateMainSource(main: unknown): string {
  if (typeof main !== 'string' || main.length === 0) {
    throw new ExtensionError('main.js must be a non-empty string');
  }
  if (Buffer.byteLength(main, 'utf8') > MAX_MAIN_BYTES) {
    throw new ExtensionError(`main.js exceeds ${MAX_MAIN_BYTES} bytes`);
  }
  if (main.includes('\0')) throw new ExtensionError('main.js must not contain NUL bytes');
  return main;
}
