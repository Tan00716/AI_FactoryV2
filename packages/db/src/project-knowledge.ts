/**
 * Project knowledge records — SPEC v2 §6.4 (Batch 33).
 *
 * Until Batch 33 the nine §6.4 knowledge categories had no structure
 * anywhere: Product Requirements, Architecture, Tech Stack,
 * Coding/Test/Security Standards (one combined category — the spec
 * lists it as a single row), Deployment Rules, Known Bugs, Constraints
 * (the "Known Bugs/Constraints" row is split: bugs are observed
 * failures, constraints are standing limits), Decisions, Lessons.
 *
 * Record semantics (pinned by tests):
 *  - upsert is keyed by (project_id, category, title): re-saving the
 *    same entry updates content/provenance in place (updated_at moves);
 *  - every read returns a deep copy (mutating the result does not
 *    corrupt the store);
 *  - category is validated against the nine spec categories — an
 *    unknown category is a loud 400 at the HTTP layer, and this layer
 *    throws a KnowledgeCategoryError so the service never writes junk;
 *  - provenance is explicit: sourcePath/sourceVersion/sourceHash carry
 *    "源文件保留作为来源，索引和摘要引用版本/Hash" (§6.4); the content
 *    itself is the indexed summary, never a claim to be the source.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * The nine §6.4 project knowledge categories.
 *
 * NOTE on the count: §6.4 line 208 lists eight comma-separated rows;
 * "Coding/Test/Security Standards" is one row (a combined standards
 * category) and "Known Bugs/Constraints" is counted as two (bugs vs
 * constraints are different kinds of knowledge) → nine.
 */
export const PROJECT_KNOWLEDGE_CATEGORIES = [
  'product-requirements',
  'architecture',
  'tech-stack',
  'coding-test-security-standards',
  'deployment-rules',
  'known-bugs',
  'constraints',
  'decisions',
  'lessons',
] as const;

export type ProjectKnowledgeCategory =
  (typeof PROJECT_KNOWLEDGE_CATEGORIES)[number];

export function isProjectKnowledgeCategory(
  v: unknown,
): v is ProjectKnowledgeCategory {
  return (
    typeof v === 'string' &&
    (PROJECT_KNOWLEDGE_CATEGORIES as readonly string[]).includes(v)
  );
}

export class ProjectKnowledgeCategoryError extends Error {
  readonly code = 'UNKNOWN_KNOWLEDGE_CATEGORY';
  constructor(category: unknown) {
    super(
      `unknown project knowledge category ${JSON.stringify(category)}; ` +
        `expected one of: ${PROJECT_KNOWLEDGE_CATEGORIES.join(', ')}`,
    );
    this.name = 'ProjectKnowledgeCategoryError';
  }
}

export interface ProjectKnowledgeRecord {
  entryId: string;
  projectId: string;
  category: ProjectKnowledgeCategory;
  title: string;
  /** Indexed summary text (§6.4: never the full source inlined). */
  content: string;
  /** Source provenance (§6.4: source file kept, index references version/hash). */
  sourcePath: string | null;
  sourceVersion: string | null;
  sourceHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectKnowledgeStore {
  /** Insert or update by (project_id, category, title); returns the effective entryId. */
  upsert(entry: ProjectKnowledgeRecord): string;
  get(entryId: string): ProjectKnowledgeRecord | undefined;
  list(projectId: string, category?: ProjectKnowledgeCategory): ProjectKnowledgeRecord[];
  delete(entryId: string): boolean;
}

const copy = <T>(v: T): T => structuredClone(v);

/**
 * Map a raw SQLite row to a record. A category that fails validation
 * (e.g. hand-edited DB) is a loud ProjectKnowledgeCategoryError, never
 * a silently accepted unknown category.
 */
function rowToRecord(row: Record<string, unknown>): ProjectKnowledgeRecord {
  const category = row['category'];
  assertCategory(category as string);
  return {
    entryId: row['entryId'] as string,
    projectId: row['projectId'] as string,
    category: category as ProjectKnowledgeCategory,
    title: row['title'] as string,
    content: row['content'] as string,
    sourcePath: row['sourcePath'] as string | null,
    sourceVersion: row['sourceVersion'] as string | null,
    sourceHash: row['sourceHash'] as string | null,
    createdAt: row['createdAt'] as string,
    updatedAt: row['updatedAt'] as string,
  };
}

export function newProjectKnowledgeEntryId(): string {
  return randomUUID();
}

function assertCategory(category: string): asserts category is ProjectKnowledgeCategory {
  if (!isProjectKnowledgeCategory(category)) {
    throw new ProjectKnowledgeCategoryError(category);
  }
}

/** In-memory implementation: the behavior reference. */
export class InMemoryProjectKnowledgeStore implements ProjectKnowledgeStore {
  private readonly byId = new Map<string, ProjectKnowledgeRecord>();
  /** (projectId, category, title) → entryId */
  private readonly byKey = new Map<string, string>();

  private keyOf(e: ProjectKnowledgeRecord): string {
    return `${e.projectId}\n${e.category}\n${e.title}`;
  }

  upsert(entry: ProjectKnowledgeRecord): string {
    assertCategory(entry.category);
    const key = this.keyOf(entry);
    const existingId = this.byKey.get(key);
    const id = existingId ?? entry.entryId;
    const rec = copy(entry);
    rec.entryId = id;
    if (existingId) {
      const old = this.byId.get(existingId)!;
      rec.createdAt = old.createdAt;
    }
    this.byId.set(id, rec);
    this.byKey.set(key, id);
    return id;
  }

  get(entryId: string): ProjectKnowledgeRecord | undefined {
    const rec = this.byId.get(entryId);
    return rec ? copy(rec) : undefined;
  }

  list(projectId: string, category?: ProjectKnowledgeCategory): ProjectKnowledgeRecord[] {
    if (category !== undefined) assertCategory(category);
    const out: ProjectKnowledgeRecord[] = [];
    for (const rec of this.byId.values()) {
      if (rec.projectId !== projectId) continue;
      if (category !== undefined && rec.category !== category) continue;
      out.push(copy(rec));
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  delete(entryId: string): boolean {
    const rec = this.byId.get(entryId);
    if (!rec) return false;
    this.byId.delete(entryId);
    this.byKey.delete(this.keyOf(rec));
    return true;
  }
}

/** SQLite implementation. */
export class SqliteProjectKnowledgeStore implements ProjectKnowledgeStore {
  constructor(private readonly db: DatabaseSync) {}

  upsert(entry: ProjectKnowledgeRecord): string {
    assertCategory(entry.category);
    const existing = this.db
      .prepare(
        'SELECT entry_id AS entryId, created_at AS createdAt FROM project_knowledge WHERE project_id = ? AND category = ? AND title = ?',
      )
      .get(entry.projectId, entry.category, entry.title) as
      | { entryId: string; createdAt: string }
      | undefined;
    const id = existing?.entryId ?? entry.entryId;
    const createdAt = existing?.createdAt ?? entry.createdAt;
    this.db
      .prepare(
        `INSERT INTO project_knowledge
           (entry_id, project_id, category, title, content, source_path, source_version, source_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           content = excluded.content, source_path = excluded.source_path,
           source_version = excluded.source_version, source_hash = excluded.source_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        entry.projectId,
        entry.category,
        entry.title,
        entry.content,
        entry.sourcePath,
        entry.sourceVersion,
        entry.sourceHash,
        createdAt,
        entry.updatedAt,
      );
    return id;
  }

  get(entryId: string): ProjectKnowledgeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT entry_id AS entryId, project_id AS projectId, category, title,
                content, source_path AS sourcePath, source_version AS sourceVersion,
                source_hash AS sourceHash, created_at AS createdAt, updated_at AS updatedAt
         FROM project_knowledge WHERE entry_id = ?`,
      )
      .get(entryId) as Record<string, unknown> | undefined;
    return row ? copy(rowToRecord(row)) : undefined;
  }

  list(projectId: string, category?: ProjectKnowledgeCategory): ProjectKnowledgeRecord[] {
    if (category !== undefined) assertCategory(category);
    const sql = category
      ? `SELECT entry_id AS entryId, project_id AS projectId, category, title,
                content, source_path AS sourcePath, source_version AS sourceVersion,
                source_hash AS sourceHash, created_at AS createdAt, updated_at AS updatedAt
         FROM project_knowledge WHERE project_id = ? AND category = ?
         ORDER BY updated_at DESC`
      : `SELECT entry_id AS entryId, project_id AS projectId, category, title,
                content, source_path AS sourcePath, source_version AS sourceVersion,
                source_hash AS sourceHash, created_at AS createdAt, updated_at AS updatedAt
         FROM project_knowledge WHERE project_id = ?
         ORDER BY updated_at DESC`;
    const rows = (category
      ? this.db.prepare(sql).all(projectId, category)
      : this.db.prepare(sql).all(projectId)) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  delete(entryId: string): boolean {
    const r = this.db
      .prepare('DELETE FROM project_knowledge WHERE entry_id = ?')
      .run(entryId);
    return r.changes > 0;
  }
}
