# @ai-factory/tasktimeline (V3-#7)

Cascade-style timeline for tasks.json chain runs. Server-only package
(node:crypto); the desktop consumes it exclusively through the
`/api/tasks/runs` HTTP API, never by import.

- `buildTimeline(id, chain, planned)` — step cards in execution order;
  planned-but-unrun steps become explicit 'skipped' cards; steps whose
  command the planner does not know get `command: null` and coverage
  'partial'. Per-step output is capped at 32KB with a SHA-256 digest of
  the stored bytes (a record digest, not an artifact digest).
- `applyRollback(run, stepLabel, nowIso)` — marks steps after the target
  'superseded'; never deletes or rewrites history; the boundary only
  moves backwards, never forwards (no un-superseding).

Route surface (apps/server/src/routes/tasks.ts): `GET /api/tasks/runs`
(list view, outputs stripped), `GET /api/tasks/runs/:id` (full cards +
linked shadow checkpoints resolved by run root), `POST
/api/tasks/runs/:id/rollback`, `POST /api/tasks/runs/:id/rerun` (same
executeChain as a manual run; new run links via rerunOf/rerunFrom).
Rollback audits TIMELINE_ROLLBACK; rerun audits TIMELINE_RERUN. File
revert stays with the existing shadow-checkpoint restore endpoint.

Run records are process-local (server restart clears them).
