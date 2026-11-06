/**
 * Egress firewall — fine-grained outbound allowlist (second-round
 * task ⑦, GitHub Copilot coding-agent egress allowlist style).
 *
 * Three config layers, merged at evaluation time:
 *
 *   global   <AI_FACTORY_DATA_DIR|data>/egress.json
 *            { enabled, defaultPolicy, rules } — the master switch and
 *            the default policy live ONLY here.
 *   project  <projectDir>/.ai-factory/egress.json
 *            { rules } — per-project additional rules.
 *   task     same project file, `tasks: { "<taskId>": { rules } }` —
 *            per-task rules, evaluated for checks carrying a taskId.
 *
 * Merge semantics (fixed, not configurable):
 *   1. A DENY rule matching in ANY layer refuses the call (deny beats
 *      allow across layers; layers are scanned task → project → global
 *      only so the verdict can report the most specific match).
 *   2. Otherwise an ALLOW rule matching in any layer allows the call.
 *   3. Otherwise the global defaultPolicy decides ('deny' = allowlist
 *      mode, the recommended default; 'allow' = denylist mode).
 * When the firewall is DISABLED (explicitly, by operator choice), every
 * call is allowed and NOTHING is audited or logged — a disabled firewall
 * must not spam the audit trail with noise.
 *
 * FACTORY DEFAULT (third-round hardening, V3-#5): a fresh install with
 * NO egress.json on disk starts ENABLED with defaultPolicy 'deny' — an
 * unlisted outbound target is refused and audited. This tightened
 * default applies ONLY to the missing-file case: an existing egress.json
 * is never silently rewritten (it is reported as `legacy` until it is
 * next written by current code, and the wizard merges into it without
 * deleting its rules). An operator who wants the old permissive posture
 * chooses dev-mode in the wizard explicitly — an audited, explicit
 * choice, not a silent default.
 *
 * Rule shape: { domain, pathPrefix?, action: 'allow'|'deny', note? }.
 *
 * MATCHING SEMANTICS (deliberately simple, string-level, documented):
 *   - Domain matching is SUFFIX matching: a rule for `example.com`
 *     matches `example.com` AND every subdomain (`api.example.com`,
 *     `a.b.example.com`). There is no wildcard syntax; `*.example.com`
 *     is rejected at validation time because subdomains are included
 *     by construction.
 *   - Ports are NOT distinguished: a rule covers every port of the
 *     host it matches.
 *   - pathPrefix matches when the URL's pathname starts with it
 *     (a missing leading '/' is normalized to '/…'). No prefix = all
 *     paths.
 *   - IP literals are matched as plain host strings: a rule whose
 *     domain is the exact IP literal matches; suffix/subdomain logic
 *     does NOT apply to IPs. CONSEQUENCE (honest boundary): an IP
 *     address is NOT the domain it happens to resolve to —
 *     `https://93.184.216.34/` is a different host from `example.com`
 *     and needs its own rule (or the default policy decides). DNS
 *     resolution is never inspected, so a hostname allowed by rule
 *     may still resolve anywhere (DNS rebinding is out of scope).
 *   - Loopback hosts (localhost, 127.0.0.0/8, ::1) are ALWAYS allowed,
 *     even when the firewall is enabled: the server's own local
 *     surfaces (MCP server-mode bridge, local dev servers) live there,
 *     and this mirrors the RFC 8252 loopback carve-out already used by
 *     the MCP HTTP transport. Loopback traffic never leaves the host.
 *   - Non-http(s) URLs are refused when the firewall is enabled.
 *
 * ENFORCEMENT POINTS (real outbound call sites, wired in index.ts):
 *   - @ai-factory/search fetchText (web_search tool + /api/search):
 *     process guard → global layer.
 *   - @ai-factory/mcp doHttpRequest (remote MCP Streamable HTTP AND
 *     the OAuth 2.1 discovery / metadata / token fetches): process
 *     guard → global layer.
 *   - /api/search route: pre-checks the configured providers' endpoint
 *     URLs with project-layer context (projectId from the request).
 *   - Scheduler webhook fetch (routes/schedules.ts): checks the job
 *     URL before dialing (global layer; webhook jobs carry no
 *     project/task context).
 *   - POST /api/mcp/remote/connect: pre-checks the server URL.
 *
 * HONEST BOUNDARIES (also surfaced in the UI):
 *   - This gates the server's own tool/proxy egress paths ONLY. It is
 *     NOT a host firewall: exec/shell commands dialing out directly,
 *     the user's browser, OS services and any other process are NOT
 *     constrained by these rules. (Shell network isolation is the
 *     bwrap sandbox tiers' job, a separate existing capability.)
 *   - A blocked call is recorded in three places: the EGRESS_BLOCKED
 *     audit record, an EGRESS_BLOCKED notification (HIGH), and this
 *     module's in-memory block log (GET /api/egress/log; the log is
 *     process-memory only and resets on restart — the audit record is
 *     the durable trail).
 *
 * Dual-mode note: this module imports node builtins plus the compiled
 * @ai-factory/diagpack package (stripUserinfoFromText, R19 N6 — the
 * package resolves to compiled dist via node_modules, same as
 * routes/httpclient.ts), so server tests may import it straight from
 * src with type-stripping.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { stripUserinfoFromText } from '@ai-factory/diagpack';

export const EGRESS_DATA_DIR_ENV = 'AI_FACTORY_DATA_DIR';
export const EGRESS_BLOCKED_CODE = 'EGRESS_BLOCKED';
/** Project-layer file, relative to a project working directory. */
export const EGRESS_PROJECT_FILE = '.ai-factory/egress.json';
/** Hard cap on rules per layer (config sanity, not a security control). */
export const EGRESS_MAX_RULES = 500;
/** Hard cap on the in-memory block log. */
export const EGRESS_BLOCK_LOG_CAP = 200;

export type EgressAction = 'allow' | 'deny';
export type EgressLayerName = 'global' | 'project' | 'task';
export type EgressDefaultPolicy = 'allow' | 'deny';

export interface EgressRule {
  domain: string;
  /** Optional URL path prefix (e.g. '/v1/'); absent = all paths. */
  pathPrefix?: string;
  action: EgressAction;
  note?: string;
}

export interface EgressGlobalConfig {
  enabled: boolean;
  defaultPolicy: EgressDefaultPolicy;
  rules: EgressRule[];
  updatedAt: string;
  updatedBy: string;
  /**
   * Written by current code (2 = V3-#5 wizard era). Absent on files
   * predating the wizard: such files are reported as `legacy` (kept
   * verbatim, never silently rewritten) until next written.
   */
  policyVersion?: number;
  /** ISO time the first-run wizard last completed (any outcome). */
  wizardCompletedAt?: string;
  /** Which wizard outcome produced this file, if any. */
  wizardMode?: 'templates' | 'dev-mode';
}

/** One wizard template: a bundle of allow rules with plain-language
 * explanation and risk note (UI renders i18n text by id; the server
 * text is the fallback). Rule notes are stamped `wizard-template:<id>`
 * so the provenance of every wizard-added rule stays visible. */
export interface EgressWizardTemplate {
  id: string;
  domains: string[];
  label: string;
  description: string;
  risk: string;
}

export const EGRESS_WIZARD_TEMPLATES: EgressWizardTemplate[] = [
  {
    id: 'npm',
    domains: ['registry.npmjs.org'],
    label: 'npm registry',
    description: 'Node 包安装与元数据查询（npm install / 包信息）。',
    risk: '仅放行 registry 本身；包安装脚本经 shell 出网不受本防火墙约束。',
  },
  {
    id: 'pypi',
    domains: ['pypi.org', 'files.pythonhosted.org'],
    label: 'PyPI',
    description: 'Python 包安装与元数据查询（pip install）。',
    risk: '仅放行 PyPI 本身；包安装脚本经 shell 出网不受本防火墙约束。',
  },
  {
    id: 'github',
    domains: ['github.com', 'api.github.com', 'raw.githubusercontent.com'],
    label: 'GitHub',
    description: '仓库读取、API 调用与原始文件拉取。',
    risk: '放行后任意公开仓库内容均可拉取；私有仓库仍需令牌。',
  },
  {
    id: 'openai',
    domains: ['api.openai.com'],
    label: 'OpenAI API',
    description: '模型端点调用（api.openai.com）。',
    risk: '放行后提示词与代码片段将发往该端点；请确认已配置密钥。',
  },
  {
    id: 'anthropic',
    domains: ['api.anthropic.com'],
    label: 'Anthropic API',
    description: '模型端点调用（api.anthropic.com）。',
    risk: '放行后提示词与代码片段将发往该端点；请确认已配置密钥。',
  },
  {
    id: 'google-ai',
    domains: ['generativelanguage.googleapis.com'],
    label: 'Google AI API',
    description: '模型端点调用（generativelanguage.googleapis.com）。',
    risk: '放行后提示词与代码片段将发往该端点；请确认已配置密钥。',
  },
  {
    id: 'deepseek',
    domains: ['api.deepseek.com'],
    label: 'DeepSeek API',
    description: '模型端点调用（api.deepseek.com）。',
    risk: '放行后提示词与代码片段将发往该端点；请确认已配置密钥。',
  },
  {
    // V3 closeout: the built-in default search provider (Bing RSS) had no
    // first-run path — under the V3-#5 factory default (enabled + deny) a
    // fresh install blocked /api/search with 403 and the wizard offered no
    // template to allow it. This template restores the guided path; the
    // default itself stays deny (search still needs explicit opt-in).
    id: 'web-search',
    domains: ['www.bing.com'],
    label: 'Web search (Bing)',
    description: '内置默认搜索提供方（Bing RSS）的出站查询。',
    risk: '放行后搜索查询将发往 Bing；查询内容不受本防火墙审查。',
  },
];

/** Expand template ids to allow rules (note-stamped with provenance).
 * Returns the rules plus any unknown ids (caller rejects on those). */
export function wizardTemplateRules(ids: string[]): { rules: EgressRule[]; unknownIds: string[] } {
  const byId = new Map(EGRESS_WIZARD_TEMPLATES.map((t) => [t.id, t]));
  const rules: EgressRule[] = [];
  const unknownIds: string[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) {
      unknownIds.push(id);
      continue;
    }
    for (const domain of t.domains) {
      rules.push({ domain, action: 'allow', note: `wizard-template:${t.id}` });
    }
  }
  return { rules, unknownIds };
}

function ruleKey(r: EgressRule): string {
  return `${normalizeHost(r.domain)}|${r.pathPrefix ?? ''}|${r.action}`;
}

/**
 * Pure wizard merge: existing rules are kept VERBATIM and first;
 * additions are appended only when no identical (domain, pathPrefix,
 * action) rule already exists. Nothing is ever deleted here.
 */
export function mergeWizardRules(
  existing: EgressRule[],
  additions: EgressRule[],
): { merged: EgressRule[]; added: EgressRule[]; preserved: number } {
  const seen = new Set(existing.map(ruleKey));
  const added: EgressRule[] = [];
  const merged = [...existing];
  for (const r of additions) {
    if (seen.has(ruleKey(r))) continue;
    seen.add(ruleKey(r));
    merged.push(r);
    added.push(r);
  }
  return { merged, added, preserved: existing.length };
}

/** First-run wizard dismissal state (separate file — dismissing the
 * wizard must never touch egress.json itself). */
export interface EgressWizardState {
  dismissedAt?: string;
}

export interface EgressProjectLayer {
  rules: EgressRule[];
  tasks: Record<string, { rules: EgressRule[] }>;
  /** Set when the file existed but could not be parsed/validated. */
  loadError?: string;
}

export interface EgressLayers {
  global: EgressGlobalConfig;
  project?: { rules: EgressRule[] };
  task?: { rules: EgressRule[] };
}

export type EgressVerdictReason =
  | 'disabled'
  | 'loopback-exempt'
  | 'deny-rule'
  | 'allow-rule'
  | 'default-deny'
  | 'default-allow'
  | 'invalid-url'
  | 'non-http-scheme';

export interface EgressVerdict {
  allowed: boolean;
  reason: EgressVerdictReason;
  /** Hostname parsed from the URL (lowercased, brackets stripped). */
  hostname: string | null;
  matchedLayer?: EgressLayerName;
  matchedRule?: EgressRule;
}

export interface EgressCheckContext {
  /** Call-site label recorded in audit/notification/log (e.g. 'web-search'). */
  source: string;
  /** Project working directory; enables the project (+task) layers. */
  projectDir?: string;
  /** Task id; enables the task layer inside the project file. */
  taskId?: string;
}

export interface EgressBlockEntry {
  at: string;
  url: string;
  hostname: string | null;
  source: string;
  reason: EgressVerdictReason;
  matchedLayer?: EgressLayerName;
  matchedRule?: string;
}

/** Sinks installed by the coordinator (index.ts) so a blocked call also
 * lands in the durable audit trail and the notification center. Both
 * are best-effort: a sink failure never masks the EGRESS_BLOCKED error. */
export interface EgressBlockSinks {
  audit?: (
    actor: string,
    action: string,
    entity: string,
    entityId: string,
    details?: Record<string, unknown>,
  ) => void;
  notify?: (event: {
    type: 'EGRESS_BLOCKED';
    actor?: string;
    entity?: { kind: string; id: string; label?: string };
    detail?: Record<string, unknown>;
  }) => void;
}

/* ------------------------------------------------------------ matching */

/** Normalize a hostname or rule domain for comparison. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** True for loopback hostnames (always exempt — see header). */
export function isLoopbackHostname(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (h === 'localhost' || h === '::1') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  return false;
}

/**
 * Does a rule's domain match this hostname? Suffix semantics for DNS
 * names (the domain itself + all subdomains); exact equality for IP
 * literals (an IP is not the name it resolves to — see header).
 */
export function hostMatchesRule(ruleDomain: string, hostname: string): boolean {
  const domain = normalizeHost(ruleDomain);
  const host = normalizeHost(hostname);
  if (!domain || !host) return false;
  if (isIP(host) !== 0 || isIP(domain) !== 0) return host === domain;
  return host === domain || host.endsWith('.' + domain);
}

function ruleMatchesUrl(rule: EgressRule, parsed: URL, hostname: string): boolean {
  if (!hostMatchesRule(rule.domain, hostname)) return false;
  if (rule.pathPrefix) {
    const prefix = rule.pathPrefix.startsWith('/') ? rule.pathPrefix : '/' + rule.pathPrefix;
    return parsed.pathname.startsWith(prefix);
  }
  return true;
}

/**
 * Pure verdict: evaluate a URL against the merged layers. No I/O, no
 * side effects — this is what the dry-run endpoint and the unit tests
 * exercise; enforcement adds recording on top (assertEgressAllowed).
 */
export function evaluateEgress(url: string, layers: EgressLayers): EgressVerdict {
  const g = layers.global;
  if (!g.enabled) return { allowed: true, reason: 'disabled', hostname: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid-url', hostname: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'non-http-scheme', hostname: normalizeHost(parsed.hostname) || null };
  }
  const hostname = normalizeHost(parsed.hostname);
  if (isLoopbackHostname(hostname)) {
    return { allowed: true, reason: 'loopback-exempt', hostname };
  }
  // Deny wins across layers; scan most-specific first for reporting.
  const ordered: Array<[EgressLayerName, EgressRule[]]> = [
    ['task', layers.task?.rules ?? []],
    ['project', layers.project?.rules ?? []],
    ['global', g.rules],
  ];
  for (const [layer, rules] of ordered) {
    for (const rule of rules) {
      if (rule.action === 'deny' && ruleMatchesUrl(rule, parsed, hostname)) {
        return { allowed: false, reason: 'deny-rule', hostname, matchedLayer: layer, matchedRule: rule };
      }
    }
  }
  for (const [layer, rules] of ordered) {
    for (const rule of rules) {
      if (rule.action === 'allow' && ruleMatchesUrl(rule, parsed, hostname)) {
        return { allowed: true, reason: 'allow-rule', hostname, matchedLayer: layer, matchedRule: rule };
      }
    }
  }
  return g.defaultPolicy === 'deny'
    ? { allowed: false, reason: 'default-deny', hostname }
    : { allowed: true, reason: 'default-allow', hostname };
}

/* ---------------------------------------------------------- validation */

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/;

/** Validate one rule; returns a list of human-readable problems (empty = ok). */
export function validateEgressRule(raw: unknown, where: string): string[] {
  const errs: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${where}: rule must be an object`];
  }
  const r = raw as Record<string, unknown>;
  const domain = typeof r['domain'] === 'string' ? normalizeHost(r['domain']) : '';
  if (!domain) {
    errs.push(`${where}: domain is required`);
  } else if (domain.includes('*')) {
    errs.push(`${where}: wildcards are not supported — a domain rule already covers all subdomains`);
  } else if (isIP(domain) === 0 && !DOMAIN_RE.test(domain)) {
    errs.push(`${where}: invalid domain "${String(r['domain'])}"`);
  }
  if (r['action'] !== 'allow' && r['action'] !== 'deny') {
    errs.push(`${where}: action must be "allow" or "deny"`);
  }
  if (r['pathPrefix'] !== undefined) {
    const p = r['pathPrefix'];
    if (typeof p !== 'string' || p.length === 0 || p.length > 512 || p.includes('\\') || p.includes('#') || p.includes('?')) {
      errs.push(`${where}: pathPrefix must be a URL path prefix string of 1–512 chars (no backslash, ? or #)`);
    }
  }
  if (r['note'] !== undefined && (typeof r['note'] !== 'string' || r['note'].length > 200)) {
    errs.push(`${where}: note must be a string of at most 200 chars`);
  }
  return errs;
}

/** Validate a rules array; returns problems (empty = ok). */
export function validateEgressRules(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) return [`${where}: rules must be an array`];
  if (raw.length > EGRESS_MAX_RULES) return [`${where}: at most ${EGRESS_MAX_RULES} rules per layer`];
  const errs: string[] = [];
  raw.forEach((rule, i) => errs.push(...validateEgressRule(rule, `${where}[${i}]`)));
  return errs;
}

/** Coerce a validated rule into canonical stored form. */
function canonicalRule(r: EgressRule): EgressRule {
  const out: EgressRule = { domain: normalizeHost(r.domain), action: r.action };
  if (r.pathPrefix) out.pathPrefix = r.pathPrefix.startsWith('/') ? r.pathPrefix : '/' + r.pathPrefix;
  if (r.note) out.note = r.note;
  return out;
}

/* --------------------------------------------------------------- store */

/**
 * Factory default for a fresh install (no egress.json): ENABLED +
 * default-deny (V3-#5). This is the tightened default; it applies ONLY
 * when the file is missing.
 */
const DEFAULT_GLOBAL: EgressGlobalConfig = {
  enabled: true,
  defaultPolicy: 'deny',
  rules: [],
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'factory-default',
};

/** Fail-safe for a corrupt/unreadable file: stay DISABLED and surface
 * the error — a corrupt config must neither silently become a
 * block-everything firewall nor silently vanish. */
const CORRUPT_GLOBAL: EgressGlobalConfig = {
  enabled: false,
  defaultPolicy: 'deny',
  rules: [],
  updatedAt: new Date(0).toISOString(),
  updatedBy: 'default',
};

function defaultDataDir(): string {
  const fromEnv = process.env[EGRESS_DATA_DIR_ENV];
  return resolve(fromEnv && fromEnv.trim() ? fromEnv.trim() : 'data');
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

export class EgressStore {
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ? resolve(dataDir) : defaultDataDir();
  }

  globalFile(): string {
    return join(this.dataDir, 'egress.json');
  }

  projectFile(projectDir: string): string {
    return join(resolve(projectDir), EGRESS_PROJECT_FILE);
  }

  /**
   * Read the global layer. Missing file → tightened factory default
   * (enabled + deny, V3-#5) with `factoryDefault: true`.
   * File present but predating the wizard (no policyVersion 2) →
   * `legacy: true`: the file is returned verbatim and is never
   * rewritten by a read; the wizard merges into it without deleting.
   * Corrupt/invalid file → fail SAFE to disabled-with-no-rules and
   * `loadError` (the previous behavior is preserved; a corrupt config
   * must neither silently become a block-everything firewall nor
   * silently vanish). Enforcement itself never guesses.
   */
  getGlobal(): EgressGlobalConfig & { loadError?: string; factoryDefault?: boolean; legacy?: boolean } {
    try {
      const raw = readFileSync(this.globalFile(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<EgressGlobalConfig>;
      const errs = validateEgressRules(parsed.rules ?? [], 'global.rules');
      if (errs.length > 0) return { ...CORRUPT_GLOBAL, loadError: errs.join('; ') };
      const legacy = parsed.policyVersion !== 2 && !parsed.wizardCompletedAt;
      return {
        enabled: parsed.enabled === true,
        defaultPolicy: parsed.defaultPolicy === 'allow' ? 'allow' : 'deny',
        rules: (parsed.rules ?? []).map(canonicalRule),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : CORRUPT_GLOBAL.updatedAt,
        updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : 'unknown',
        ...(parsed.policyVersion !== undefined ? { policyVersion: parsed.policyVersion } : {}),
        ...(parsed.wizardCompletedAt ? { wizardCompletedAt: parsed.wizardCompletedAt } : {}),
        ...(parsed.wizardMode ? { wizardMode: parsed.wizardMode } : {}),
        factoryDefault: false,
        legacy,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_GLOBAL, factoryDefault: true, legacy: false };
      return { ...CORRUPT_GLOBAL, loadError: `egress.json unreadable: ${(e as Error).message}` };
    }
  }

  /** Replace the global layer (validated by the caller / here). Every
   * write by current code stamps policyVersion 2, clearing `legacy`. */
  setGlobal(
    input: { enabled: boolean; defaultPolicy: EgressDefaultPolicy; rules: EgressRule[] },
    actor: string,
    wizard?: { wizardCompletedAt: string; wizardMode: 'templates' | 'dev-mode' },
  ): EgressGlobalConfig {
    const errs = validateEgressRules(input.rules, 'global.rules');
    if (errs.length > 0) throw new Error(errs.join('; '));
    const next: EgressGlobalConfig = {
      enabled: input.enabled,
      defaultPolicy: input.defaultPolicy,
      rules: input.rules.map(canonicalRule),
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
      policyVersion: 2,
      ...(wizard ? { wizardCompletedAt: wizard.wizardCompletedAt, wizardMode: wizard.wizardMode } : {}),
    };
    atomicWriteJson(this.globalFile(), next);
    return next;
  }

  /** Wizard dismissal state file (never egress.json itself). */
  wizardFile(): string {
    return join(this.dataDir, 'egress-wizard.json');
  }

  getWizardState(): EgressWizardState {
    try {
      const parsed = JSON.parse(readFileSync(this.wizardFile(), 'utf8')) as EgressWizardState;
      return parsed && typeof parsed === 'object'
        ? { ...(typeof parsed.dismissedAt === 'string' ? { dismissedAt: parsed.dismissedAt } : {}) }
        : {};
    } catch {
      return {};
    }
  }

  dismissWizard(): EgressWizardState {
    const next: EgressWizardState = { dismissedAt: new Date().toISOString() };
    atomicWriteJson(this.wizardFile(), next);
    return next;
  }

  /** Read the project layer (rules + per-task rules). Never throws. */
  getProjectLayer(projectDir: string): EgressProjectLayer {
    try {
      const raw = readFileSync(this.projectFile(projectDir), 'utf8');
      const parsed = JSON.parse(raw) as { rules?: unknown; tasks?: unknown };
      const errs = validateEgressRules(parsed.rules ?? [], 'project.rules');
      if (errs.length > 0) return { rules: [], tasks: {}, loadError: errs.join('; ') };
      const tasks: Record<string, { rules: EgressRule[] }> = {};
      if (parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks)) {
        for (const [taskId, entry] of Object.entries(parsed.tasks as Record<string, unknown>)) {
          const rules = (entry as { rules?: unknown } | null)?.rules ?? [];
          const terrs = validateEgressRules(rules, `tasks.${taskId}.rules`);
          if (terrs.length === 0) tasks[taskId] = { rules: (rules as EgressRule[]).map(canonicalRule) };
        }
      }
      return { rules: ((parsed.rules ?? []) as EgressRule[]).map(canonicalRule), tasks };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [], tasks: {} };
      return { rules: [], tasks: {}, loadError: `project egress.json unreadable: ${(e as Error).message}` };
    }
  }

  /** Replace the project layer's rules and/or one task's rules. */
  setProjectLayer(
    projectDir: string,
    input: { rules?: EgressRule[]; taskId?: string; taskRules?: EgressRule[] },
  ): EgressProjectLayer {
    const current = this.getProjectLayer(projectDir);
    const next: EgressProjectLayer = {
      rules: current.rules,
      tasks: { ...current.tasks },
    };
    if (input.rules !== undefined) {
      const errs = validateEgressRules(input.rules, 'project.rules');
      if (errs.length > 0) throw new Error(errs.join('; '));
      next.rules = input.rules.map(canonicalRule);
    }
    if (input.taskId !== undefined && input.taskRules !== undefined) {
      const errs = validateEgressRules(input.taskRules, `tasks.${input.taskId}.rules`);
      if (errs.length > 0) throw new Error(errs.join('; '));
      if (input.taskRules.length === 0) delete next.tasks[input.taskId];
      else next.tasks[input.taskId] = { rules: input.taskRules.map(canonicalRule) };
    }
    atomicWriteJson(this.projectFile(projectDir), { rules: next.rules, tasks: next.tasks });
    return next;
  }

  /** Merge all layers for a check context. */
  layersFor(ctx: { projectDir?: string; taskId?: string }): EgressLayers {
    const global = this.getGlobal();
    if (!ctx.projectDir) return { global };
    const proj = this.getProjectLayer(ctx.projectDir);
    const layers: EgressLayers = { global, project: { rules: proj.rules } };
    if (ctx.taskId && proj.tasks[ctx.taskId]) layers.task = { rules: proj.tasks[ctx.taskId]!.rules };
    return layers;
  }
}

/* ---------------------------------------------------- enforcement core */

let singleton: EgressStore | null = null;

/** Module singleton for the production server (lazy). */
export function egressStore(): EgressStore {
  if (!singleton) singleton = new EgressStore();
  return singleton;
}

/** Test hook: drop the singleton so the next use re-reads env/files. */
export function resetEgressStoreForTests(): void {
  singleton = null;
  blockLog.length = 0;
  sinks = {};
}

const blockLog: EgressBlockEntry[] = [];
let sinks: EgressBlockSinks = {};

/** Install audit/notification sinks (coordinator wiring, index.ts). */
export function setEgressBlockSinks(next: EgressBlockSinks): void {
  sinks = { ...next };
}

/** Recent blocked calls, newest first (in-memory; audit is durable). */
export function getEgressBlockLog(limit = 50): EgressBlockEntry[] {
  return blockLog.slice(-Math.max(1, Math.min(limit, EGRESS_BLOCK_LOG_CAP))).reverse();
}

/** Plain Error carrying the EGRESS_BLOCKED code (never a FactoryError,
 * mirroring network-mode's offline error so tool boundaries behave). */
export function egressBlockedError(url: string, verdict: EgressVerdict): Error & { code: string } {
  const why =
    verdict.reason === 'deny-rule'
      ? `denied by the ${verdict.matchedLayer} rule "${verdict.matchedRule ? ruleLabel(verdict.matchedRule) : ''}"`
      : verdict.reason === 'default-deny'
        ? 'no allow rule matched (default-deny)'
        : verdict.reason;
  const e = new Error(`egress blocked: ${url} — ${why}`) as Error & { code: string };
  e.code = EGRESS_BLOCKED_CODE;
  return e;
}

/** Compact label for a rule, used in messages/audit (no note text). */
export function ruleLabel(rule: EgressRule): string {
  return `${rule.action} ${rule.domain}${rule.pathPrefix ?? ''}`;
}

/**
 * Evaluate + record. Returns the verdict; on a refusal it also appends
 * to the block log and fires the audit + notification sinks
 * (best-effort). Callers that must refuse use assertEgressAllowed.
 */
export function checkEgress(url: string, ctx: EgressCheckContext): EgressVerdict {
  const verdict = evaluateEgress(url, egressStore().layersFor(ctx));
  if (!verdict.allowed) {
    // R19 N6: strip embedded credentials BEFORE the entry is built — the
    // audit sink, the notification sink and the in-memory block log all
    // read `entry.url`, so this one change covers all three write points.
    // Strip first, then truncate: userinfo sits at the head of the URL,
    // so slicing first would keep it (a 600-char URL sliced to 512 still
    // carries the whole userinfo segment). Malformed, default-deny and
    // non-http-scheme refusals all walk this branch.
    const entry: EgressBlockEntry = {
      at: new Date().toISOString(),
      url: stripUserinfoFromText(url).slice(0, 512),
      hostname: verdict.hostname,
      source: ctx.source,
      reason: verdict.reason,
      ...(verdict.matchedLayer ? { matchedLayer: verdict.matchedLayer } : {}),
      ...(verdict.matchedRule ? { matchedRule: ruleLabel(verdict.matchedRule) } : {}),
    };
    blockLog.push(entry);
    if (blockLog.length > EGRESS_BLOCK_LOG_CAP) blockLog.splice(0, blockLog.length - EGRESS_BLOCK_LOG_CAP);
    try {
      sinks.audit?.('system', 'EGRESS_BLOCKED', 'egress', verdict.hostname ?? 'unknown-host', {
        url: entry.url,
        source: ctx.source,
        reason: verdict.reason,
        matchedLayer: verdict.matchedLayer ?? null,
        matchedRule: verdict.matchedRule ? ruleLabel(verdict.matchedRule) : null,
      });
    } catch {
      /* audit is best-effort here; the throw below is the enforcement */
    }
    try {
      sinks.notify?.({
        type: 'EGRESS_BLOCKED',
        actor: 'system',
        entity: { kind: 'egress', id: verdict.hostname ?? 'unknown-host', label: `egress to ${verdict.hostname ?? 'unknown host'}` },
        detail: {
          host: verdict.hostname ?? '',
          url: entry.url,
          source: ctx.source,
          reason: verdict.reason,
          matchedLayer: verdict.matchedLayer ?? '',
          matchedRule: verdict.matchedRule ? ruleLabel(verdict.matchedRule) : '',
        },
      });
    } catch {
      /* notification delivery is best-effort (see quality.ts precedent) */
    }
  }
  return verdict;
}

/** Throw egressBlockedError when the verdict refuses the call. */
export function assertEgressAllowed(url: string, ctx: EgressCheckContext): void {
  const verdict = checkEgress(url, ctx);
  if (!verdict.allowed) throw egressBlockedError(url, verdict);
}
