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
 *  - handshake initialize + negotiated-version persistence     [§34.2]
 *  - health    graded health (launch/protocol/tools/execution) [§34.4]
 *  - resilience classify → bounded retry / breaker → alternative [§34.4]
 *  - runtimePolicy stdio env / credentials / redirect / OAuth /  [§34.3]
 *              TLS / dynamic URL / resource-size restrictions
 *  - streamable-connector remote client: stateless Streamable HTTP
 *              (2026-07-28 spec: no initialize, no session id) [§34.2]
 *  - oauth OAuth 2.1 authorization-code flow (PKCE, discovery,
 *              refresh, secrets-backed token store)          [§34.3]
 */
export * from './types';
export * from './registry';
export * from './security';
export * from './gate';
export * from './handshake';
export * from './stdio-connector';
export * from './streamable-connector';
export * from './oauth';
export * from './health';
export * from './resilience';
export * from './runtimePolicy';
// http-transport stays internal except the egress guard setter the
// server needs (second-round task ⑦): targeted re-export, no `export *`.
export { setMcpHttpGuard, type McpHttpGuard } from './http-transport';
