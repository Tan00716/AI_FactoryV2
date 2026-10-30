/**
 * Fake LSP server for client tests: speaks Content-Length framed JSON-RPC
 * over stdio and answers initialize/definition/references/hover/
 * documentSymbol with canned locations under a root it reads from the
 * initialize params. No real language server involved.
 */
import * as process from 'node:process';

let buf = Buffer.alloc(0);
let root = '';

function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function loc(file, line, character, endLine, endCharacter) {
  return { uri: `file://${root}/${file}`, range: { start: { line, character }, end: { line: endLine, character: endCharacter } } };
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buf.subarray(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    if (buf.length < headerEnd + 4 + len) return;
    const body = buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
    buf = buf.subarray(headerEnd + 4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      root = (msg.params.rootUri ?? '').replace(/^file:\/\//, '');
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
      continue;
    }
    if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
      continue;
    }
    if (msg.method === 'exit' || msg.method === 'initialized') continue;
    if (msg.method === 'textDocument/definition') {
      send({ jsonrpc: '2.0', id: msg.id, result: [loc('a.ts', 0, 16, 0, 21)] });
    } else if (msg.method === 'textDocument/references') {
      send({ jsonrpc: '2.0', id: msg.id, result: [loc('a.ts', 0, 16, 0, 21), loc('b.ts', 2, 9, 2, 14)] });
    } else if (msg.method === 'textDocument/hover') {
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: 'function greet(name: string): string' } } });
    } else if (msg.method === 'textDocument/documentSymbol') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: [{ name: 'greet', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } }],
      });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
