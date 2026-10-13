/**
 * Registered project template definitions — SPEC v2 §6.1 (Batch 33).
 *
 * The five builtin templates live in @ai-factory/projects as pinned
 * data. This store persists *registered* (custom) templates so they
 * survive restarts; the server loads them into its ProjectTemplateRegistry
 * at boot. Definitions are validated by the projects package
 * (validateTemplateRegistration) BEFORE this store ever sees them —
 * this layer is a dumb durable key/value of full definition JSON.
 */
import { DatabaseSync } from 'node:sqlite';

export interface ProjectTemplateDbRecord {
  name: string;
  /** Full ProjectTemplateRegistration JSON (lossless). */
  definitionJson: string;
  registeredAt: string;
}

export interface ProjectTemplateDbStore {
  save(record: ProjectTemplateDbRecord): void;
  get(name: string): ProjectTemplateDbRecord | undefined;
  list(): ProjectTemplateDbRecord[];
  delete(name: string): boolean;
}

const copy = <T>(v: T): T => structuredClone(v);

/** In-memory implementation: the behavior reference. */
export class InMemoryProjectTemplateDbStore implements ProjectTemplateDbStore {
  private readonly rows = new Map<string, ProjectTemplateDbRecord>();

  save(record: ProjectTemplateDbRecord): void {
    this.rows.set(record.name, copy(record));
  }

  get(name: string): ProjectTemplateDbRecord | undefined {
    const r = this.rows.get(name);
    return r ? copy(r) : undefined;
  }

  list(): ProjectTemplateDbRecord[] {
    return [...this.rows.values()].map(copy);
  }

  delete(name: string): boolean {
    return this.rows.delete(name);
  }
}

/** SQLite implementation. */
export class SqliteProjectTemplateDbStore implements ProjectTemplateDbStore {
  constructor(private readonly db: DatabaseSync) {}

  save(record: ProjectTemplateDbRecord): void {
    this.db
      .prepare(
        `INSERT INTO project_templates (name, definition_json, registered_at)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           definition_json = excluded.definition_json,
           registered_at = excluded.registered_at`,
      )
      .run(record.name, record.definitionJson, record.registeredAt);
  }

  get(name: string): ProjectTemplateDbRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT name, definition_json AS definitionJson, registered_at AS registeredAt
         FROM project_templates WHERE name = ?`,
      )
      .get(name) as Record<string, unknown> | undefined;
    return row ? copy(row as unknown as ProjectTemplateDbRecord) : undefined;
  }

  list(): ProjectTemplateDbRecord[] {
    const rows = this.db
      .prepare(
        `SELECT name, definition_json AS definitionJson, registered_at AS registeredAt
         FROM project_templates ORDER BY name`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => copy(r as unknown as ProjectTemplateDbRecord));
  }

  delete(name: string): boolean {
    return this.db.prepare('DELETE FROM project_templates WHERE name = ?').run(name).changes > 0;
  }
}
