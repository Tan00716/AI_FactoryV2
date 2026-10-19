/**
 * Task template library (server side).
 *
 * Operators save frequently-used dispatch prompts as templates
 * (name + description + prompt with {{variable}} placeholders); anyone can
 * launch a run from a template by filling in the parameters — no more
 * re-typing the same dispatch form every time.
 *
 * Persistence follows the session-store convention: atomic temp+rename
 * writes, fail-closed on corrupt files (serve empty, refuse writes —
 * never silently drop). First boot (no file) seeds three built-in
 * templates; after that the file is the source of truth — deleting all
 * templates stays deleted.
 *
 * Injection safety (W-B lesson), two layers:
 *   1. Template content is operator-authored but still scanned at
 *      creation/update: classifyContent with an override-attempt → the
 *      template is refused (a template is a standing prompt, so a
 *      smuggled "ignore previous instructions" would fire on every
 *      launch). Ordinary instructional prose ("Review the code…")
 *      classifies as INSTRUCTION without an override attempt and is
 *      accepted.
 *   2. Launch parameters are user input: every substituted value goes
 *      through the same emit choke point as notifications — only values
 *      the classifier flags EXTERNAL_CONTENT are wrapped by
 *      sanitizeUntrusted; benign DATA passes through unchanged.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyContent, sanitizeUntrusted } from '@ai-factory/security';

export function taskTemplateStorePath(): string {
  const fromEnv = process.env.AI_FACTORY_TASK_TEMPLATE_STORE_FILE;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const dataDir = process.env.AI_FACTORY_DATA_DIR ?? 'data';
  return resolve(dataDir, 'task-templates.json');
}

export class TaskTemplateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTemplateStoreError';
  }
}

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  /** Prompt text; {{variable}} placeholders are substituted at launch. */
  promptTemplate: string;
  /** Variable names extracted from promptTemplate (in first-use order). */
  variables: string[];
  defaultAgentId?: string;
  defaultPriority?: TaskPriority;
  /** Informational default; runs still obey the server tool allowlist. */
  toolAllowlist?: string[];
  builtIn?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskTemplateInput {
  name: string;
  description?: string;
  promptTemplate: string;
  defaultAgentId?: string;
  defaultPriority?: TaskPriority;
  toolAllowlist?: string[];
  createdBy?: string;
}

const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function extractVariables(promptTemplate: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  VARIABLE_RE.lastIndex = 0;
  for (const m of promptTemplate.matchAll(VARIABLE_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export interface TemplateScanResult {
  safe: boolean;
  reasons: string[];
}

/**
 * Scan operator-authored template text. Only an override attempt
 * ("ignore previous instructions", …) refuses the template — plain
 * instructional prose is the normal shape of a dispatch prompt and
 * must not be rejected.
 */
export function scanTemplatePrompt(promptTemplate: string): TemplateScanResult {
  const cls = classifyContent(promptTemplate);
  return { safe: !cls.overrideAttempt, reasons: cls.reasons };
}

/**
 * Quarantine a user-supplied launch parameter at the substitution choke
 * point. Same convention as the notification engine: benign DATA passes
 * through unchanged; EXTERNAL_CONTENT is wrapped as quoted data.
 */
function quarantineParam(value: string): string {
  if (classifyContent(value).kind === 'EXTERNAL_CONTENT') {
    return sanitizeUntrusted(value).sanitized;
  }
  return value;
}

export interface RenderResult {
  prompt: string;
  /** Declared variables that were not given a value. */
  missing: string[];
}

/** Substitute {{variables}}; values are quarantined user input. */
export function renderPrompt(
  template: TaskTemplate,
  params: Record<string, string>,
): RenderResult {
  const missing: string[] = [];
  const prompt = template.promptTemplate.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (_whole, name: string) => {
      const v = params[name];
      if (v === undefined || v === null) {
        missing.push(name);
        return _whole;
      }
      return quarantineParam(String(v));
    },
  );
  return { prompt, missing: [...new Set(missing)] };
}

const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_PROMPT = 20000;
const PRIORITIES: TaskPriority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

function validateInput(input: TaskTemplateInput): void {
  const name = input.name?.trim() ?? '';
  if (!name) throw new TaskTemplateStoreError('template name is required');
  if (name.length > MAX_NAME) throw new TaskTemplateStoreError('template name too long');
  if ((input.description ?? '').length > MAX_DESCRIPTION) {
    throw new TaskTemplateStoreError('template description too long');
  }
  if (!input.promptTemplate?.trim()) throw new TaskTemplateStoreError('promptTemplate is required');
  if (input.promptTemplate.length > MAX_PROMPT) {
    throw new TaskTemplateStoreError('promptTemplate too long');
  }
  if (input.defaultPriority !== undefined && !PRIORITIES.includes(input.defaultPriority)) {
    throw new TaskTemplateStoreError('defaultPriority must be P0..P4');
  }
  if (input.toolAllowlist !== undefined) {
    if (!Array.isArray(input.toolAllowlist) || input.toolAllowlist.some((t) => typeof t !== 'string')) {
      throw new TaskTemplateStoreError('toolAllowlist must be an array of strings');
    }
  }
  const scan = scanTemplatePrompt(input.promptTemplate);
  if (!scan.safe) {
    throw new TaskTemplateStoreError(
      `promptTemplate refused: injection scan flagged [${scan.reasons.join(', ')}]`,
    );
  }
}

function isValidTemplate(t: unknown): t is TaskTemplate {
  if (!t || typeof t !== 'object') return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['name'] === 'string' &&
    typeof r['description'] === 'string' &&
    typeof r['promptTemplate'] === 'string' &&
    Array.isArray(r['variables']) &&
    typeof r['createdAt'] === 'string' &&
    typeof r['updatedAt'] === 'string'
  );
}

/** Atomic write: write temp file then rename (crash-safe, same as plan-store). */
function atomicWriteJson(path: string, payload: unknown): void {
  const dir = resolve(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, path);
}

const BUILT_IN_TEMPLATES: Array<Omit<TaskTemplateInput, 'createdBy'>> = [
  {
    name: '代码审查',
    description: '对指定范围的代码做安全与质量审查，输出问题清单与修复建议。',
    promptTemplate:
      '请对以下代码范围做一次代码审查：{{scope}}。\n' +
      '重点：1) 安全问题（注入、越权、敏感信息泄漏）；2) 正确性（边界条件、并发、错误处理）；3) 可维护性（命名、重复、复杂度）。\n' +
      '输出格式：按严重程度分级的问题清单，每条给出文件位置、问题描述和具体修复建议。',
    defaultPriority: 'P2',
  },
  {
    name: '跑全测试并报告',
    description: '在指定目录跑完整测试套件，汇总失败并给出修复方向。',
    promptTemplate:
      '在目录 {{directory}} 执行完整测试：{{command}}。\n' +
      '要求：1) 先确认测试命令可运行；2) 汇总通过/失败/跳过数量；3) 对每个失败用例给出失败原因定位和修复方向；\n' +
      '4) 最后给出整体结论（是否可发布）。不要修改业务代码，只做诊断和报告。',
    defaultPriority: 'P1',
  },
  {
    name: '依赖升级检查',
    description: '检查指定依赖是否有可用的安全更新，评估升级风险。',
    promptTemplate:
      '检查以下依赖的更新情况：{{dependencies}}。\n' +
      '要求：1) 列出每个依赖的当前版本与最新稳定版本；2) 标注安全修复版本；\n' +
      '3) 评估升级风险（breaking changes）；4) 给出升级顺序建议。只做调研和报告，不要实际执行升级。',
    defaultPriority: 'P2',
  },
];

export class TaskTemplateStore {
  private readonly path: string;
  private templates: TaskTemplate[] = [];
  private corrupt = false;

  constructor(path?: string) {
    this.path = path ?? taskTemplateStorePath();
    if (!existsSync(this.path)) {
      // First boot: seed the three built-in templates.
      this.templates = BUILT_IN_TEMPLATES.map((t, i) => ({
        id: `tpl-builtin-${i + 1}`,
        name: t.name,
        description: t.description ?? '',
        promptTemplate: t.promptTemplate,
        variables: extractVariables(t.promptTemplate),
        defaultPriority: t.defaultPriority,
        builtIn: true,
        createdBy: 'system',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      this.persist();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { templates?: unknown[] };
      for (const t of raw.templates ?? []) {
        if (isValidTemplate(t)) this.templates.push(t);
      }
    } catch {
      // Fail-closed: serve empty, refuse writes — never silently drop.
      this.corrupt = true;
    }
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }

  private persist(): void {
    if (this.corrupt) {
      throw new TaskTemplateStoreError('template store is corrupt; writes refused');
    }
    atomicWriteJson(this.path, { templates: this.templates });
  }

  list(): TaskTemplate[] {
    return this.templates.map((t) => ({ ...t }));
  }

  get(id: string): TaskTemplate | undefined {
    const t = this.templates.find((x) => x.id === id);
    return t ? { ...t } : undefined;
  }

  create(input: TaskTemplateInput): TaskTemplate {
    validateInput(input);
    const now = new Date().toISOString();
    const t: TaskTemplate = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description ?? '',
      promptTemplate: input.promptTemplate,
      variables: extractVariables(input.promptTemplate),
      ...(input.defaultAgentId ? { defaultAgentId: input.defaultAgentId } : {}),
      ...(input.defaultPriority ? { defaultPriority: input.defaultPriority } : {}),
      ...(input.toolAllowlist ? { toolAllowlist: [...input.toolAllowlist] } : {}),
      createdBy: input.createdBy ?? 'human',
      createdAt: now,
      updatedAt: now,
    };
    this.templates.push(t);
    this.persist();
    return { ...t };
  }

  update(id: string, patch: Partial<Omit<TaskTemplateInput, 'createdBy'>>): TaskTemplate {
    const idx = this.templates.findIndex((x) => x.id === id);
    if (idx < 0) throw new TaskTemplateStoreError('template not found');
    const cur = this.templates[idx];
    const merged: TaskTemplateInput = {
      name: patch.name ?? cur.name,
      description: patch.description ?? cur.description,
      promptTemplate: patch.promptTemplate ?? cur.promptTemplate,
      ...(patch.defaultAgentId !== undefined
        ? { defaultAgentId: patch.defaultAgentId }
        : cur.defaultAgentId
          ? { defaultAgentId: cur.defaultAgentId }
          : {}),
      ...(patch.defaultPriority !== undefined
        ? { defaultPriority: patch.defaultPriority }
        : cur.defaultPriority
          ? { defaultPriority: cur.defaultPriority }
          : {}),
      ...(patch.toolAllowlist !== undefined
        ? { toolAllowlist: patch.toolAllowlist }
        : cur.toolAllowlist
          ? { toolAllowlist: cur.toolAllowlist }
          : {}),
    };
    validateInput(merged);
    const updated: TaskTemplate = {
      ...cur,
      name: merged.name.trim(),
      description: merged.description ?? '',
      promptTemplate: merged.promptTemplate,
      variables: extractVariables(merged.promptTemplate),
      defaultAgentId: merged.defaultAgentId,
      defaultPriority: merged.defaultPriority,
      toolAllowlist: merged.toolAllowlist,
      updatedAt: new Date().toISOString(),
    };
    this.templates[idx] = updated;
    this.persist();
    return { ...updated };
  }

  remove(id: string): boolean {
    const idx = this.templates.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    this.templates.splice(idx, 1);
    this.persist();
    return true;
  }
}
