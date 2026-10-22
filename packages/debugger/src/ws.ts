/**
 * @ai-factory/debugger — minimal WebSocket client (node:net only).
 *
 * Written for one job: talking to `node --inspect`'s CDP endpoint on
 * localhost. It is NOT a general-purpose WS implementation:
 *   - ws:// only (no TLS; the inspector never serves wss on loopback here)
 *   - client -> server frames are masked text or close (per RFC 6455)
 *   - server -> client: text (fragmented OK), ping/pong, close
 *   - binary frames are rejected fail-closed
 * Zero dependencies.
 */
import { randomBytes, createHash } from 'node:crypto';
import { connect, Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class WsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsError';
  }
}

export interface WsClient {
  sendText(text: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  close(code?: number): void;
  readonly closed: boolean;
}

export function wsConnect(url: string, timeoutMs = 10000): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, client?: WsClient): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(client as WsClient);
    };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      done(new WsError(`invalid ws url: ${url}`));
      return;
    }
    if (u.protocol !== 'ws:') {
      done(new WsError(`only ws:// is supported, got ${u.protocol}`));
      return;
    }
    const port = u.port ? Number(u.port) : 80;
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');

    let buf = Buffer.alloc(0);
    let handshaked = false;
    let closed = false;
    let msgCb: ((text: string) => void) | null = null;
    let closeCb: ((code: number, reason: string) => void) | null = null;
    // fragmented text accumulation
    let fragOpcode = -1;
    let fragBuf = Buffer.alloc(0);

    const sock: Socket = connect(port, u.hostname || '127.0.0.1');
    const timer = setTimeout(() => {
      sock.destroy();
      done(new WsError(`ws connect timeout after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    const failClosed = (err: Error): void => {
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      if (!handshaked) done(err);
      else if (!closed) {
        closed = true;
        if (closeCb) closeCb(1006, err.message);
      }
    };

    const sendFrame = (opcode: number, payload: Buffer): void => {
      if (closed) return;
      const mask = randomBytes(4);
      const len = payload.length;
      let header: Buffer;
      if (len < 126) {
        header = Buffer.alloc(2 + 4);
        header[1] = 0x80 | len;
      } else if (len < 65536) {
        header = Buffer.alloc(4 + 4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10 + 4);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      header[0] = 0x80 | opcode;
      mask.copy(header, header.length - 4);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, masked]));
    };

    const deliverText = (text: string): void => {
      if (msgCb) {
        try {
          msgCb(text);
        } catch {
          /* listener errors must not kill the socket */
        }
      }
    };

    const handleClose = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        sock.end();
      } catch {
        /* ignore */
      }
      if (closeCb) closeCb(code, reason);
    };

    const parseFrames = (): void => {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(MAX_FRAME_BYTES)) {
            failClosed(new WsError('ws frame too large'));
            return;
          }
          len = Number(big);
          off = 10;
        }
        if (len > MAX_FRAME_BYTES) {
          failClosed(new WsError('ws frame too large'));
          return;
        }
        const maskBytes = masked ? 4 : 0;
        if (buf.length < off + maskBytes + len) return;
        const mask = masked ? buf.slice(off, off + 4) : null;
        let payload = buf.slice(off + maskBytes, off + maskBytes + len);
        buf = buf.slice(off + maskBytes + len);
        if (mask) {
          // Server->client frames are never masked per RFC 6455, but unmask
          // defensively instead of failing the whole connection.
          const unmasked = Buffer.alloc(len);
          for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
          payload = unmasked;
        }

        if (opcode === 0x8) {
          let code = 1005;
          let reason = '';
          if (payload.length >= 2) {
            code = payload.readUInt16BE(0);
            reason = payload.slice(2).toString('utf8');
          }
          // echo the close and finish
          sendFrame(0x8, payload);
          handleClose(code, reason);
          return;
        }
        if (opcode === 0x9) {
          sendFrame(0xa, payload); // pong
          continue;
        }
        if (opcode === 0xa) continue; // pong — ignore
        if (opcode === 0x2) {
          failClosed(new WsError('binary ws frames are not supported'));
          return;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          if (opcode === 0x1) {
            fragOpcode = 0x1;
            fragBuf = payload;
          } else {
            if (fragOpcode !== 0x1) {
              failClosed(new WsError('unexpected continuation frame'));
              return;
            }
            fragBuf = Buffer.concat([fragBuf, payload]);
          }
          if (fin) {
            fragOpcode = -1;
            const text = fragBuf.toString('utf8');
            fragBuf = Buffer.alloc(0);
            deliverText(text);
          }
          continue;
        }
        failClosed(new WsError(`unsupported ws opcode ${opcode}`));
        return;
      }
    };

    sock.on('connect', () => {
      const path = (u.pathname || '/') + (u.search || '');
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${u.hostname}:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaked) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) {
          if (buf.length > 16384) failClosed(new WsError('ws handshake header too large'));
          return;
        }
        const head = buf.slice(0, idx).toString('ascii');
        buf = buf.slice(idx + 4);
        const statusLine = head.split('\r\n')[0] ?? '';
        if (!/ 101 /.test(statusLine)) {
          failClosed(new WsError(`ws handshake rejected: ${statusLine}`));
          return;
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1] ?? '';
        if (accept !== expectedAccept) {
          failClosed(new WsError('ws handshake accept key mismatch'));
          return;
        }
        handshaked = true;
        clearTimeout(timer);
        const client: WsClient = {
          sendText: (text: string) => sendFrame(0x1, Buffer.from(text, 'utf8')),
          onMessage: (cb) => {
            msgCb = cb;
          },
          onClose: (cb) => {
            closeCb = cb;
          },
          close: (code = 1000) => {
            if (closed) return;
            const payload = Buffer.alloc(2);
            payload.writeUInt16BE(code, 0);
            sendFrame(0x8, payload);
            handleClose(code, '');
          },
          get closed() {
            return closed;
          },
        };
        done(null, client);
      }
      if (handshaked && !closed) parseFrames();
    });
    sock.on('error', (e) => failClosed(e as Error));
    sock.on('close', () => handleClose(1006, 'socket closed'));
  });
}
