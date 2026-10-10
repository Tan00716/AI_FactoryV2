/**
 * @ai-factory/projects — local project execution sandbox, project
 * discovery and project scaffolding (spec §6, §31–§33).
 *
 * Modules:
 *  - types     workspace permissions, exec results, profiles, templates [§6, §31–§33]
 *  - executor  WorkspaceExecutor: whitelisted, timeout-killed, cwd-pinned [§6, §31]
 *              command execution with audit events
 *  - discover  discoverProject(): language/framework/pm/test/CI/Git/     [§32]
 *              AGENTS.md/skills/MCP detection → ProjectProfile
 *  - templates runnable-minimal skeletons (nextjs-saas, react,           [§33]
 *              python-api, node-api, electron)
 *  - create    createProject(): directory + git init + skeleton +        [§33, §103]
 *              README + docs + .ai/project.yaml + .ai/policy.yaml
 */
export * from './types';
export * from './executor';
export * from './discover';
export * from './templates';
export * from './create';
