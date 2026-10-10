/**
 * @ai-factory/artifacts — first-class artifact system (spec §23).
 *
 * Modules:
 *  - types    artifact types (19), field specs, schemas, Artifact entity,
 *             query/update shapes, domain errors                   [§23]
 *  - schemas  per-type schema registry (required + optional fields)
 *  - validate schema validation for field payloads: missing required
 *             fields and type mismatches are named in the error    [§23]
 *  - store    in-memory ArtifactStore: create (validated), get,
 *             query/listByTask(+type), update, seal (immutable after,
 *             evidence-engine semantics), delete (DRAFT only), link
 *             (bidirectional relatedIds), related()                [§23]
 *  - hooks    workflow hook interface: onWorkflowEvent() turns key
 *             workflow actions into artifacts (e.g. TASK_COMPLETED →
 *             FINAL_REPORT draft); decoupled, core binds later     [§23]
 */
export * from './types';
export * from './schemas';
export * from './validate';
export * from './store';
export * from './hooks';
