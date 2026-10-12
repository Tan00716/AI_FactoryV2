/**
 * v1 → v2 migration on the production import path — SPEC v2 §52.4 / §58.
 *
 * The five migration functions in migrate-v1.ts operate on structured
 * data, but the production import path (`importProjectAi`, used by
 * POST /api/projects/:id/import) receives a `.ai/` file map and used to
 * validate-then-write it verbatim — v1 data was silently interpreted as
 * v2. This module closes that hole:
 *
 *   runV1Migrations(input)  — data-level entry: detect v1 sections,
 *                             run the matching migration per section,
 *                             return a structured report.
 *   migrateImportFiles(files) — file-level entry used by the import:
 *                             parse the `.ai/` sections out of the file
 *                             map, run runV1Migrations, and rewrite the
 *                             files that carry v1 claims into their
 *                             migrated v2 form (plus a
 *                             `.ai/migration-report.json` artifact).
 *
 * Detection is signal-based — there is no version marker in the format:
 *  - agents: any agent doc carrying `parent_agent_id` / `parent_agent` /
 *    `children` is v1 (v2 agent docs never carry org fields; v2 stores
 *    PRIMARY_REPORTS_TO edges in the org graph instead). A v1-detected
 *    package's agent permissions are v1 permissions → ceilings.
 *  - tasks: the v2 export format has no task section at all, so any
 *    `.ai/tasks/` doc is v1-era data; its `status` is a v1 claim.
 *  - memory: a bare string, or a doc without a structured `type`, is v1
 *    free text (v2 memory docs always carry `type`).
 *  - policy: a `production_approval` value, flat (v1 data shape) or
 *    nested under `workflow` (file shape). An imported `auto` has not
 *    passed THIS installation's Risk/Reversibility/Observe checks, so
 *    it is staged, never activated (§52.3 + §52.4).
 *
 * NEVER SILENT: every section reports `applied` or `skipped` with a
 * reason, whether or not v1 data was found. Idempotent: migrated files
 * no longer carry the v1 signals, so re-importing them detects nothing
 * and changes nothing.
 */
import { parseYaml, stringifyYamlDoc, type YamlMap, type YamlNode } from './yaml-util';
import {
  migrateMemoryText,
  migrateOrgEdges,
  migratePermissionsToCeilings,
  migrateProductionApproval,
  migrateTaskCompletion,
  type CapabilityCeiling,
  type MigratedCompletion,
  type MigratedMemory,
  type MigrationWarning,
  type PrimaryManagerEdge,
  type ProductionApprovalMigration,
  type V1Agent,
  type V1Task,
} from './migrate-v1';
import type { ExportFiles } from './types';

/* ------------------------------------------------------------------ */
/* Data-level entry                                                    */
/* ------------------------------------------------------------------ */

/** Parsed import sections, as loose records (callers parse their format). */
export interface V1MigrationInput {
  agents?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  memory?: Array<Record<string, unknown> | string>;
  /** Flat `{ production_approval }` or file-shaped `{ workflow: { production_approval } }`. */
  policy?: Record<string, unknown>;
}

export interface MigrationItemReport {
  status: 'applied' | 'skipped';
  count: number;
  note: string;
}

export interface OrgEdgesReport extends MigrationItemReport {
  edges: PrimaryManagerEdge[];
  warnings: MigrationWarning[];
}

export interface PermissionCeilingsReport extends MigrationItemReport {
  ceilings: CapabilityCeiling[];
}

export interface TaskCompletionsReport extends MigrationItemReport {
  verified: number;
  legacyUnverified: number;
  results: Array<{ id: string; result: MigratedCompletion }>;
}

export interface MemoryMigrationReport extends MigrationItemReport {
  entries: MigratedMemory[];
}

export interface ProductionApprovalReport extends MigrationItemReport {
  result: ProductionApprovalMigration | null;
}

export interface V1MigrationReport {
  /** True when at least one section carried a v1 signal and was migrated. */
  detected: boolean;
  orgEdges: OrgEdgesReport;
  permissionCeilings: PermissionCeilingsReport;
  taskCompletions: TaskCompletionsReport;
  memory: MemoryMigrationReport;
  productionApproval: ProductionApprovalReport;
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function toV1Agent(rec: Record<string, unknown>): V1Agent | null {
  const id = asNonEmptyString(rec['id']) ?? asNonEmptyString(rec['name']);
  if (!id) return null;
  const parent = asNonEmptyString(rec['parent_agent_id']) ?? asNonEmptyString(rec['parent_agent']);
  return {
    id,
    name: asNonEmptyString(rec['name']) ?? undefined,
    parent_agent_id: parent,
    children: asStringList(rec['children']),
    permissions: asStringList(rec['permissions']),
  };
}

function hasV1OrgFields(a: V1Agent): boolean {
  return a.parent_agent_id != null || (a.children?.length ?? 0) > 0;
}

function toV1Task(rec: Record<string, unknown>): V1Task | null {
  const id = asNonEmptyString(rec['id']);
  const status = asNonEmptyString(rec['status']);
  if (!id || !status) return null;
  return {
    id,
    status,
    evidenceComplete: (rec['evidenceComplete'] ?? rec['evidence_complete']) === true,
    requirementScopeProvable:
      (rec['requirementScopeProvable'] ?? rec['requirement_scope_provable']) === true,
  };
}

/** A task already carrying a migrated `completion_status` is not re-migrated. */
function alreadyMigratedTask(rec: Record<string, unknown>): { id: string; result: MigratedCompletion } | null {
  const id = asNonEmptyString(rec['id']);
  const cs = rec['completion_status'];
  if (!id || typeof cs !== 'string') return null;
  if (cs === 'VERIFIED') {
    return {
      id,
      result: {
        status: 'VERIFIED',
        milestone: asNonEmptyString(rec['milestone']) ?? 'IMPLEMENTED',
        evidenceRef: id,
      },
    };
  }
  if (cs === 'legacy_completion_unverified') {
    return {
      id,
      result: { status: 'legacy_completion_unverified', reason: 'already migrated by a previous import' },
    };
  }
  return null;
}

function productionApprovalOf(policy: Record<string, unknown>): 'human' | 'auto' | null {
  const flat = policy['production_approval'];
  if (flat === 'human' || flat === 'auto') return flat;
  const wf = policy['workflow'];
  if (typeof wf === 'object' && wf !== null && !Array.isArray(wf)) {
    const nested = (wf as Record<string, unknown>)['production_approval'];
    if (nested === 'human' || nested === 'auto') return nested;
  }
  return null;
}

/**
 * Run every applicable §52.4 migration over the parsed import sections.
 * Pure and deterministic; sections without a v1 signal are reported as
 * skipped with the reason — never silently passed over.
 */
export function runV1Migrations(input: V1MigrationInput): V1MigrationReport {
  /* --- agents: org edges + permission ceilings --------------------- */
  const agents = (input.agents ?? [])
    .map(toV1Agent)
    .filter((a): a is V1Agent => a !== null);
  const v1Detected = agents.some(hasV1OrgFields);

  let orgEdges: OrgEdgesReport;
  let permissionCeilings: PermissionCeilingsReport;
  if (v1Detected) {
    const { edges, warnings } = migrateOrgEdges(agents);
    orgEdges = {
      status: 'applied',
      count: edges.length,
      note:
        `v1 org fields (parent_agent_id/children) found — converted to PRIMARY_REPORTS_TO edges` +
        (warnings.length > 0 ? `; ${warnings.length} warning(s) recorded, never silently merged` : ''),
      edges,
      warnings,
    };
    const ceilings = migratePermissionsToCeilings(agents);
    const withPerms = ceilings.filter((c) => c.ceiling.length > 0).length;
    permissionCeilings = {
      status: 'applied',
      count: withPerms,
      note: 'v1 permissions recorded as capability ceilings — a ceiling is an upper bound, it grants nothing',
      ceilings,
    };
  } else {
    const note =
      agents.length > 0
        ? 'no v1 org fields (parent_agent_id/children) on any agent — treated as v2'
        : 'no agents in package';
    orgEdges = { status: 'skipped', count: 0, note, edges: [], warnings: [] };
    permissionCeilings = { status: 'skipped', count: 0, note, ceilings: [] };
  }

  /* --- tasks: completion claims ------------------------------------- */
  const rawTasks = input.tasks ?? [];
  const results: Array<{ id: string; result: MigratedCompletion }> = [];
  let unparseableTasks = 0;
  let freshTasks = 0;
  let alreadyMigratedTasks = 0;
  for (const rec of rawTasks) {
    const done = alreadyMigratedTask(rec);
    if (done) {
      alreadyMigratedTasks++;
      results.push(done);
      continue;
    }
    const task = toV1Task(rec);
    if (!task) {
      unparseableTasks++;
      continue;
    }
    freshTasks++;
    results.push({ id: task.id, result: migrateTaskCompletion(task) });
  }
  const verified = results.filter((r) => r.result.status === 'VERIFIED').length;
  const legacyUnverified = results.length - verified;
  const taskCompletions: TaskCompletionsReport =
    rawTasks.length === 0
      ? {
          status: 'skipped',
          count: 0,
          note: 'no task data in package — nothing to migrate',
          verified: 0,
          legacyUnverified: 0,
          results: [],
        }
      : freshTasks === 0
        ? {
            // Idempotency: every task record already carries a migrated
            // completion_status — report the standing results, but this
            // run migrated nothing.
            status: 'skipped',
            count: 0,
            note:
              `${alreadyMigratedTasks} task record(s) already carry a migrated completion_status — nothing to re-migrate` +
              (unparseableTasks > 0 ? `; ${unparseableTasks} task record(s) lacked id/status` : ''),
            verified,
            legacyUnverified,
            results,
          }
        : {
            status: 'applied',
            count: freshTasks,
            note:
              `v1 task completion claims migrated one task at a time — ${verified} VERIFIED (full proof), ` +
              `${legacyUnverified} legacy_completion_unverified; no bulk Outcome Verified claim` +
              (alreadyMigratedTasks > 0 ? `; ${alreadyMigratedTasks} record(s) were already migrated` : '') +
              (unparseableTasks > 0 ? `; ${unparseableTasks} task record(s) lacked id/status and were not migrated` : ''),
            verified,
            legacyUnverified,
            results,
          };

  /* --- memory: free text --------------------------------------------- */
  const memoryEntries: MigratedMemory[] = [];
  let structuredMemory = 0;
  for (const entry of input.memory ?? []) {
    if (typeof entry === 'string') {
      memoryEntries.push(migrateMemoryText(entry));
      continue;
    }
    // A record without a structured `type` is v1 free text with metadata.
    if (asNonEmptyString(entry['type']) === null) {
      const content = typeof entry['content'] === 'string' ? entry['content'] : '';
      memoryEntries.push(migrateMemoryText(content));
    } else {
      structuredMemory++;
    }
  }
  const memory: MemoryMigrationReport =
    memoryEntries.length > 0
      ? {
          status: 'applied',
          count: memoryEntries.length,
          note: 'v1 free-text memory marked UNVERIFIED — never trusted on arrival',
          entries: memoryEntries,
        }
      : {
          status: 'skipped',
          count: 0,
          note:
            structuredMemory > 0
              ? 'all memory entries are structured v2 records — nothing to migrate'
              : 'no memory entries in package',
          entries: [],
        };

  /* --- policy: production approval ----------------------------------- */
  let productionApproval: ProductionApprovalReport;
  if (!input.policy) {
    productionApproval = {
      status: 'skipped',
      count: 0,
      note: 'no policy section in package',
      result: null,
    };
  } else {
    const value = productionApprovalOf(input.policy);
    if (value === null) {
      productionApproval = {
        status: 'skipped',
        count: 0,
        note: 'policy carries no production_approval — nothing to stage',
        result: null,
      };
    } else {
      const result = migrateProductionApproval({ production_approval: value });
      productionApproval = {
        status: 'applied',
        count: 1,
        note: result.note,
        result,
      };
    }
  }

  const detected =
    orgEdges.status === 'applied' ||
    permissionCeilings.status === 'applied' ||
    taskCompletions.status === 'applied' ||
    memory.status === 'applied' ||
    (productionApproval.status === 'applied' &&
      productionApproval.result?.mode === 'auto_pending_checks');

  return { detected, orgEdges, permissionCeilings, taskCompletions, memory, productionApproval };
}

/* ------------------------------------------------------------------ */
/* File-level entry (production import path)                           */
/* ------------------------------------------------------------------ */

function isMap(n: YamlNode): n is YamlMap {
  return typeof n === 'object' && n !== null && !Array.isArray(n);
}

function fileBase(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

/** Parse a YAML doc leniently; null when unparseable or not a mapping. */
function tryParseDoc(text: string): YamlMap | null {
  if (typeof text !== 'string') return null;
  try {
    const node = parseYaml(text);
    return isMap(node) ? node : null;
  } catch {
    return null;
  }
}

export interface MigrateImportFilesResult {
  /** The file map to validate + write (transformed when v1 was detected). */
  files: ExportFiles;
  report: V1MigrationReport;
}

/**
 * Detect + migrate v1 data inside an `.ai/` import file map.
 *
 * Parse failures are NOT hidden: the offending file is left untouched
 * so the regular import validation reports it exactly as before.
 * When nothing v1 is detected the original map is returned unchanged
 * (same reference) and no extra file is added.
 */
export function migrateImportFiles(files: ExportFiles): MigrateImportFilesResult {
  const paths = Object.keys(files).sort();

  /* Parse the sections the migrations understand. */
  const agentDocs = new Map<string, YamlMap>();
  const agentRecs: Array<Record<string, unknown>> = [];
  for (const p of paths) {
    if (!p.startsWith('.ai/agents/')) continue;
    const doc = tryParseDoc(files[p]);
    if (!doc) continue;
    agentDocs.set(p, doc);
    agentRecs.push({ ...doc, id: asNonEmptyString(doc['id']) ?? fileBase(p) });
  }

  const taskDocs = new Map<string, YamlMap>();
  const taskRecs: Array<Record<string, unknown>> = [];
  for (const p of paths) {
    if (!p.startsWith('.ai/tasks/')) continue;
    const doc = tryParseDoc(files[p]);
    if (!doc) continue;
    taskDocs.set(p, doc);
    taskRecs.push({ ...doc, id: asNonEmptyString(doc['id']) ?? fileBase(p) });
  }

  type MemoryFile =
    | { path: string; kind: 'free-text'; text: string }
    | { path: string; kind: 'unstructured'; doc: YamlMap }
    | { path: string; kind: 'structured'; doc: YamlMap };
  const memoryFiles: MemoryFile[] = [];
  const memoryInput: Array<Record<string, unknown> | string> = [];
  for (const p of paths) {
    if (!p.startsWith('.ai/memory/')) continue;
    const text = files[p];
    if (typeof text !== 'string') continue;
    if (/\.(yaml|yml)$/i.test(p)) {
      const doc = tryParseDoc(text);
      if (!doc) continue; // validation will report the parse failure
      if (asNonEmptyString(doc['type']) === null) {
        memoryFiles.push({ path: p, kind: 'unstructured', doc });
        memoryInput.push(doc);
      } else {
        memoryFiles.push({ path: p, kind: 'structured', doc });
        memoryInput.push(doc);
      }
    } else {
      // .md / .txt / extensionless under .ai/memory/ = v1 free text.
      memoryFiles.push({ path: p, kind: 'free-text', text });
      memoryInput.push(text);
    }
  }

  const policyPath = '.ai/policy.yaml';
  const policyDoc = policyPath in files ? tryParseDoc(files[policyPath]) : null;

  const report = runV1Migrations({
    agents: agentRecs,
    tasks: taskRecs,
    memory: memoryInput,
    policy: policyDoc ?? undefined,
  });

  if (!report.detected) {
    return { files, report };
  }

  /* Transform: written files must carry the migrated (v2) reading. */
  const out: ExportFiles = { ...files };

  // Agents: org fields are migrated into edges (kept in the report) —
  // leaving them in the agent doc would invite a v2 reader to treat
  // them as live org structure.
  if (report.orgEdges.status === 'applied') {
    for (const [p, doc] of agentDocs) {
      if (!('parent_agent_id' in doc || 'parent_agent' in doc || 'children' in doc)) continue;
      const next: YamlMap = { ...doc };
      delete next['parent_agent_id'];
      delete next['parent_agent'];
      delete next['children'];
      out[p] = stringifyYamlDoc(next);
    }
  }

  // Tasks: the raw v1 status claim is replaced by the migrated one;
  // the original is preserved as v1_status for audit.
  if (report.taskCompletions.status === 'applied') {
    const byId = new Map(report.taskCompletions.results.map((r) => [r.id, r.result]));
    for (const [p, doc] of taskDocs) {
      const id = asNonEmptyString(doc['id']) ?? fileBase(p);
      const result = byId.get(id);
      if (!result || 'completion_status' in doc) continue;
      const next: YamlMap = { ...doc };
      if (!('v1_status' in next) && typeof doc['status'] === 'string') {
        next['v1_status'] = doc['status'];
      }
      next['completion_status'] = result.status;
      if (result.status === 'legacy_completion_unverified') {
        next['status'] = 'legacy_completion_unverified';
      } else {
        next['milestone'] = result.milestone;
      }
      out[p] = stringifyYamlDoc(next);
    }
  }

  // Memory: free text becomes a structured v2 doc that carries the
  // UNVERIFIED marking in-file. `type: LegacyNote` is a file-format
  // label, deliberately NOT one of the v2 memory classifications —
  // guessing a real type would upgrade the claim.
  if (report.memory.status === 'applied') {
    // Non-structured memory files pair 1:1, in path order, with the
    // migrated entries (runV1Migrations preserves that relative order).
    let i = 0;
    for (const mf of memoryFiles) {
      if (mf.kind === 'structured') continue;
      const migrated = report.memory.entries[i++];
      if (mf.kind === 'free-text') {
        const base = fileBase(mf.path);
        const doc: YamlMap = {
          id: base,
          type: 'LegacyNote',
          title: base,
          content: migrated.content,
          status: migrated.status,
          migrated_from: migrated.migratedFrom,
        };
        delete out[mf.path];
        out[`.ai/memory/${base}.yaml`] = stringifyYamlDoc(doc);
      } else {
        const next: YamlMap = { ...mf.doc };
        if (asNonEmptyString(next['title']) === null) next['title'] = fileBase(mf.path);
        next['type'] = 'LegacyNote';
        next['status'] = migrated.status;
        next['migrated_from'] = migrated.migratedFrom;
        if (typeof next['content'] !== 'string') next['content'] = migrated.content;
        out[mf.path] = stringifyYamlDoc(next);
      }
    }
  }

  // Policy: a staged auto-approval must not land as an active `auto`.
  // The written policy falls back to human approval until the checks
  // recorded in the report pass; the staging itself lives in the report.
  if (report.productionApproval.result?.mode === 'auto_pending_checks' && policyDoc) {
    const next: YamlMap = { ...policyDoc };
    if ('production_approval' in next) {
      delete next['production_approval'];
      const wf = isMap(next['workflow']) ? { ...next['workflow'] } : {};
      wf['production_approval'] = 'human';
      next['workflow'] = wf;
    } else if (isMap(next['workflow'])) {
      const wf = { ...next['workflow'] };
      wf['production_approval'] = 'human';
      next['workflow'] = wf;
    }
    out[policyPath] = stringifyYamlDoc(next);
  }

  out['.ai/migration-report.json'] = `${JSON.stringify(report, null, 2)}\n`;
  return { files: out, report };
}
