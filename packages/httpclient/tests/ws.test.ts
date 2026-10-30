/**
 * @ai-factory/httpclient — minimal WS client tests (dist).
 * A hand-rolled echo server (upgrade + masked-frame parsing) stands in
 * for a real WS endpoint; no external dependency is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { wsConnect, WsError } from '../src/index.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frameUnmasked(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 0xfe, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

function startEchoServer(): Promise<{ srv: Server; port: number }> {
  const srv = createServer();
  srv.on('upgrade', (req, sock: Socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if ((b1 & 0x80) === 0) return; // client frames must be masked; wait for more
        const mask = buf.subarray(off, off + 4);
        off += 4;
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        if (opcode === 0x1) {
          sock.write(frameUnmasked(0x1, Buffer.from(`echo:${unmasked.toString('utf8')}`, 'utf8')));
        } else if (opcode === 0x9) {
          sock.write(frameUnmasked(0xa, unmasked));
        } else if (opcode === 0x8) {
          sock.write(frameUnmasked(0x8, unmasked));
          sock.end();
          return;
        }
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: (srv.address() as { port: number }).port }));
  });
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('ws client echoes text and reports close', async () => {
  const { srv, port } = await startEchoServer();
  try {
    const client = await wsConnect(`ws://127.0.0.1:${port}/echo`, 5000);
    const received: string[] = [];
    const closed: Array<[number, string]> = [];
    client.onMessage((t) => received.push(t));
    client.onClose((code, reason) => closed.push([code, reason]));
    client.sendText('hello');
    await waitFor(() => received.length > 0);
    assert.equal(received[0], 'echo:hello');
    client.close(1000, 'done');
    await waitFor(() => client.closed);
    assert.equal(client.closed, true);
    assert.equal(closed[0]?.[0], 1000);
    assert.throws(() => client.sendText('late'), (e: unknown) => (e as WsError).message === 'ws connection is closed');
  } finally {
    srv.close();
  }
});

test('ws client rejects non-ws schemes and refused connections fail closed', async () => {
  await assert.rejects(() => wsConnect('http://127.0.0.1:9/x', 2000), /only ws:\/\/ and wss:\/\//);
  await assert.rejects(() => wsConnect('ws://127.0.0.1:9/x', 2000), /.+/);
});
