/**
 * @ai-factory/debugger — DAP debug client + Node.js debug adapter.
 *
 * Entry points:
 *   - DebugClient      spawn & drive a DAP adapter over stdio (client.ts)
 *   - node-adapter     the Node.js DAP adapter itself (spawned; DAP<->CDP)
 *   - launch.json      parse/select/normalize .vscode/launch.json (launchjson.ts)
 *   - DapFramer        Content-Length framing (framer.ts)
 *   - CdpClient/WsClient low-level CDP + WebSocket pieces (cdp.ts, ws.ts)
 *
 * Zero dependencies, zero model keys. Node.js only for now (honest
 * boundary — normalizeConfig rejects every other debug type).
 */
import { join, dirname } from 'node:path';

export * from './types';
export * from './framer';
export * from './ws';
export * from './cdp';
export * from './client';
export * from './launchjson';

/**
 * Absolute path of the compiled node adapter entry script. The server (and
 * DebugClient's default spawn) runs `node <this script>` with DAP on stdio.
 * Resolved from the compiled dist layout — callers must build first.
 */
export function resolveNodeAdapterScript(): string {
  // __dirname is the compiled dist/src dir (tsc CommonJS output).
  const dir = typeof __dirname === 'string' ? __dirname : dirname(__filename);
  return join(dir, 'node-adapter.js');
}
