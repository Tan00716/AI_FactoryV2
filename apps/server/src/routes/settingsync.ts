/**
 * Settings sync routes (R7-#10).
 *
 *   GET  /api/settingsync/export          current sections as a sync doc (viewer)
 *   POST /api/settingsync/preview   { doc } -> diff entries + summary (operator)
 *   POST /api/settingsync/apply     { doc, resolutions? } -> apply + audit (operator)
 *   GET  /api/settingsync/remote          { url, tokenConfigured } (viewer)
 *   PUT  /api/settingsync/remote     { url | null } (operator)
 *   POST /api/settingsync/remote/push     upload current export (operator)
 *   POST /api/settingsync/remote/pull     download doc + preview, no apply (operator)
 *
 * Synced sections (v1): keybindings (user layer file) and rules-global
 * (global managed-rule store). Secrets, .env files, tokens, extension
 * code, and project files are never synced: the document validator
 * refuses any payload matching a shared secret pattern, at export and
 * at import. Apply audits SETTINGSYNC_APPLIED with section:key names
 * only — never values. The remote token is resolved from the
 * environment at request time (see @ai-factory/settingsync) and is
 * never stored, served, or audited.
 *
 * Baseline: the sections state as of the last successful apply, kept
 * in <dataDir>/settingsync-baseline.json. The diff rules (added /
 * modified / conflict / removed) are documented in the package README.
 *
 * RBAC: the centralized gate (auth.ts requiredRoleFor) maps GET ->
 * viewer and POST/PUT -> operator for this prefix — no auth.ts change.
 *
 * Dual-mode: value imports are node builtins + @ai-factory/* packages
 * only, so tests may import this module from src with an explicit `.ts`
 * suffix; the HTTP tests boot the real dist server instead.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateUserKeybindings } from '@ai-factory/keybinding';
import { parseStore, writeStoreFile, type LevelStore } from '@ai-factory/rules';
import {
  applySections,
  createExport,
  diffSections,
  diffSummary,
  pullRemote,
  pushRemote,
  resolveRemoteToken,
  validateRemoteUrl,
  validateSyncDoc,
  type Resolutions,
  type Sections,
  type SyncDoc,
} from '@ai-factory/settingsync';
import type { RouteContext } from './context';

const PREFIX = '/api/settingsync';
const MAX_BODY_BYTES = 1_000_000;

export const SETTINGSYNC_APPLIED_ACTION = 'SETTINGSYNC_APPLIED';
export const SETTINGSYNC_REMOTE_ACTION = 'SETTINGSYNC_REMOTE_CONFIGURED';
export const SETTINGSYNC_PUSHED_ACTION = 'SETTINGSYNC_PUSHED';

class SettingsyncRouteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'SettingsyncRouteError';
    this.code = code;
    this.status = status;
  }
}

export interface SettingsyncDeps {
  resolveDataDir: () => string;
  resolveGlobalRulesDir: () => string;
}

let deps: SettingsyncDeps | null = null;

/** Installed once by index.ts at boot. */
export function setSettingsyncDeps(d: SettingsyncDeps | null): void {
  deps = d;
}

function needDeps(): SettingsyncDeps {
  if (!deps) throw new SettingsyncRouteError('settingsync service is not wired', 'not-wired', 500);
  return deps;
}

function keybindingsFile(): string {
  return join(needDeps().resolveDataDir(), 'keybindings.json');
}

function rulesFile(): string {
  return join(needDeps().resolveGlobalRulesDir(), 'rules.json');
}

function baselineFile(): string {
  return join(needDeps().resolveDataDir(), 'settingsync-baseline.json');
}

function remoteFile(): string {
  return join(needDeps().resolveDataDir(), 'settingsync-remote.json');
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Current sections, read from the same files the owning routes use. */
export function readCurrentSections(): Sections {
  const kbRaw = readJsonFile(keybindingsFile());
  const items = Array.isArray(kbRaw) ? kbRaw : [];
  const rulesRaw = readJsonFile(rulesFile());
  const store: LevelStore =
    rulesRaw && typeof rulesRaw === 'object'
      ? parseStore(JSON.stringify(rulesRaw))
      : { version: 1, rules: [] };
  return {
    keybindings: { items },
    'rules-global': { version: store.version, rules: store.rules },
  };
}

function readBaseline(): Sections | null {
  const raw = readJsonFile(baselineFile());
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sections = (raw as { sections?: unknown }).sections;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return null;
  return sections as Sections;
}

function writeBaseline(sections: Sections): void {
  atomicWrite(baselineFile(), JSON.stringify({ version: 1, sections }));
}

function readRemoteUrl(): string | null {
  const raw = readJsonFile(remoteFile());
  if (!raw || typeof raw !== 'object') return null;
  const url = (raw as { url?: unknown }).url;
  return typeof url === 'string' ? url : null;
}

/** Validate one section's incoming value with the owning store's rules.
 * Only keys present in the value are validated: a missing key is the
 * "removed" case the diff handles, not an invalid document. */
function validateSectionValue(section: string, value: Record<string, unknown>): string[] {
  if (section === 'keybindings') {
    if (!('items' in value)) return [];
    const items = value['items'];
    return validateUserKeybindings(items).map((i) => `keybindings[${i.index}]: ${i.message}`);
  }
  if (section === 'rules-global') {
    if ('version' in value && value['version'] !== 1) {
      return ['rules-global version must be 1'];
    }
    if ('rules' in value) {
      if (!Array.isArray(value['rules'])) return ['rules-global rules must be an array'];
      const store = parseStore(JSON.stringify(value));
      if ((value['rules'] as unknown[]).length !== store.rules.length) {
        return ['rules-global contains invalid rule entries'];
      }
    }
    return [];
  }
  return [`unknown section: ${section}`];
}

function writeSection(section: string, value: Record<string, unknown>): void {
  if (section === 'keybindings') {
    atomicWrite(keybindingsFile(), JSON.stringify(value['items'] ?? []));
    return;
  }
  if (section === 'rules-global') {
    const store = parseStore(JSON.stringify(value));
    writeStoreFile(rulesFile(), store);
    return;
  }
  throw new SettingsyncRouteError(`unknown section: ${section}`, 'unknown-section', 400);
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(new SettingsyncRouteError('body too large', 'body-too-large', 413));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readBodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SettingsyncRouteError('body must be a JSON object', 'invalid-json', 400);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SettingsyncRouteError) throw e;
    throw new SettingsyncRouteError('body is not valid JSON', 'invalid-json', 400);
  }
}

function parseDoc(body: Record<string, unknown>): SyncDoc {
  const v = validateSyncDoc(body['doc'] ?? body);
  if (!v.ok || !v.doc) {
    throw new SettingsyncRouteError(`invalid sync document: ${v.errors.join('; ')}`, 'invalid-doc', 400);
  }
  for (const [section, value] of Object.entries(v.doc.sections)) {
    const issues = validateSectionValue(section, value);
    if (issues.length > 0) {
      throw new SettingsyncRouteError(`invalid section ${section}: ${issues.join('; ')}`, 'invalid-section', 400);
    }
  }
  return v.doc;
}

function auditUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid';
  }
}

export async function handleSettingsyncRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith(PREFIX)) return false;
  const rest = path.slice(PREFIX.length);

  try {
    if (rest === '/export' && method === 'GET') {
      const doc = createExport(readCurrentSections());
      ctx.json(res, 200, { doc });
      return true;
    }

    if (rest === '/preview' && method === 'POST') {
      const body = await readBodyJson(req);
      const doc = parseDoc(body);
      const current = readCurrentSections();
      const entries = diffSections(doc.sections, current, readBaseline());
      ctx.json(res, 200, { entries, summary: diffSummary(entries), baseline: readBaseline() !== null });
      return true;
    }

    if (rest === '/apply' && method === 'POST') {
      const body = await readBodyJson(req);
      const doc = parseDoc(body);
      const resolutions = (body['resolutions'] ?? {}) as Resolutions;
      if (typeof resolutions !== 'object' || Array.isArray(resolutions)) {
        throw new SettingsyncRouteError('resolutions must be an object', 'invalid-resolutions', 400);
      }
      const current = readCurrentSections();
      let result;
      try {
        result = applySections(doc.sections, current, readBaseline(), resolutions);
      } catch (e) {
        throw new SettingsyncRouteError((e as Error).message, 'unresolved-entries', 409);
      }
      // Validate every incoming section value again right before
      // writing, then write only the document's sections; sections
      // absent from the document keep their local files untouched.
      for (const section of Object.keys(doc.sections)) {
        const issues = validateSectionValue(section, result.next[section] ?? {});
        if (issues.length > 0) {
          throw new SettingsyncRouteError(`invalid section ${section}: ${issues.join('; ')}`, 'invalid-section', 400);
        }
      }
      for (const section of Object.keys(doc.sections)) {
        writeSection(section, result.next[section] ?? {});
      }
      writeBaseline(result.next);
      ctx.audit.record('human', SETTINGSYNC_APPLIED_ACTION, 'settingsync', 'apply', {
        keys: result.applied,
        kept: result.kept,
      });
      ctx.json(res, 200, { applied: result.applied, kept: result.kept });
      return true;
    }

    if (rest === '/remote' && method === 'GET') {
      ctx.json(res, 200, { url: readRemoteUrl(), tokenConfigured: resolveRemoteToken() !== null });
      return true;
    }

    if (rest === '/remote' && method === 'PUT') {
      const body = await readBodyJson(req);
      const rawUrl = body['url'];
      if (rawUrl !== null && typeof rawUrl !== 'string') {
        throw new SettingsyncRouteError('url must be a string or null', 'invalid-url', 400);
      }
      const checked = rawUrl === null ? null : validateRemoteUrl(rawUrl);
      atomicWrite(remoteFile(), JSON.stringify({ url: checked }));
      ctx.audit.record('human', SETTINGSYNC_REMOTE_ACTION, 'settingsync', 'remote', {
        url: checked === null ? null : auditUrl(checked),
      });
      ctx.json(res, 200, { url: checked, tokenConfigured: resolveRemoteToken() !== null });
      return true;
    }

    if (rest === '/remote/push' && method === 'POST') {
      const remoteUrl = readRemoteUrl();
      if (!remoteUrl) {
        throw new SettingsyncRouteError('no remote configured', 'no-remote', 409);
      }
      const doc = createExport(readCurrentSections());
      await pushRemote(remoteUrl, doc, resolveRemoteToken());
      ctx.audit.record('human', SETTINGSYNC_PUSHED_ACTION, 'settingsync', 'remote', {
        sections: Object.keys(doc.sections),
        url: auditUrl(remoteUrl),
      });
      ctx.json(res, 200, { pushed: true, sections: Object.keys(doc.sections) });
      return true;
    }

    if (rest === '/remote/pull' && method === 'POST') {
      const remoteUrl = readRemoteUrl();
      if (!remoteUrl) {
        throw new SettingsyncRouteError('no remote configured', 'no-remote', 409);
      }
      const doc = await pullRemote(remoteUrl, resolveRemoteToken());
      const current = readCurrentSections();
      const entries = diffSections(doc.sections, current, readBaseline());
      ctx.json(res, 200, { doc, entries, summary: diffSummary(entries), baseline: readBaseline() !== null });
      return true;
    }

    ctx.json(res, 404, { error: `unknown settingsync route: ${method} ${rest}`, code: 'not-found' });
    return true;
  } catch (e) {
    if (e instanceof SettingsyncRouteError) {
      ctx.json(res, e.status, { error: e.message, code: e.code });
      return true;
    }
    throw e;
  }
}

/** Default global-rules dir, mirroring the rules route's own default. */
export function defaultGlobalRulesDir(): string {
  return (
    process.env['AI_FACTORY_GLOBAL_RULES_DIR'] ?? join(homedir(), '.ai-factory', 'rules')
  );
}
