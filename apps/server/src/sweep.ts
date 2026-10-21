/**
 * sweep.yaml — repository-level Issue → task automation convention (Sweep-style).
 *
 * A project may carry `.ai-factory/sweep.yaml`: a declarative file that maps
 * EXTERNAL events (issues, alerts, …) onto task-template launches. The file
 * is a *convention*, not a live integration: there is no webhook receiver —
 * events are ingested by an explicit operator action (POST /api/sweep/ingest
 * or a cron/scheduler job the operator configures). GitHub webhook direct
 * wiring is a Tan-side networking decision and is deliberately NOT built.
 *
 * Safety posture (W-B injection lesson, two layers):
 *   1. Operator-authored config text (rule names, title templates, literal
 *      param values) is scanned at load: an override attempt refuses the
 *      rule — a standing rule that fires on every matching event must not
 *      smuggle directives.
 *   2. Event content is DECLARED external: every event-derived value is
 *      passed through sanitizeUntrusted (declared source 'external') before
 *      it reaches a template prompt. Task titles use a stricter
 *      display-only variant (directive lines stripped).
 *   3. Ingest NEVER executes: created tasks are filed with
 *      authorizationStatus 'WAITING_HUMAN_DISPATCH' (creator 'sweep') and
 *      surface in the existing Dispatch panel for human confirm/reject.
 *      No run is started by the sweep path.
 *
 * Determinism: YAML parsing reuses @ai-factory/policy's hand-written
 * subset parser (zero deps, fail-closed with line numbers). Rule matching
 * is first-match-wins over (priority desc, document order) — fully
 * deterministic. Regexes are operator-authored and compiled at load;
 * they are tested against title/body truncated to a documented bound so a
 * hostile event cannot turn a sloppy pattern into an unbounded scan.
 *
 * This module is node builtins + @ai-factory/policy + @ai-factory/security
 * only, so server tests can import it straight from src (dual-mode rule).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseYaml, YamlParseError } from '@ai-factory/policy';
import type { YamlMap, YamlNode } from '@ai-factory/policy';
import { classifyContent, sanitizeUntrusted } from '@ai-factory/security';

export const SWEEP_FILE_NAME = '.ai-factory/sweep.yaml';
/** Max sweep.yaml size — larger files are refused, not truncated. */
export const MAX_SWEEP_FILE_BYTES = 256 * 1024;
export const MAX_RULES = 64;
/** Operator regexes longer than this are refused (ReDoS surface cap). */
export const MAX_REGEX_LENGTH = 200;
/** Title/body chars actually tested against title_regex/body_regex. */
export const REGEX_TEST_CHARS = 4000;

export class SweepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SweepError';
  }
}

/** Resolve the sweep.yaml path: env override wins, else <projectDir>/.ai-factory/sweep.yaml. */
export function sweepFilePath(projectDir: string): string {
  const fromEnv = process.env['AI_FACTORY_SWEEP_FILE'];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(resolve(projectDir), SWEEP_FILE_NAME);
}

// ------------------------------------------------------------ schema ----

export type SweepPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
const PRIORITIES: readonly string[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

export type ParamSource =
  | 'title'
  | 'body'
  | 'source'
  | 'url'
  | 'external_id'
  | `label:${string}`;

export interface SweepParamFill {
  /** Event field source, or `label:<name>`. Mutually exclusive with `value`. */
  from?: ParamSource;
  /** Operator-authored literal (scanned for override attempts at load). */
  value?: string;
  /** Truncation bound for the filled value, 1..20000. Default 4000. */
  maxLength?: number;
}

export interface SweepRuleWhen {
  source?: string;
  labels?: string[];
  labelsAll?: string[];
  titleRegex?: string;
  bodyRegex?: string;
}

export interface SweepRuleThen {
  /** Task template id, or `name:<template name>`. */
  template: string;
  /** Task title template; {{title}} {{body}} {{source}} {{url}} {{external_id}}. */
  title?: string;
  priority?: SweepPriority;
  params?: Record<string, SweepParamFill>;
}

export interface SweepRule {
  id: string;
  name?: string;
  enabled: boolean;
  priority: number;
  when: SweepRuleWhen;
  then: SweepRuleThen;
  /** Compiled matchers — built at validation, not part of the file format. */
  _titleRe?: RegExp;
  _bodyRe?: RegExp;
}

export interface SweepConfig {
  version: 1;
  rules: SweepRule[];
}

export interface InvalidRule {
  id: string;
  reason: string;
}

export interface SweepConfigLoad {
  path: string;
  exists: boolean;
  /** Whole-file failure (unreadable / bad YAML / bad version). Fail-closed. */
  loadError?: string;
  config: SweepConfig;
  /** Rules refused individually; the rest of the file still works. */
  invalidRules: InvalidRule[];
}

// ------------------------------------------------------------ events ----

export interface SweepEvent {
  source: string;
  labels: string[];
  title: string;
  body: string;
  url?: string;
  externalId?: string;
}

const MAX_SOURCE = 64;
const MAX_TITLE = 500;
const MAX_BODY = 20000;
const MAX_URL = 500;
const MAX_EXTERNAL_ID = 128;
const MAX_LABELS = 32;
const MAX_LABEL_LEN = 64;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** Strict event validation — the route turns SweepError into 400. */
export function validateSweepEvent(raw: unknown): SweepEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SweepError('event must be an object');
  }
  const r = raw as Record<string, unknown>;
  const source = r['source'];
  if (!isStr(source) || !source.trim() || source.length > MAX_SOURCE) {
    throw new SweepError(`event.source is required (1..${MAX_SOURCE} chars)`);
  }
  const title = r['title'];
  if (!isStr(title) || !title.trim() || title.length > MAX_TITLE) {
    throw new SweepError(`event.title is required (1..${MAX_TITLE} chars)`);
  }
  const labels: string[] = [];
  if (r['labels'] !== undefined) {
    if (!Array.isArray(r['labels'])) throw new SweepError('event.labels must be an array');
    if (r['labels'].length > MAX_LABELS) throw new SweepError(`event.labels: at most ${MAX_LABELS}`);
    for (const l of r['labels']) {
      if (!isStr(l) || !l.trim() || l.length > MAX_LABEL_LEN) {
        throw new SweepError('event.labels entries must be 1..64 char strings');
      }
      labels.push(l.trim());
    }
  }
  const body = r['body'];
  if (body !== undefined && (!isStr(body) || body.length > MAX_BODY)) {
    throw new SweepError(`event.body must be a string ≤ ${MAX_BODY} chars`);
  }
  const url = r['url'];
  if (url !== undefined && (!isStr(url) || !url.trim() || url.length > MAX_URL || /\s/.test(url))) {
    throw new SweepError(`event.url must be a 1..${MAX_URL} char string without whitespace`);
  }
  const externalId = r['external_id'];
  if (externalId !== undefined && (!isStr(externalId) || !externalId.trim() || externalId.length > MAX_EXTERNAL_ID)) {
    throw new SweepError(`event.external_id must be a 1..${MAX_EXTERNAL_ID} char string`);
  }
  return {
    source: source.trim(),
    labels,
    title: title.trim(),
    body: isStr(body) ? body : '',
    ...(isStr(url) && url.trim() ? { url: url.trim() } : {}),
    ...(isStr(externalId) && externalId.trim() ? { externalId: externalId.trim() } : {}),
  };
}

// -------------------------------------------------- config loading ----

const RULE_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LABEL_NAME_RE = /^[A-Za-z0-9-_]{1,64}$/;
const FROM_SOURCES = ['title', 'body', 'source', 'url', 'external_id'] as const;

function isMap(v: YamlNode): v is YamlMap {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: YamlNode): string | null {
  return typeof v === 'string' ? v : null;
}

/** Operator-authored standing text must not smuggle directives (layer 1). */
function assertNoOverride(text: string, where: string): string | null {
  const cls = classifyContent(text);
  if (cls.overrideAttempt) {
    return `${where}: injection scan flagged [${cls.reasons.join(', ')}]`;
  }
  return null;
}

interface RuleValidation {
  rule?: SweepRule;
  invalid?: string;
}

function validateRule(node: YamlNode, index: number): RuleValidation {
  const where = `rules[${index}]`;
  if (!isMap(node)) return { invalid: `${where}: rule must be a mapping` };
  const knownRuleKeys = new Set(['id', 'name', 'enabled', 'priority', 'when', 'then']);
  for (const k of Object.keys(node)) {
    if (!knownRuleKeys.has(k)) return { invalid: `${where}: unknown key '${k}'` };
  }
  const id = asString(node['id']);
  if (!id || !RULE_ID_RE.test(id)) {
    return { invalid: `${where}: id is required, [a-z0-9-_], ≤64 chars` };
  }
  const nameRaw = node['name'];
  let name: string | undefined;
  if (nameRaw !== undefined) {
    const n = asString(nameRaw);
    if (n === null || !n.trim() || n.length > 120) {
      return { invalid: `rule '${id}': name must be 1..120 chars` };
    }
    name = n.trim();
    const bad = assertNoOverride(name, `rule '${id}' name`);
    if (bad) return { invalid: bad };
  }
  let enabled = true;
  if (node['enabled'] !== undefined) {
    if (typeof node['enabled'] !== 'boolean') {
      return { invalid: `rule '${id}': enabled must be true/false` };
    }
    enabled = node['enabled'];
  }
  let priority = 0;
  if (node['priority'] !== undefined) {
    const p = node['priority'];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < -1000 || p > 1000) {
      return { invalid: `rule '${id}': priority must be an integer -1000..1000` };
    }
    priority = p;
  }

  // ---- when ----
  const whenNode = node['when'];
  if (whenNode === undefined || whenNode === null) {
    return { invalid: `rule '${id}': when needs at least one condition` };
  }
  if (!isMap(whenNode)) return { invalid: `rule '${id}': when is required (mapping)` };
  const knownWhenKeys = new Set(['source', 'labels', 'labels_all', 'title_regex', 'body_regex']);
  for (const k of Object.keys(whenNode)) {
    if (!knownWhenKeys.has(k)) return { invalid: `rule '${id}': when: unknown key '${k}'` };
  }
  const when: SweepRuleWhen = {};
  const wv = validateWhen(whenNode, id);
  if (wv.invalid) return { invalid: wv.invalid };
  Object.assign(when, wv.when);
  const compiledTitleRe = wv.titleRe;
  const compiledBodyRe = wv.bodyRe;

  // ---- then ----
  const thenNode = node['then'];
  if (!isMap(thenNode)) return { invalid: `rule '${id}': then is required (mapping)` };
  const then = validateThen(thenNode, id);
  if (then.invalid) return { invalid: then.invalid };

  const rule: SweepRule = {
    id,
    ...(name ? { name } : {}),
    enabled,
    priority,
    when,
    then: then.then!,
    ...(compiledTitleRe ? { _titleRe: compiledTitleRe } : {}),
    ...(compiledBodyRe ? { _bodyRe: compiledBodyRe } : {}),
  };
  return { rule };
}

function validateWhen(
  whenNode: YamlMap,
  id: string,
): { when?: SweepRuleWhen; invalid?: string; titleRe?: RegExp; bodyRe?: RegExp } {
  const when: SweepRuleWhen = {};
  let titleRe: RegExp | undefined;
  let bodyRe: RegExp | undefined;
  let conditions = 0;

  const src = whenNode['source'];
  if (src !== undefined) {
    const s = asString(src);
    if (s === null || !s.trim() || s.length > MAX_SOURCE) {
      return { invalid: `rule '${id}': when.source must be 1..${MAX_SOURCE} chars` };
    }
    when.source = s.trim();
    conditions++;
  }
  for (const key of ['labels', 'labels_all'] as const) {
    const lv = whenNode[key];
    if (lv !== undefined) {
      if (!Array.isArray(lv)) return { invalid: `rule '${id}': when.${key} must be a list` };
      if (lv.length === 0) return { invalid: `rule '${id}': when.${key} must not be empty` };
      if (lv.length > MAX_LABELS) {
        return { invalid: `rule '${id}': when.${key}: at most ${MAX_LABELS} labels` };
      }
      const out: string[] = [];
      for (const l of lv) {
        const s = asString(l);
        if (s === null || !s.trim() || s.length > MAX_LABEL_LEN || !LABEL_NAME_RE.test(s.trim())) {
          return { invalid: `rule '${id}': when.${key} entries must be [A-Za-z0-9-_], 1..64 chars` };
        }
        out.push(s.trim().toLowerCase());
      }
      if (key === 'labels') when.labels = out;
      else when.labelsAll = out;
      conditions++;
    }
  }
  for (const key of ['title_regex', 'body_regex'] as const) {
    const rv = whenNode[key];
    if (rv !== undefined) {
      const s = asString(rv);
      if (s === null || !s || s.length > MAX_REGEX_LENGTH) {
        return { invalid: `rule '${id}': when.${key} must be 1..${MAX_REGEX_LENGTH} chars` };
      }
      try {
        const re = new RegExp(s);
        if (key === 'title_regex') titleRe = re;
        else bodyRe = re;
      } catch {
        return { invalid: `rule '${id}': when.${key} is not a valid regex` };
      }
      if (key === 'title_regex') when.titleRegex = s;
      else when.bodyRegex = s;
      conditions++;
    }
  }
  if (conditions === 0) {
    return { invalid: `rule '${id}': when needs at least one condition` };
  }
  return { when, ...(titleRe ? { titleRe } : {}), ...(bodyRe ? { bodyRe } : {}) };
}

function validateThen(
  thenNode: YamlMap,
  id: string,
): { then?: SweepRuleThen; titleRe?: RegExp; bodyRe?: RegExp; invalid?: string } {
  const knownThenKeys = new Set(['template', 'title', 'priority', 'params']);
  for (const k of Object.keys(thenNode)) {
    if (!knownThenKeys.has(k)) return { invalid: `rule '${id}': then: unknown key '${k}'` };
  }
  const tpl = asString(thenNode['template']);
  if (!tpl || !tpl.trim() || tpl.length > 200) {
    return { invalid: `rule '${id}': then.template is required (template id or name:<name>)` };
  }
  const then: SweepRuleThen = { template: tpl.trim() };

  const titleTpl = thenNode['title'];
  if (titleTpl !== undefined) {
    const t = asString(titleTpl);
    if (t === null || !t.trim() || t.length > 500) {
      return { invalid: `rule '${id}': then.title must be 1..500 chars` };
    }
    const bad = assertNoOverride(t, `rule '${id}' then.title`);
    if (bad) return { invalid: bad };
    then.title = t;
  }
  const prio = thenNode['priority'];
  if (prio !== undefined) {
    const p = asString(prio);
    if (p === null || !PRIORITIES.includes(p)) {
      return { invalid: `rule '${id}': then.priority must be P0..P4` };
    }
    then.priority = p as SweepPriority;
  }
  const paramsNode = thenNode['params'];
  if (paramsNode !== undefined) {
    if (!isMap(paramsNode)) return { invalid: `rule '${id}': then.params must be a mapping` };
    const params: Record<string, SweepParamFill> = {};
    for (const [pname, pnode] of Object.entries(paramsNode)) {
      if (!PARAM_NAME_RE.test(pname)) {
        return { invalid: `rule '${id}': param name '${pname}' must match [A-Za-z_][A-Za-z0-9_]*` };
      }
      if (!isMap(pnode)) {
        return { invalid: `rule '${id}': param '${pname}' must be a mapping ({from|value})` };
      }
      const knownParamKeys = new Set(['from', 'value', 'max_length']);
      for (const k of Object.keys(pnode)) {
        if (!knownParamKeys.has(k)) {
          return { invalid: `rule '${id}': param '${pname}': unknown key '${k}'` };
        }
      }
      const fill: SweepParamFill = {};
      const fromRaw = pnode['from'];
      const valueRaw = pnode['value'];
      if (fromRaw !== undefined && valueRaw !== undefined) {
        return { invalid: `rule '${id}': param '${pname}': from and value are mutually exclusive` };
      }
      if (fromRaw === undefined && valueRaw === undefined) {
        return { invalid: `rule '${id}': param '${pname}' needs from or value` };
      }
      if (fromRaw !== undefined) {
        const f = asString(fromRaw);
        if (f === null) return { invalid: `rule '${id}': param '${pname}'.from must be a string` };
        const ft = f.trim();
        if ((FROM_SOURCES as readonly string[]).includes(ft)) {
          fill.from = ft as ParamSource;
        } else if (ft.startsWith('label:')) {
          const lname = ft.slice('label:'.length).trim();
          if (!LABEL_NAME_RE.test(lname)) {
            return { invalid: `rule '${id}': param '${pname}'.from label name invalid` };
          }
          fill.from = `label:${lname.toLowerCase()}` as ParamSource;
        } else {
          return {
            invalid: `rule '${id}': param '${pname}'.from must be title|body|source|url|external_id|label:<name>`,
          };
        }
      } else {
        const v = asString(valueRaw);
        if (v === null || v.length > 4000) {
          return { invalid: `rule '${id}': param '${pname}'.value must be a string ≤4000 chars` };
        }
        const bad = assertNoOverride(v, `rule '${id}' param '${pname}' literal`);
        if (bad) return { invalid: bad };
        fill.value = v;
      }
      const ml = pnode['max_length'];
      if (ml !== undefined) {
        if (typeof ml !== 'number' || !Number.isInteger(ml) || ml < 1 || ml > 20000) {
          return { invalid: `rule '${id}': param '${pname}'.max_length must be 1..20000` };
        }
        fill.maxLength = ml;
      }
      params[pname] = fill;
    }
    then.params = params;
  }
  return { then };
}

/**
 * Load + validate a project's sweep.yaml.
 * Missing file → exists:false (not an error). Unreadable/oversize/bad YAML/
 * bad version → loadError (whole file refused, fail-closed). Individual bad
 * rules are reported in invalidRules and skipped; the rest still work.
 */
export function loadSweepConfig(projectDir: string): SweepConfigLoad {
  const path = sweepFilePath(projectDir);
  const base: SweepConfigLoad = { path, exists: false, config: { version: 1, rules: [] }, invalidRules: [] };
  let raw: string;
  try {
    if (!existsSync(path)) return base;
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ...base, exists: true, loadError: `sweep.yaml unreadable: ${(e as Error).message}` };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SWEEP_FILE_BYTES) {
    return { ...base, exists: true, loadError: `sweep.yaml exceeds ${MAX_SWEEP_FILE_BYTES} bytes` };
  }
  let node: YamlNode;
  try {
    node = parseYaml(raw);
  } catch (e) {
    const line = e instanceof YamlParseError ? ` (line ${e.line})` : '';
    return { ...base, exists: true, loadError: `sweep.yaml YAML error${line}: ${(e as Error).message}` };
  }
  if (node === null) {
    return { ...base, exists: true, loadError: 'sweep.yaml is empty' };
  }
  if (!isMap(node)) {
    return { ...base, exists: true, loadError: 'sweep.yaml root must be a mapping' };
  }
  for (const k of Object.keys(node)) {
    if (k !== 'version' && k !== 'rules') {
      return { ...base, exists: true, loadError: `sweep.yaml: unknown top-level key '${k}'` };
    }
  }
  if (node['version'] !== 1) {
    return { ...base, exists: true, loadError: 'sweep.yaml: version must be 1' };
  }
  const rulesNode = node['rules'];
  const rules: SweepRule[] = [];
  const invalidRules: InvalidRule[] = [];
  if (rulesNode !== undefined) {
    if (!Array.isArray(rulesNode)) {
      return { ...base, exists: true, loadError: 'sweep.yaml: rules must be a list' };
    }
    if (rulesNode.length > MAX_RULES) {
      return { ...base, exists: true, loadError: `sweep.yaml: at most ${MAX_RULES} rules` };
    }
    const seen = new Set<string>();
    rulesNode.forEach((rn, i) => {
      const v = validateRule(rn, i);
      if (v.rule) {
        if (seen.has(v.rule.id)) {
          invalidRules.push({ id: v.rule.id, reason: `duplicate rule id '${v.rule.id}'` });
          return;
        }
        seen.add(v.rule.id);
        rules.push(v.rule);
      } else {
        invalidRules.push({ id: guessRuleId(rn), reason: v.invalid ?? 'invalid rule' });
      }
    });
  }
  return { ...base, exists: true, config: { version: 1, rules }, invalidRules };
}

function guessRuleId(node: YamlNode): string {
  if (isMap(node)) {
    const id = asString(node['id']);
    if (id) return id;
  }
  return '(unknown)';
}

// --------------------------------------------------- matching ----

export interface RuleMatch {
  rule: SweepRule;
  /** Document order (0-based) — the deterministic tiebreak after priority. */
  order: number;
}

function truncateForRegex(s: string): string {
  return s.length > REGEX_TEST_CHARS ? s.slice(0, REGEX_TEST_CHARS) : s;
}

function ruleMatches(rule: SweepRule, event: SweepEvent): boolean {
  if (!rule.enabled) return false;
  const w = rule.when;
  if (w.source !== undefined && event.source !== w.source) return false;
  if (w.labels !== undefined) {
    const have = new Set(event.labels.map((l) => l.toLowerCase()));
    if (!w.labels.some((l) => have.has(l))) return false;
  }
  if (w.labelsAll !== undefined) {
    const have = new Set(event.labels.map((l) => l.toLowerCase()));
    if (!w.labelsAll.every((l) => have.has(l))) return false;
  }
  if (rule._titleRe && !rule._titleRe.test(truncateForRegex(event.title))) return false;
  if (rule._bodyRe && !rule._bodyRe.test(truncateForRegex(event.body))) return false;
  return true;
}

/**
 * All matching rules, ordered deterministically: priority desc, then
 * document order. The caller (ingest) takes the first that fills
 * completely; dry-run reports all of them.
 */
export function matchSweepRules(config: SweepConfig, event: SweepEvent): RuleMatch[] {
  const matched: RuleMatch[] = [];
  config.rules.forEach((rule, order) => {
    if (ruleMatches(rule, event)) matched.push({ rule, order });
  });
  matched.sort((a, b) => b.rule.priority - a.rule.priority || a.order - b.order);
  return matched;
}

// ------------------------------------------------- param / title ----

/** Layer-2 choke point: every event-derived value is declared external. */
function quarantineExternal(value: string): string {
  return sanitizeUntrusted(value, { source: 'external' }).sanitized;
}

/**
 * Title-display hardening: directive-shaped lines are stripped, the rest
 * is collapsed to one line and truncated. The task title is operator- and
 * agent-visible; it must not carry instructions.
 */
const TITLE_STRIP_RES: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+instructions?/i,
  /forget\s+(your|the)\s+(system|prior|original)\s+(instructions?|prompt)/i,
  /you\s+are\s+now\b/i,
  /^\s*(run|execute|delete|remove|send|upload|post|disclose|reveal|leak|disable|bypass)\b/i,
];

export function titleSafe(text: string, maxLen = 200): string {
  const kept = text
    .split('\n')
    .filter((line) => !TITLE_STRIP_RES.some((re) => re.test(line)))
    .join(' ');
  const collapsed = kept.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
}

const TITLE_VARS: Record<string, (e: SweepEvent) => string> = {
  title: (e) => e.title,
  body: (e) => e.body,
  source: (e) => e.source,
  url: (e) => e.url ?? '',
  external_id: (e) => e.externalId ?? '',
};

function fillTitleTemplate(tpl: string | undefined, event: SweepEvent, fallbackName: string): string {
  if (!tpl) {
    const snippet = titleSafe(event.title, 120);
    return `[sweep] ${snippet || fallbackName}`;
  }
  const filled = tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_whole, name: string) => {
    const fn = TITLE_VARS[name];
    if (!fn) return _whole;
    return titleSafe(fn(event), name === 'body' ? 300 : 200);
  });
  return titleSafe(filled, 200) || `[sweep] ${fallbackName}`;
}

function resolveParamSource(from: ParamSource, event: SweepEvent): string {
  switch (from) {
    case 'title':
      return event.title;
    case 'body':
      return event.body;
    case 'source':
      return event.source;
    case 'url':
      return event.url ?? '';
    case 'external_id':
      return event.externalId ?? '';
    default: {
      // `label:<name>`
      const lname = from.slice('label:'.length);
      const found = event.labels.find((l) => l.toLowerCase() === lname);
      return found ?? '';
    }
  }
}

export interface LaunchBuild {
  /** Sanitized params, ready for renderPrompt. */
  params: Record<string, string>;
  /** Display-safe task title. */
  title: string;
}

/**
 * Build launch params + title for a matched rule. Event-derived values go
 * through sanitizeUntrusted (declared external); operator literals pass
 * through (they were override-scanned at load). Everything is truncated
 * to its max_length.
 */
export function buildLaunch(rule: SweepRule, event: SweepEvent, templateName: string): LaunchBuild {
  const params: Record<string, string> = {};
  for (const [pname, fill] of Object.entries(rule.then.params ?? {})) {
    const maxLen = fill.maxLength ?? 4000;
    let raw: string;
    let external: boolean;
    if (fill.value !== undefined) {
      raw = fill.value;
      external = false;
    } else {
      raw = resolveParamSource(fill.from!, event);
      external = true;
    }
    if (raw.length > maxLen) raw = raw.slice(0, maxLen);
    params[pname] = external ? quarantineExternal(raw) : raw;
  }
  return { params, title: fillTitleTemplate(rule.then.title, event, templateName) };
}
