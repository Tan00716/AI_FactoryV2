/**
 * @ai-factory/httpclient — minimal WebSocket client (round-7 task R7-#9).
 *
 * Zero dependencies, node:net / node:tls only, following the precedent
 * of packages/debugger/src/ws.ts (CDP client) but generalized:
 *  - ws:// and wss:// (TLS via node:tls, default ports 80/443)
 *  - client -> server: masked text or close frames (RFC 6455)
 *  - server -> client: text (fragmented OK), ping (auto-pong), pong,
 *    close handshake; binary frames are rejected fail-closed
 *  - no subprotocol negotiation beyond an optional list sent in the
 *    handshake; the server's choice is reported, not enforced
 *
 * Deliberately small: this is a debug client for API testing, not a
 * production WS stack. No compression extensions, no auto-reconnect
 * (disconnect semantics are explicit: the session records closed +
 * close code/reason and further sends fail with 'ws-closed').
 */
import { randomBytes, createHash } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Single-frame cap; larger frames fail the connection closed. */
export const WS_MAX_FRAME_BYTES = 1024 * 1024;

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
  onError(cb: (err: Error) => void): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
  readonly protocol: string;
}

function frameMaskedText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > WS_MAX_FRAME_BYTES) throw new WsError('ws text frame too large');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

function frameClose(code: number, reason: string): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x88, 0x80 | body.length]), mask, masked]);
}

export function wsConnect(urlText: string, timeoutMs = 10_000, protocols: string[] = []): Promise<WsClient> {
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
      u = new URL(urlText);
    } catch {
      done(new WsError(`invalid ws url: ${urlText}`));
      return;
    }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      done(new WsError(`only ws:// and wss:// are supported, got ${u.protocol}`));
      return;
    }
    const secure = u.protocol === 'wss:';
    const port = u.port ? Number(u.port) : secure ? 443 : 80;
    const host = u.hostname || '127.0.0.1';
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const path = (u.pathname || '/') + u.search;

    let buf = Buffer.alloc(0);
    let handshaked = false;
    let closed = false;
    let msgCb: ((text: string) => void) | null = null;
    let closeCb: ((code: number, reason: string) => void) | null = null;
    let errCb: ((err: Error) => void) | null = null;
    let fragOpcode = -1;
    let fragBuf = Buffer.alloc(0);
    let negotiatedProtocol = '';

    const sock: Socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect(port, host);
    const timer = setTimeout(() => {
      sock.destroy();
      done(new WsError(`ws connect timeout after ${timeoutMs}ms: ${urlText}`));
    }, timeoutMs);

    const doClose = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      if (closeCb) closeCb(code, reason);
    };
    const failClosed = (err: Error): void => {
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      if (!handshaked) done(err);
      else if (!closed) {
        if (errCb) errCb(err);
        doClose(1011, err.message);
      }
    };

    const pumpFrames = (): void => {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        if ((b1 & 0x80) !== 0) {
          failClosed(new WsError('server sent a masked frame (protocol violation)'));
          return;
        }
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          const hi = buf.readUInt32BE(2);
          const lo = buf.readUInt32BE(6);
          if (hi !== 0 || lo > WS_MAX_FRAME_BYTES) {
            failClosed(new WsError('ws frame too large'));
            return;
          }
          len = lo;
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x9) {
          // ping -> pong (same payload, masked)
          const mask = randomBytes(4);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
          try {
            sock.write(Buffer.concat([Buffer.from([0x8a, 0x80 | payload.length]), mask, masked]));
          } catch {
            /* socket gone; close path handles it */
          }
          continue;
        }
        if (opcode === 0xa) continue; // pong: ignore
        if (opcode === 0x8) {
          let code = 1005;
          let reason = '';
          if (payload.length >= 2) {
            code = payload.readUInt16BE(0);
            reason = payload.subarray(2).toString('utf8');
          }
          doClose(code, reason);
          return;
        }
        if (opcode === 0x2) {
          failClosed(new WsError('binary frames are not supported (fail-closed)'));
          return;
        }
        if (opcode === 0x0) {
          if (fragOpcode < 0) {
            failClosed(new WsError('continuation frame without an open fragment'));
            return;
          }
          fragBuf = Buffer.concat([fragBuf, payload]);
          if (fin) {
            const text = fragBuf.toString('utf8');
            fragOpcode = -1;
            fragBuf = Buffer.alloc(0);
            if (msgCb) msgCb(text);
          }
          continue;
        }
        if (opcode === 0x1) {
          if (fragOpcode >= 0) {
            failClosed(new WsError('new text frame while a fragment is open'));
            return;
          }
          if (fin) {
            if (msgCb) msgCb(payload.toString('utf8'));
          } else {
            fragOpcode = 0x1;
            fragBuf = Buffer.from(payload);
          }
          continue;
        }
        failClosed(new WsError(`unsupported ws opcode ${opcode}`));
        return;
      }
    };

    sock.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (protocols.length > 0) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
      lines.push('', '');
      sock.write(lines.join('\r\n'));
    });
    sock.on('data', (chunk: Buffer) => {
      if (!handshaked) {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > 16_384) failClosed(new WsError('ws handshake headers too large'));
          return;
        }
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        const lines = head.split('\r\n');
        const status = lines[0] ?? '';
        if (!/^HTTP\/1\.1 101\b/.test(status)) {
          failClosed(new WsError(`ws handshake failed: ${status}`));
          return;
        }
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(':');
          if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        if ((headers['sec-websocket-accept'] ?? '') !== expectedAccept) {
          failClosed(new WsError('ws handshake accept key mismatch'));
          return;
        }
        negotiatedProtocol = headers['sec-websocket-protocol'] ?? '';
        handshaked = true;
        clearTimeout(timer);
        const client: WsClient = {
          sendText(text: string): void {
            if (closed) throw new WsError('ws connection is closed');
            sock.write(frameMaskedText(text));
          },
          onMessage(cb: (text: string) => void): void {
            msgCb = cb;
          },
          onClose(cb: (code: number, reason: string) => void): void {
            closeCb = cb;
          },
          onError(cb: (err: Error) => void): void {
            errCb = cb;
          },
          close(code = 1000, reason = ''): void {
            if (closed) return;
            try {
              sock.write(frameClose(code, reason));
            } catch {
              /* ignore */
            }
            // Give the peer a beat to echo close, then destroy.
            setTimeout(() => doClose(code, reason), 250).unref?.();
          },
          get closed(): boolean {
            return closed;
          },
          get protocol(): string {
            return negotiatedProtocol;
          },
        };
        done(null, client);
        if (buf.length > 0) pumpFrames();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      pumpFrames();
    });
    sock.on('error', (e) => failClosed(e as Error));
    sock.on('close', () => {
      if (handshaked && !closed) doClose(1006, 'socket closed without a close frame');
      else if (!handshaked) failClosed(new WsError('socket closed during ws handshake'));
    });
  });
}
