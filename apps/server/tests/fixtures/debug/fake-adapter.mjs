/**
 * Fake DAP adapter fixture for apps/server/tests/debug.test.ts.
 * Stateful scripted session: launch → breakpoints → stopped → step cycle.
 * Supports `--exit-soon=<ms>` to die on its own (session-dead tests).
 */
const HEADER = 'Content-Length: ';
let seq = 0;
function send(msg) {
  seq += 1;
  const json = Buffer.from(JSON.stringify({ seq, ...msg }), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`${HEADER}${json.length}\r\n\r\n`, 'utf8'), json]));
}
function respond(req, success, body, message) {
  const r = { type: 'response', request_seq: req.seq, success, command: req.command };
  if (body !== undefined) r.body = body;
  if (message !== undefined) r.message = message;
  send(r);
}
function event(name, body) { send({ type: 'event', event: name, body }); }

const exitSoonArg = process.argv.find((a) => a.startsWith('--exit-soon='));
const EXIT_SOON_MS = exitSoonArg ? Number(exitSoonArg.split('=')[1]) : 0;

let buf = Buffer.alloc(0);
let nextBpId = 1;
let paused = false;
let seq2 = 0;

function notPaused(req) {
  respond(req, false, undefined, 'not stopped (NOT_PAUSED)');
}

function handle(req) {
  const args = req.arguments || {};
  switch (req.command) {
    case 'initialize':
      respond(req, true, { supportsConfigurationDoneRequest: true });
      break;
    case 'launch':
    case 'attach':
      event('initialized', {});
      respond(req, true);
      if (EXIT_SOON_MS > 0) setTimeout(() => process.exit(0), EXIT_SOON_MS);
      break;
    case 'setBreakpoints': {
      const bps = (args.breakpoints || []).map((b) => ({
        id: nextBpId++, verified: true, line: b.line, source: args.source,
      }));
      respond(req, true, { breakpoints: bps });
      break;
    }
    case 'configurationDone':
      respond(req, true);
      setTimeout(() => { paused = true; event('stopped', { reason: 'breakpoint', threadId: 1 }); }, 20);
      break;
    case 'threads':
      respond(req, true, { threads: [{ id: 1, name: 'main' }] });
      break;
    case 'stackTrace':
      if (!paused) { notPaused(req); break; }
      respond(req, true, {
        stackFrames: [{ id: 1, name: 'compute', source: { path: '/tmp/x.js' }, line: 4, column: 1 }],
        totalFrames: 1,
      });
      break;
    case 'scopes':
      if (!paused) { notPaused(req); break; }
      respond(req, true, { scopes: [{ name: 'Local', variablesReference: 100, expensive: false }] });
      break;
    case 'variables':
      if (!paused) { notPaused(req); break; }
      if (args.variablesReference === 100) {
        respond(req, true, { variables: [{ name: 'n', value: '21', type: 'number', variablesReference: 0 }] });
      } else {
        respond(req, false, undefined, 'unknown variablesReference');
      }
      break;
    case 'continue':
    case 'next':
    case 'stepIn':
    case 'stepOut':
      if (!paused) { notPaused(req); break; }
      paused = false;
      respond(req, true, { allThreadsContinued: true });
      event('continued', { threadId: 1, allThreadsContinued: true });
      setTimeout(() => { paused = true; event('stopped', { reason: 'step', threadId: 1 }); }, 20);
      break;
    case 'pause':
      paused = true;
      respond(req, true);
      event('stopped', { reason: 'pause', threadId: 1 });
      break;
    case 'evaluate':
      if (!paused) { notPaused(req); break; }
      if (args.expression === 'n + 1') respond(req, true, { result: '22', type: 'number', variablesReference: 0 });
      else respond(req, false, undefined, 'eval failed');
      break;
    case 'disconnect':
    case 'terminate':
      respond(req, true);
      event('terminated', { restart: false });
      setTimeout(() => process.exit(0), 30);
      break;
    default:
      respond(req, false, undefined, `unsupported: ${req.command}`);
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) break;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, idx).toString('ascii'));
    if (!m) break;
    const len = Number(m[1]);
    const start = idx + 4;
    if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString('utf8'));
    buf = buf.slice(start + len);
    if (msg.type === 'request') handle(msg);
  }
});
process.stdin.resume();
// a couple of output lines so /output has something to return
setTimeout(() => event('output', { category: 'stdout', output: 'hello from target\n' }), 50);
