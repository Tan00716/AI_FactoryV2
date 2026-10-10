/**
 * @ai-factory/squads — task squads vs persistent organization (spec §20, §14).
 *
 * Modules:
 *  - squad         temporary per-task squads (assembled, then archived)  [§20]
 *  - org-designer  persistent organization graph designer                [§14]
 *
 * §20 distinction in one line: the organization is long-lived and designed;
 * a task squad is temporary and archived when its task is done.
 */
export * from './squad';
export * from './org-designer';
