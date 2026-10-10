/**
 * @ai-factory/mcp — MCP Registry: server registration, trust/approval-gated
 * installs, per-scope enablement, and the tool-call gate.
 *
 * Spec: §46 MCP Registry, §73 MCP Security ("unknown MCP = BLOCK").
 *
 * Modules:
 *  - types     server/install/review/tool-call types            [§46, §73]
 *  - registry  registration store (unknown ⇒ UNKNOWN/BLOCKED)  [§73]
 *  - security  trust assessment + approval-gated install flow   [§46, §73]
 *  - gate      pre-call authorization gate                      [§46, §73]
 */
export * from './types';
export * from './registry';
export * from './security';
export * from './gate';
