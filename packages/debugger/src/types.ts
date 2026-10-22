/**
 * @ai-factory/debugger — DAP (Debug Adapter Protocol) types.
 *
 * A minimal, hand-rolled subset of the Debug Adapter Protocol sufficient for
 * the Node.js debug adapter in this package. We deliberately do NOT depend on
 * the `debug-adapter-protocol` npm package (zero-dependency rule); the wire
 * format is just JSON-RPC framed by Content-Length headers (see framer.ts).
 */

export type DapRequest = {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
};

export type DapResponse = {
  seq: number;
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
};

export type DapEvent = {
  seq: number;
  type: 'event';
  event: string;
  body?: unknown;
};

export type DapMessage = DapRequest | DapResponse | DapEvent;

/** A breakpoint the user wants set (DAP SourceBreakpoint subset). */
export interface DapSourceBreakpoint {
  /** 1-based line. */
  line: number;
  /** 1-based column, optional. */
  column?: number;
  /** JS expression; the breakpoint only binds when truthy. */
  condition?: string;
  /** Log-point message; `{expr}` segments are evaluated in the target. */
  logMessage?: string;
}

export interface DapSource {
  /** Absolute file path (our adapters always use path, never sourceReference). */
  path?: string;
  name?: string;
}

export interface DapBreakpoint {
  id: number;
  verified: boolean;
  line?: number;
  column?: number;
  source?: DapSource;
  message?: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  presentationHint?: string;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface DapThread {
  id: number;
  name: string;
}

/** Session-level state surfaced to the UI (polled). */
export type DebugSessionState = 'starting' | 'running' | 'paused' | 'terminated';

export interface DebugStopInfo {
  state: DebugSessionState;
  /** DAP stopped reason: breakpoint | step | pause | exception | entry ... */
  stopReason?: string;
  threadId?: number;
  description?: string;
}

/** Normalized launch configuration (from .vscode/launch.json or inline). */
export interface NormalizedLaunchConfig {
  name: string;
  /** 'launch' | 'attach'. */
  request: 'launch' | 'attach';
  /** Adapter kind. This package only ships 'node'. */
  adapter: 'node';
  /** Absolute program path (launch only). */
  program?: string;
  /** Program argv (launch only). */
  args: string[];
  /** Working directory (launch only). */
  cwd?: string;
  /** Extra env vars merged over process.env (launch only). */
  env: Record<string, string>;
  stopOnEntry: boolean;
  /** Attach target (attach only). */
  port?: number;
  address: string;
}
