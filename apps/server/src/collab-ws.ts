/**
 * 最小 WebSocket (RFC 6455) 服务端 — 第三波任务⑩ 实时协同 MVP.
 *
 * 仓库零外部依赖约定：不用 `ws` 包，用 node:crypto + node:net 手写。
 * 只实现协同通道需要的子集：
 *  - 服务端握手（Sec-WebSocket-Accept）
 *  - 客户端掩码帧解析：text(0x1)/continuation(0x0)/ping(0x9)/pong(0xA)/close(0x8)
 *  - 服务端发送：text 帧（不掩码）、ping、close
 *  - 二进制帧(0x2)直接协议错误关闭（协同通道只走 JSON 文本）
 *
 * 诚实边界：
 *  - 不支持 extensions（permessage-deflate 等）：握手不协商，客户端发了也忽略。
 *  - 单消息上限 1MB，超出直接关闭连接（fail-closed，不截断造假）。
 *  - 这是 MVP 级实现，不是通用 WS 库；只供 /api/collab 使用。
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { createHash, randomBytes } from 'crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 单条 WS 消息上限 1MB（协同 op 批量在此之下；超限直接断开）。 */
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface WsConnectionEvents {
  onMessage: (text: string) => void;
  onClose: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
}

function computeAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * 尝试把一个 HTTP upgrade 接成 WebSocket。返回 null 表示不是合法的
 * WS 握手（调用方应自行 400/426 并销毁 socket）。
 */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers['upgrade'];
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  return (
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket' &&
    typeof key === 'string' &&
    key.length > 0 &&
    version === '13'
  );
}

export function writeWebSocketHandshake(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key) return false;
  const accept = computeAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );
  return true;
}

/** 101 之后 socket 上可能已带有 head 字节：必须先消费 head 再进入帧循环。 */
export class WsConnection {
  private buf = Buffer.alloc(0);
  private fragOpcode: 0x1 | null = null;
  private fragParts: Buffer[] = [];
  private fragBytes = 0;
  private closed = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private socket: Duplex,
    private events: WsConnectionEvents,
    head: Buffer,
  ) {
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.onSocketClose(1006, 'socket closed'));
    socket.on('error', (e) => {
      try {
        this.events.onError?.(e instanceof Error ? e : new Error(String(e)));
      } catch { /* 忽略回调异常 */ }
      this.destroy();
    });
    if (head.length > 0) this.onData(head);
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  sendText(text: string): void {
    if (!this.isOpen) return;
    const payload = Buffer.from(text, 'utf8');
    this.sendFrame(0x1, payload);
  }

  ping(data: Buffer = randomBytes(8)): void {
    if (!this.isOpen) return;
    this.sendFrame(0x9, data.slice(0, 125));
  }

  /** 发送 close 帧并在 5s 后强制销毁（对端不回也关）。 */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    const reasonBuf = Buffer.from(reason, 'utf8').slice(0, 123);
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this.sendFrame(0x8, payload);
    } catch { /* ignore */ }
    this.closeTimer = setTimeout(() => this.destroy(), 5000);
    this.closeTimer.unref?.();
  }

  destroy(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closed = true;
    try {
      this.socket.destroy();
    } catch { /* ignore */ }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | (opcode & 0x0f);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    try {
      this.parseLoop();
    } catch (e) {
      this.protocolError(e instanceof Error ? e.message : 'frame parse error');
    }
  }

  private parseLoop(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0] as number;
      const b1 = this.buf[1] as number;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let off = 2;
      if (payloadLen === 126) {
        if (this.buf.length < 4) return;
        payloadLen = this.buf.readUInt16BE(2);
        off = 4;
      } else if (payloadLen === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(WS_MAX_MESSAGE_BYTES)) throw new Error('frame too large');
        payloadLen = Number(big);
        off = 10;
      }
      const maskOff = masked ? 4 : 0;
      if (this.buf.length < off + maskOff + payloadLen) return;
      // 客户端帧必须掩码（RFC 6455 §5.1）；服务端发出的不掩码。
      if (!masked) throw new Error('client frame not masked');
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.alloc(payloadLen);
      const src = this.buf.subarray(off + 4, off + 4 + payloadLen);
      for (let i = 0; i < payloadLen; i++) payload[i] = (src[i] as number) ^ (mask[i % 4] as number);
      this.buf = this.buf.subarray(off + 4 + payloadLen);
      this.handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      // close
      let code = 1005;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      this.onSocketClose(code, reason);
      this.destroy();
      return;
    }
    if (opcode === 0x9) {
      // ping → pong（payload 原样返回，上限 125）
      if (payload.length > 125) throw new Error('ping too large');
      if (this.isOpen) this.sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong：忽略（心跳由应用层 presence TTL 负责）
    if (opcode === 0x2) throw new Error('binary frames not supported');
    if (opcode !== 0x0 && opcode !== 0x1) throw new Error(`unknown opcode ${opcode}`);
    if (!fin || opcode === 0x0) {
      // 分片：累积
      if (opcode === 0x1) {
        if (this.fragOpcode !== null) throw new Error('interleaved fragments');
        this.fragOpcode = 0x1;
      } else if (this.fragOpcode === null) {
        throw new Error('continuation without start');
      }
      this.fragBytes += payload.length;
      if (this.fragBytes > WS_MAX_MESSAGE_BYTES) throw new Error('message too large');
      this.fragParts.push(payload);
      if (!fin) return;
      const text = Buffer.concat(this.fragParts).toString('utf8');
      this.fragOpcode = null;
      this.fragParts = [];
      this.fragBytes = 0;
      this.emitMessage(text);
      return;
    }
    if (payload.length > WS_MAX_MESSAGE_BYTES) throw new Error('message too large');
    this.emitMessage(payload.toString('utf8'));
  }

  private emitMessage(text: string): void {
    try {
      this.events.onMessage(text);
    } catch (e) {
      this.events.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private protocolError(msg: string): void {
    try {
      this.close(1002, msg);
    } catch { /* ignore */ }
    this.destroy();
  }

  private onSocketClose(code: number, reason: string): void {
    if (this.closed && code === 1006) return;
    const wasClosed = this.closed;
    this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    try {
      this.events.onClose(wasClosed ? code : 1006, reason);
    } catch { /* ignore */ }
  }
}
