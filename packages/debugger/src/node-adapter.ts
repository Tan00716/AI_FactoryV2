#!/usr/bin/env node
/**
 * @ai-factory/debugger — Node.js DAP debug adapter (spawned subprocess).
 *
 * Wire protocol: DAP (Content-Length framed JSON) on stdin/stdout.
 * Debug engine: spawns the target with `node --inspect=127.0.0.1:0`
 * (or `--inspect-brk` for stopOnEntry / `attach` to an existing inspector)
 * and drives it through a hand-rolled CDP client (cdp.ts over ws.ts).
 *
 * Supported DAP surface (honest boundary — anything else answers
 * success:false "not supported"):
 *   initialize, launch, attach, setBreakpoints (condition + logMessage),
 *   setExceptionBreakpoints (all/uncaught), configurationDone, threads,
 *   stackTrace, scopes, variables, continue, next, stepIn, stepOut, pause,
 *   evaluate (repl/watch/hover), disconnect, terminate.
 * Not supported: setFunctionBreakpoints, setDataBreakpoints, restart,
 *   completions, setVariable, goto, modules/sources beyond file paths.
 *
 * Run: node dist/src/node-adapter.js   (stdin/stdout = DAP)
 * Logs go to stderr — stdout is protocol only.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get } from 'node:http';
import { DapFramer, encodeMessage } from './framer';
import { CdpClient, CdpEvent } from './cdp';
import type { DapBreakpoint, DapEvent, DapRequest, DapResponse, DapSourceBreakpoint, DapStackFrame } from './types';

const log = (...args: unknown[]): void => {
  process.stderr.write(`[node-adapter] ${args.map(String).join(' ')}\n`);
};

// ---------------------------------------------------------------------------
// DAP transport
// ---------------------------------------------------------------------------

let dapSeq = 0;
function send(msg: Record<string, unknown>): void {
  dapSeq += 1;
  process.stdout.write(encodeMessage({ seq: dapSeq, ...msg }));
}
function sendEvent(event: string, body?: unknown): void {
  send({ type: 'event', event, body });
}
function respond(requestSeq: number, command: string, success: boolean, body?: unknown, message?: string): void {
  const r: Record<string, unknown> = { type: 'response', request_seq: requestSeq, success, command };
  if (body !== undefined) r.body = body;
  if (message !== undefined) r.message = message;
  send(r);
}

// ---------------------------------------------------------------------------
// CDP value rendering
// ---------------------------------------------------------------------------

interface RemoteObject {
  type?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

function describeValue(obj: RemoteObject): { value: string; type: string } {
  const t = obj.type ?? 'object';
  if (t === 'undefined') return { value: 'undefined', type: 'undefined' };
  if (t === 'string') return { value: JSON.stringify(obj.value), type: 'string' };
  if (t === 'number' || t === 'boolean' || t === 'bigint') {
    return { value: String(obj.value), type: t };
  }
  if (t === 'symbol') return { value: obj.description ?? 'Symbol()', type: 'symbol' };
  if (t === 'function') return { value: obj.description ?? 'function', type: 'function' };
  // object
  if (obj.subtype === 'null') return { value: 'null', type: 'null' };
  if (obj.subtype === 'array') {
    const desc = obj.description ?? 'Array';
    return { value: desc, type: 'array' };
  }
  return { value: obj.description ?? obj.className ?? 'Object', type: t };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileUrlToPath(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return decodeURIComponent(url.slice('file://'.length));
    } catch {
      return url.slice('file://'.length);
    }
  }
  return null;
}

/** Build a JS expression for a DAP logMessage: `{expr}` segments evaluate. */
function logMessageToCondition(logMessage: string): string {
  const parts: string[] = [];
  const re = /\{([^{}]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(logMessage)) !== null) {
    if (m.index > last) parts.push(JSON.stringify(logMessage.slice(last, m.index)));
    parts.push(`String(${m[1]})`);
    last = m.index + m[0].length;
  }
  if (last < logMessage.length) parts.push(JSON.stringify(logMessage.slice(last)));
  if (parts.length === 0) parts.push(JSON.stringify(logMessage));
  // console.log prints to the target stdout; `, false` keeps it a log-point.
  return `(console.log(${parts.join(' + ')}), false)`;
}

// ---------------------------------------------------------------------------
// session state
// ---------------------------------------------------------------------------

interface CallFrameLocation {
  scriptId: string;
  lineNumber: number; // 0-based
  columnNumber: number; // 0-based
}

interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: CallFrameLocation;
  scopeChain: { type: string; name?: string; object?: { objectId?: string } }[];
}

interface VarRef {
  objectId: string;
}

let cdp: CdpClient | null = null;
let target: ChildProcess | null = null;
let targetExitCode: number | null = null;
let pausedFrames: CallFrame[] | null = null;
/** scriptId -> url, built from Debugger.scriptParsed (callFrame.url is empty). */
const scriptUrls = new Map<string, string>();
/** Set by next/stepIn/stepOut: the next pause is reported as reason 'step'. */
let stepArmed = false;
/**
 * Launch always uses --inspect-brk so breakpoints are in place before the
 * target runs a single line (no set-breakpoint-vs-execution race). The entry
 * pause is then either surfaced (stopOnEntry) or auto-resumed.
 */
let expectingEntry = false;
let entryStopWanted = false;
let suppressResumedEvent = false;
let nextDapBreakpointId = 1;
let nextVarRef = 1;
const varRefs = new Map<number, VarRef>();
/** source path -> cdp breakpoint ids (for removal on re-set) */
const sourceBreakpoints = new Map<string, string[]>();
/** cdp breakpoint id -> dap breakpoint id */
const cdpToDapBp = new Map<string, number>();
const dapBreakpoints = new Map<number, DapBreakpoint>();
let shuttingDown = false;

function clearPauseState(): void {
  pausedFrames = null;
  varRefs.clear();
  nextVarRef = 1;
}

function requirePaused(): CallFrame[] {
  if (!pausedFrames) throw new Error('not stopped (NOT_PAUSED)');
  return pausedFrames;
}

function allocVarRef(objectId: string): number {
  const id = nextVarRef++;
  varRefs.set(id, { objectId });
  return id;
}

// ---------------------------------------------------------------------------
// CDP event wiring
// ---------------------------------------------------------------------------

function onCdpEvent(ev: CdpEvent): void {
  const params = (ev.params ?? {}) as Record<string, unknown>;
  if (ev.method === 'Debugger.scriptParsed') {
    const scriptId = String(params.scriptId ?? '');
    const url = String(params.url ?? '');
    if (scriptId && url) scriptUrls.set(scriptId, url);
    return;
  }
  if (ev.method === 'Debugger.paused') {
    const reason = String(params.reason ?? 'other');
    const frames = (params.callFrames ?? []) as CallFrame[];
    // Entry pause from the --inspect-brk launch: surface it or auto-resume.
    if (expectingEntry) {
      expectingEntry = false;
      stepArmed = false;
      if (entryStopWanted) {
        pausedFrames = frames;
        varRefs.clear();
        nextVarRef = 1;
        sendEvent('stopped', { reason: 'entry', threadId: 1 });
      } else if (cdp) {
        suppressResumedEvent = true;
        cdp.send('Debugger.resume').catch((e) => log('auto-resume failed:', (e as Error).message));
      }
      return;
    }
    pausedFrames = frames;
    varRefs.clear();
    nextVarRef = 1;
    const hit = params.hitBreakpoints as string[] | undefined;
    // CDP does not label step pauses, so the adapter tracks the pending step
    // itself (a breakpoint hit during the step wins).
    let dapReason = 'pause';
    if (hit && hit.length > 0) dapReason = 'breakpoint';
    else if (stepArmed) dapReason = 'step';
    else if (reason === 'exception' || reason === 'OOM') dapReason = 'exception';
    else if (reason === 'debugCommand') dapReason = 'pause';
    stepArmed = false;
    const body: Record<string, unknown> = { reason: dapReason, threadId: 1 };
    if (hit && hit.length > 0) {
      const ids = hit.map((id) => cdpToDapBp.get(id)).filter((x): x is number => x !== undefined);
      if (ids.length > 0) body.hitBreakpointIds = ids;
    }
    if (dapReason === 'exception' && params.data) {
      const data = params.data as { description?: string };
      if (data.description) body.description = data.description;
    }
    sendEvent('stopped', body);
    return;
  }
  if (ev.method === 'Debugger.resumed') {
    clearPauseState();
    if (suppressResumedEvent) {
      suppressResumedEvent = false;
      return; // silent auto-resume past the --inspect-brk entry pause
    }
    sendEvent('continued', { threadId: 1, allThreadsContinued: true });
    return;
  }
  if (ev.method === 'Debugger.breakpointResolved') {
    const bpId = String(params.breakpointId ?? '');
    const dapId = cdpToDapBp.get(bpId);
    const loc = params.location as { lineNumber?: number; columnNumber?: number } | undefined;
    if (dapId !== undefined) {
      const bp = dapBreakpoints.get(dapId);
      if (bp) {
        bp.verified = true;
        if (typeof loc?.lineNumber === 'number') bp.line = loc.lineNumber + 1;
        if (typeof loc?.columnNumber === 'number') bp.column = loc.columnNumber + 1;
      }
      sendEvent('breakpoint', { reason: 'changed', breakpoint: dapBreakpoints.get(dapId) });
    }
    return;
  }
  if (ev.method === 'Runtime.consoleAPICalled') {
    const args = (params.args ?? []) as RemoteObject[];
    const text = args.map((a) => describeValue(a).value).join(' ');
    sendEvent('output', { category: 'console', output: text + '\n' });
    return;
  }
  if (ev.method === 'Runtime.exceptionThrown') {
    // Only interesting when we are not pausing on it; surface as output.
    const details = params.exceptionDetails as { text?: string } | undefined;
    if (details?.text && !pausedFrames) {
      sendEvent('output', { category: 'stderr', output: `Uncaught ${details.text}\n` });
    }
    return;
  }
}

function onCdpClose(): void {
  if (shuttingDown) return;
  finishSession(targetExitCode);
}

function finishSession(exitCode: number | null): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearPauseState();
  try {
    sendEvent('exited', { exitCode: exitCode ?? 0 });
    sendEvent('terminated', { restart: false });
  } catch {
    /* ignore */
  }
  setImmediate(() => process.exit(0));
}

// ---------------------------------------------------------------------------
// target lifecycle
// ---------------------------------------------------------------------------

function scrubEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Never leak the test-runner context into a debugged child (AGENTS.md:
  // NODE_TEST_CONTEXT makes nested `node --test` silently no-op).
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

function waitForWsUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let errBuf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for inspector ws url after ${timeoutMs}ms; stderr: ${errBuf.slice(-500)}`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onData = (d: Buffer): void => {
      const text = d.toString('utf8');
      sendEvent('output', { category: 'stderr', output: text });
      errBuf += text;
      const m = /ws:\/\/[^\s]+/.exec(errBuf);
      if (m) {
        cleanup();
        resolve(m[0]);
      }
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(new Error(`target spawn failed: ${e.message}`));
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`target exited before the inspector came up (code ${code}); stderr: ${errBuf.slice(-500)}`));
    };
    child.stderr?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function pipeTargetIo(child: ChildProcess): void {
  child.stdout?.on('data', (d: Buffer) => {
    sendEvent('output', { category: 'stdout', output: d.toString('utf8') });
  });
  child.stderr?.on('data', (d: Buffer) => {
    // (inspector banner already consumed by waitForWsUrl; the rest is target stderr)
    sendEvent('output', { category: 'stderr', output: d.toString('utf8') });
  });
  child.on('exit', (code) => {
    targetExitCode = code;
    if (!cdp || cdp.closed) finishSession(code);
    // else the cdp close handler finishes the session
  });
}

async function connectCdp(wsUrl: string): Promise<void> {
  cdp = await CdpClient.connect(wsUrl, 10000);
  cdp.onEvent(onCdpEvent);
  cdp.onClose(() => onCdpClose());
  await cdp.send('Runtime.enable');
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
  await cdp.send('Debugger.setBreakpointsActive', { active: true });
}

function fetchJsonList(address: string, port: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GET /json/list timed out after ${timeoutMs}ms`)), timeoutMs);
    const req = get({ host: address, port, path: '/json/list', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => {
        body += d.toString('utf8');
      });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`invalid /json/list response: ${(e as Error).message}`));
        }
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('timeout', () => {
      clearTimeout(timer);
      req.destroy(new Error('request timeout'));
    });
  });
}

async function handleLaunch(args: Record<string, unknown>): Promise<void> {
  const program = args.program;
  if (typeof program !== 'string' || !program) throw new Error('launch needs args.program');
  if (!existsSync(program)) throw new Error(`program does not exist: ${program}`);
  const progArgs = Array.isArray(args.args) ? (args.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  const env = args.env && typeof args.env === 'object' ? (args.env as Record<string, string>) : {};
  const stopOnEntry = args.stopOnEntry === true;
  const runtime = typeof args.runtimeExecutable === 'string' && args.runtimeExecutable ? args.runtimeExecutable : 'node';
  // Always --inspect-brk: the entry pause lets us install breakpoints before
  // the target runs (no race). Non-stopOnEntry launches auto-resume past it.
  const inspectFlag = '--inspect-brk=127.0.0.1:0';

  target = spawn(runtime, [inspectFlag, program, ...progArgs], {
    cwd,
    env: scrubEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeTargetIo(target);
  const wsUrl = await waitForWsUrl(target, 15000);
  await connectCdp(wsUrl);
  expectingEntry = true;
  entryStopWanted = stopOnEntry;
  // Breakpoints may have arrived before launch; apply them now.
  await applyPendingBreakpoints();
}

async function handleAttach(args: Record<string, unknown>): Promise<void> {
  const port = Number(args.port);
  const address = typeof args.address === 'string' && args.address ? args.address : '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('attach needs a numeric args.port (1-65535)');
  const list = (await fetchJsonList(address, port, 8000)) as { type?: string; webSocketDebuggerUrl?: string }[];
  const targetInfo = (Array.isArray(list) ? list : []).find(
    (t) => t && typeof t === 'object' && t.webSocketDebuggerUrl && (t.type === 'node' || !t.type),
  );
  if (!targetInfo?.webSocketDebuggerUrl) throw new Error(`no debuggable node target on ${address}:${port}`);
  await connectCdp(targetInfo.webSocketDebuggerUrl);
  expectingEntry = false;
  await applyPendingBreakpoints();
}

// breakpoints that arrived before the CDP connection existed
const pendingBreakpointSets = new Map<string, { dapId: number; bp: DapSourceBreakpoint }[]>();

async function applyPendingBreakpoints(): Promise<void> {
  for (const [path, items] of pendingBreakpointSets) {
    await applySourceBreakpoints(path, items);
  }
  pendingBreakpointSets.clear();
}

async function setSourceBreakpoints(path: string, bps: DapSourceBreakpoint[]): Promise<DapBreakpoint[]> {
  const items = bps.map((bp) => ({ dapId: nextDapBreakpointId++, bp }));
  if (!cdp) {
    pendingBreakpointSets.set(path, items);
    return items.map(({ dapId, bp }) => ({
      id: dapId,
      verified: false,
      line: bp.line,
      column: bp.column,
      source: { path },
    }));
  }
  return applySourceBreakpoints(path, items);
}

async function applySourceBreakpoints(
  path: string,
  items: { dapId: number; bp: DapSourceBreakpoint }[],
): Promise<DapBreakpoint[]> {
  if (!cdp) throw new Error('not connected yet');
  const old = sourceBreakpoints.get(path) ?? [];
  for (const id of old) {
    try {
      await cdp.send('Debugger.removeBreakpoint', { breakpointId: id });
    } catch {
      /* best effort */
    }
    cdpToDapBp.delete(id);
  }
  const urlRegex = escapeRegex('file://' + path) + '$';
  const out: DapBreakpoint[] = [];
  const newIds: string[] = [];
  for (const { dapId, bp: b } of items) {
    const line = Math.max(1, Math.floor(b.line));
    const params: Record<string, unknown> = { urlRegex, lineNumber: line - 1 };
    if (typeof b.column === 'number' && b.column >= 1) params.columnNumber = b.column - 1;
    if (typeof b.logMessage === 'string' && b.logMessage) {
      params.condition = logMessageToCondition(b.logMessage);
    } else if (typeof b.condition === 'string' && b.condition) {
      params.condition = b.condition;
    }
    try {
      const res = (await cdp.send('Debugger.setBreakpointByUrl', params)) as { breakpointId?: string; locations?: unknown[] };
      const cdpId = String(res.breakpointId ?? '');
      newIds.push(cdpId);
      cdpToDapBp.set(cdpId, dapId);
      const bp: DapBreakpoint = {
        id: dapId,
        verified: Array.isArray(res.locations) && res.locations.length > 0,
        line,
        column: b.column,
        source: { path },
      };
      dapBreakpoints.set(dapId, bp);
      out.push(bp);
    } catch (e) {
      const bp: DapBreakpoint = {
        id: dapId,
        verified: false,
        line,
        column: b.column,
        source: { path },
        message: (e as Error).message,
      };
      dapBreakpoints.set(dapId, bp);
      out.push(bp);
    }
  }
  sourceBreakpoints.set(path, newIds);
  return out;
}

// ---------------------------------------------------------------------------
// request dispatch
// ---------------------------------------------------------------------------

async function dispatch(req: DapRequest): Promise<void> {
  const args = (req.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.command) {
      case 'initialize': {
        respond(req.seq, req.command, true, {
          supportsConfigurationDoneRequest: true,
          supportsConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsHitConditionalBreakpoints: false,
          supportsEvaluateForHovers: true,
          supportsSetVariable: false,
          supportsExceptionInfoRequest: false,
          supportTerminateDebuggee: true,
        });
        return;
      }
      case 'launch': {
        await handleLaunch(args);
        sendEvent('initialized');
        respond(req.seq, req.command, true);
        return;
      }
      case 'attach': {
        await handleAttach(args);
        sendEvent('initialized');
        respond(req.seq, req.command, true);
        return;
      }
      case 'setBreakpoints': {
        const source = args.source as { path?: string } | undefined;
        const path = source?.path;
        if (!path) throw new Error('setBreakpoints needs arguments.source.path');
        const rawBps = (Array.isArray(args.breakpoints) ? args.breakpoints : []) as DapSourceBreakpoint[];
        for (const b of rawBps) {
          if (!Number.isFinite(b.line) || b.line < 1) throw new Error('breakpoint line must be >= 1');
        }
        const bps = await setSourceBreakpoints(path, rawBps);
        respond(req.seq, req.command, true, { breakpoints: bps });
        return;
      }
      case 'setExceptionBreakpoints': {
        const filters = (Array.isArray(args.filters) ? args.filters : []).map(String);
        let state = 'none';
        if (filters.includes('all')) state = 'all';
        else if (filters.includes('uncaught')) state = 'uncaught';
        if (!cdp) throw new Error('not connected yet');
        await cdp.send('Debugger.setPauseOnExceptions', { state });
        respond(req.seq, req.command, true, { breakpoints: [] });
        return;
      }
      case 'configurationDone': {
        if (!cdp) throw new Error('not connected yet');
        try {
          await cdp.send('Runtime.runIfWaitingForDebugger');
        } catch {
          /* not waiting — harmless */
        }
        respond(req.seq, req.command, true);
        return;
      }
      case 'threads': {
        respond(req.seq, req.command, true, { threads: [{ id: 1, name: 'main' }] });
        return;
      }
      case 'stackTrace': {
        const frames = requirePaused();
        const startFrame = typeof args.startFrame === 'number' ? Math.max(0, args.startFrame) : 0;
        const levels = typeof args.levels === 'number' && args.levels > 0 ? args.levels : frames.length;
        const slice = frames.slice(startFrame, startFrame + levels);
        const stackFrames: DapStackFrame[] = slice.map((f, i) => {
          const url = scriptUrls.get(f.location?.scriptId ?? '') ?? '';
          const path = fileUrlToPath(url);
          const line = typeof f.location?.lineNumber === 'number' ? f.location.lineNumber + 1 : 1;
          const column = typeof f.location?.columnNumber === 'number' ? f.location.columnNumber + 1 : 1;
          return {
            id: startFrame + i + 1,
            name: f.functionName || '(anonymous)',
            source: path ? { name: path.split('/').pop() ?? path, path } : { name: url || '(unknown)' },
            line,
            column,
          };
        });
        respond(req.seq, req.command, true, { stackFrames, totalFrames: frames.length });
        return;
      }
      case 'scopes': {
        const frames = requirePaused();
        const frameId = Number(args.frameId);
        const frame = frames[frameId - 1];
        if (!frame) throw new Error(`no such frame: ${args.frameId}`);
        const scopes = frame.scopeChain.map((s) => ({
          name: s.name && s.type !== s.name ? `${s.type}:${s.name}` : s.type,
          variablesReference: s.object?.objectId ? allocVarRef(s.object.objectId) : 0,
          expensive: false,
          presentationHint: s.type === 'local' ? 'locals' : undefined,
        }));
        respond(req.seq, req.command, true, { scopes });
        return;
      }
      case 'variables': {
        const ref = Number(args.variablesReference);
        const entry = varRefs.get(ref);
        if (!entry) throw new Error(`unknown variablesReference: ${args.variablesReference}`);
        if (!cdp) throw new Error('not connected yet');
        const res = (await cdp.send('Runtime.getProperties', {
          objectId: entry.objectId,
          ownProperties: true,
        })) as { result?: { name?: string; value?: RemoteObject; get?: unknown }[] };
        const variables = (res.result ?? []).map((p) => {
          const name = String(p.name ?? '');
          if (!p.value) {
            return { name, value: p.get ? '<getter>' : '<unknown>', type: 'unknown', variablesReference: 0 };
          }
          const d = describeValue(p.value);
          return {
            name,
            value: d.value,
            type: d.type,
            variablesReference: p.value.objectId ? allocVarRef(p.value.objectId) : 0,
          };
        });
        respond(req.seq, req.command, true, { variables });
        return;
      }
      case 'continue':
      case 'next':
      case 'stepIn':
      case 'stepOut': {
        requirePaused();
        if (!cdp) throw new Error('not connected yet');
        const method =
          req.command === 'continue' ? 'Debugger.resume'
          : req.command === 'next' ? 'Debugger.stepOver'
          : req.command === 'stepIn' ? 'Debugger.stepInto'
          : 'Debugger.stepOut';
        stepArmed = req.command !== 'continue';
        clearPauseState();
        await cdp.send(method);
        respond(req.seq, req.command, true, { allThreadsContinued: true });
        return;
      }
      case 'pause': {
        if (!cdp) throw new Error('not connected yet');
        await cdp.send('Debugger.pause');
        respond(req.seq, req.command, true);
        return;
      }
      case 'evaluate': {
        const expression = args.expression;
        if (typeof expression !== 'string' || !expression) throw new Error('evaluate needs arguments.expression');
        if (!cdp) throw new Error('not connected yet');
        const frameId = typeof args.frameId === 'number' ? args.frameId : undefined;
        let raw: unknown;
        if (frameId !== undefined && pausedFrames) {
          const frame = pausedFrames[frameId - 1];
          if (!frame) throw new Error(`no such frame: ${frameId}`);
          raw = await cdp.send('Debugger.evaluateOnCallFrame', {
            callFrameId: frame.callFrameId,
            expression,
            returnByValue: false,
          });
        } else {
          raw = await cdp.send('Runtime.evaluate', { expression, returnByValue: false });
        }
        const r = raw as { result?: RemoteObject; exceptionDetails?: { text?: string; exception?: RemoteObject } };
        if (r.exceptionDetails) {
          const text = r.exceptionDetails.text ?? describeValue(r.exceptionDetails.exception ?? {}).value;
          respond(req.seq, req.command, false, undefined, `evaluation failed: ${text}`);
          return;
        }
        const d = describeValue(r.result ?? {});
        respond(req.seq, req.command, true, {
          result: d.value,
          type: d.type,
          variablesReference: r.result?.objectId ? allocVarRef(r.result.objectId) : 0,
        });
        return;
      }
      case 'disconnect': {
        const terminateDebuggee = args.terminateDebuggee !== false;
        respond(req.seq, req.command, true);
        if (terminateDebuggee) {
          try {
            target?.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
        try {
          cdp?.close();
        } catch {
          /* ignore */
        }
        finishSession(targetExitCode);
        return;
      }
      case 'terminate': {
        respond(req.seq, req.command, true);
        try {
          target?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        try {
          cdp?.close();
        } catch {
          /* ignore */
        }
        finishSession(targetExitCode);
        return;
      }
      case 'cancel': {
        respond(req.seq, req.command, false, undefined, 'cancel is not supported');
        return;
      }
      default: {
        respond(req.seq, req.command, false, undefined, `unsupported request: ${req.command}`);
      }
    }
  } catch (e) {
    const msg = (e as Error).message;
    respond(req.seq, req.command, false, undefined, msg);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const framer = new DapFramer();
process.stdin.on('data', (chunk: Buffer) => {
  for (const raw of framer.push(chunk)) {
    const msg = raw as { type?: string };
    if (msg.type === 'request') {
      void dispatch(msg as DapRequest);
    }
    // responses/events inbound are not expected on the adapter side
  }
});
process.stdin.on('end', () => {
  try {
    target?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  process.exit(0);
});
process.stdin.resume();

process.on('uncaughtException', (e) => {
  log('uncaughtException:', e.message);
  try {
    sendEvent('output', { category: 'stderr', output: `adapter error: ${e.message}\n` });
  } catch {
    /* ignore */
  }
  try {
    target?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  process.exit(1);
});
