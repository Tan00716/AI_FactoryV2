/**
 * 实时协同 MVP — 第三波任务⑩（Zed 式，不依赖真实模型，不做语音/视频）。
 *
 *   WS    /api/collab?projectId=&token=   协同通道（房间 = projectId）
 *   GET   /api/collab/rooms               房间列表（viewer）
 *   GET   /api/collab/chat?projectId=     聊天记录（viewer，DB 持久化）
 *   POST  /api/collab/chat                发聊天（operator）
 *   GET   /api/collab/doc?projectId=      文档快照（viewer）
 *
 * 协议（JSON 文本帧）：
 *   C→S: hello{user,color} / presence{panel,cursor,allowFollow} /
 *        op{ops} / chat{text} / watchTerm{sessionId} / unwatchTerm{sessionId} /
 *        follow{target} / heartbeat
 *   S→C: welcome{memberId,snapshot,chat,presence,termSessions} /
 *        presence{members} / ops{from,ops} / chat{msg} /
 *        termOut{sessionId,b64} / termClosed{sessionId} / error{code,message}
 *
 * 安全：
 *  - WS 握手走 upgrade 事件（不经过主 request 分发），在此处做完整鉴权：
 *    Authorization 头优先，浏览器用 ?token= 回退（query token 是浏览器
 *    限制下的惯例；非浏览器客户端请用头）。
 *  - 加入房间 viewer+；op/chat 需要 operator+（viewer 发来 → error +
 *    首犯审计 COLLAB_RBAC_DENIED，不刷屏）。
 *  - 所有文本字段过 sanitizeUntrusted；编辑内容本身不进审计，只记元数据。
 *  - 终端只读流：复用 terminal.ts 的 createStreamRedactor（与 SSE 流同一
 *    脱敏），collab 永远不调 session 写 stdin——没有输入路径。
 *
 * 诚实边界（MVP）：
 *  - RGA 只处理纯文本；文档上限 200k 字符（见 collab-rga.ts）。
 *  - 断线重连 = 重新拿快照，不是操作回放。
 *  - 跟随模式是只读视图同步（桌面端切 tab），不抢控制。
 *  - 聊天记录是每房间 500 条的环形缓冲，不是无限存档。
 *  - presence 靠心跳维持；90s 无消息视为离开。
 *
 * Wired into apps/server/src/index.ts by the coordinator:
 *   import { handleCollabRoutes, handleCollabUpgrade, initCollabService } from './routes/collab';
 *   initCollabService(makeRouteCtx(), AUTH_CONFIG);
 *   if (await handleCollabRoutes(req, res, url, routeCtx)) return;
 *   server.on('upgrade', (req, socket, head) => { if (!handleCollabUpgrade(req, socket, head)) { socket.write('HTTP/1.1 404 ...'); socket.destroy(); } });
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { Duplex } from 'stream';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { RouteContext } from './context';
import { RgaDocument, type RgaOp, type RgaId } from '@ai-factory/collab';
import {
  WsConnection,
  isWebSocketUpgrade,
  writeWebSocketHandshake,
} from '../collab-ws';
import { sanitizeUntrusted } from '@ai-factory/security';
import {
  authMode,
  roleForAuthorization,
  roleRank,
  type ApiAuthConfig,
  type ApiRole,
} from '../auth';
import { terminalSessionManager, type TerminalStreamRedactor } from './terminal';
import { MAX_CHAT_TEXT_CHARS, type CollabChatMessage } from '@ai-factory/db';

const PREFIX = '/api/collab';
const PRESENCE_TIMEOUT_MS = 90_000;
const HEARTBEAT_MS = 25_000;
const MAX_OPS_PER_MESSAGE = 2000;
const MAX_USER_NAME = 40;
const MAX_PANEL_NAME = 40;
const CHAT_HISTORY_SEND = 50;

const COLOR_PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
];

export interface CollabMemberView {
  id: string;
  userName: string;
  color: string;
  role: ApiRole;
  panel: string;
  cursor: { line: number; col: number } | null;
  allowFollow: boolean;
  followTarget: string | null;
}

interface Member {
  id: string;
  userName: string;
  color: string;
  role: ApiRole;
  conn: WsConnection;
  panel: string;
  cursor: { line: number; col: number } | null;
  allowFollow: boolean;
  followTarget: string | null;
  seq: number;
  lastActivity: number;
  denialAudited: boolean;
}

interface TermWatch {
  sessionId: string;
  unsubOutput: () => void;
  unsubClose: () => void;
  redactor: TerminalStreamRedactor | null;
  decoder: StringDecoder;
  watchers: Set<string>;
}

interface Room {
  projectId: string;
  doc: RgaDocument;
  members: Map<string, Member>;
  termWatches: Map<string, TermWatch>;
}

function sanitizeText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return sanitizeUntrusted(raw).sanitized.trim().slice(0, max);
}

/**
 * 标识符型字段（成员名/面板名）：只允许可打印安全字符并截断，
 * 不做 sanitizeUntrusted 的引用块包装——否则 'alice' 会变成引用块，
 * 破坏 presence 显示与面板白名单校验。
 */
function sanitizeIdent(raw: unknown, max: number, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw
    .replace(/[^\p{L}\p{N} _+\-.()]/gu, '')
    .trim()
    .slice(0, max);
  return s || fallback;
}

function isValidRgaId(v: unknown): v is RgaId {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['site'] === 'string' &&
    (o['site'] as string).length > 0 &&
    (o['site'] as string).length <= 64 &&
    Number.isInteger(o['seq']) &&
    (o['seq'] as number) >= 0
  );
}

function isValidRgaOp(v: unknown): v is RgaOp {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o['type'] === 'insert') {
    return (
      isValidRgaId(o['id']) &&
      (o['left'] === null || isValidRgaId(o['left'])) &&
      typeof o['ch'] === 'string' &&
      [...(o['ch'] as string)].length === 1
    );
  }
  if (o['type'] === 'remove') return isValidRgaId(o['id']);
  return false;
}

function roomKeyOf(raw: unknown): string {
  if (typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  return 'default';
}

function colorFor(userName: string, explicit: unknown): string {
  if (typeof explicit === 'string' && /^#[0-9a-fA-F]{6}$/.test(explicit)) return explicit;
  let h = 0;
  for (const c of userName) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return COLOR_PALETTE[h % COLOR_PALETTE.length] as string;
}

export class CollabService {
  private rooms = new Map<string, Room>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private ctx: RouteContext,
    private authConfig: ApiAuthConfig,
  ) {}

  /** 心跳/ping 定时器（幂等）。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** WS upgrade 入口：pathname 必须为 /api/collab。返回 false 表示不是协同路径。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== PREFIX) return false;
    if (!isWebSocketUpgrade(req)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return true;
    }
    const role = this.resolveWsRole(req, url);
    if (!role || roleRank(role) < roleRank('viewer')) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      } catch { /* ignore */ }
      socket.destroy();
      this.ctx.audit.record('unknown', 'COLLAB_AUTH_DENIED', 'collab-room', roomKeyOf(url.searchParams.get('projectId')), {
        reason: 'bad or missing token',
      });
      return true;
    }
    if (!writeWebSocketHandshake(req, socket)) {
      socket.destroy();
      return true;
    }
    const projectId = roomKeyOf(url.searchParams.get('projectId'));
    const room = this.roomFor(projectId);
    const conn = new WsConnection(
      socket,
      {
        onMessage: (text) => this.onMessage(room, member, text),
        onClose: () => this.removeMember(room, member.id, 'close'),
        onError: () => { /* 出错即走 onClose 清理 */ },
      },
      head,
    );
    // member 先占位，hello 到达后补全身份；超时无 hello 则踢出。
    const member: Member = {
      id: randomUUID(),
      userName: '',
      color: '#888888',
      role,
      conn,
      panel: '',
      cursor: null,
      allowFollow: false,
      followTarget: null,
      seq: 0,
      lastActivity: Date.now(),
      denialAudited: false,
    };
    room.members.set(member.id, member);
    setTimeout(() => {
      if (room.members.get(member.id)?.userName === '') {
        this.send(member, { t: 'error', code: 'HELLO_TIMEOUT', message: 'no hello received' });
        conn.close(1008, 'hello timeout');
        this.removeMember(room, member.id, 'hello-timeout');
      }
    }, 10_000).unref?.();
    return true;
  }

  private resolveWsRole(req: IncomingMessage, url: URL): ApiRole | null {
    if (authMode(this.authConfig) === 'open') return 'admin';
    const header = req.headers.authorization;
    let role: ApiRole | null = typeof header === 'string' ? roleForAuthorization(header, this.authConfig) : null;
    if (!role) {
      const token = url.searchParams.get('token');
      if (token) role = roleForAuthorization(`Bearer ${token}`, this.authConfig);
    }
    return role;
  }

  private roomFor(projectId: string): Room {
    let room = this.rooms.get(projectId);
    if (!room) {
      room = { projectId, doc: new RgaDocument(), members: new Map(), termWatches: new Map() };
      this.rooms.set(projectId, room);
    }
    return room;
  }

  // ---------------------------------------------------------- 消息处理 --
  private onMessage(room: Room, member: Member, text: string): void {
    member.lastActivity = Date.now();
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      msg = parsed as Record<string, unknown>;
    } catch {
      this.send(member, { t: 'error', code: 'BAD_JSON', message: 'message must be a JSON object' });
      return;
    }
    const t = msg['t'];
    try {
      switch (t) {
        case 'hello':
          this.onHello(room, member, msg);
          break;
        case 'heartbeat':
          break; // lastActivity 已更新
        case 'presence':
          this.onPresence(room, member, msg);
          break;
        case 'op':
          this.onOp(room, member, msg);
          break;
        case 'chat':
          this.onChat(room, member, msg);
          break;
        case 'watchTerm':
          this.onWatchTerm(room, member, msg);
          break;
        case 'unwatchTerm':
          this.onUnwatchTerm(room, member, msg);
          break;
        case 'follow':
          this.onFollow(room, member, msg);
          break;
        default:
          this.send(member, { t: 'error', code: 'UNKNOWN_MESSAGE', message: `unknown message type: ${String(t)}` });
      }
    } catch (e) {
      this.send(member, { t: 'error', code: 'HANDLER_ERROR', message: (e as Error).message });
    }
  }

  private onHello(room: Room, member: Member, msg: Record<string, unknown>): void {
    if (member.userName !== '') {
      this.send(member, { t: 'error', code: 'ALREADY_HELLO', message: 'hello already sent' });
      return;
    }
    const userName = sanitizeIdent(msg['user'], MAX_USER_NAME, 'anonymous');
    member.userName = userName;
    member.color = colorFor(userName, msg['color']);
    member.panel = sanitizeIdent(msg['panel'], MAX_PANEL_NAME, '');
    this.ctx.audit.record(`collab/${userName}`, 'COLLAB_JOINED', 'collab-room', room.projectId, {
      role: member.role,
      members: room.members.size,
    });
    let chat: CollabChatMessage[] = [];
    try {
      chat = this.ctx.fdb.collabChat.recent(room.projectId, CHAT_HISTORY_SEND);
    } catch { /* DB 失败不阻塞加入 */ }
    this.send(member, {
      t: 'welcome',
      memberId: member.id,
      snapshot: room.doc.snapshot(),
      chat: chat.map((m) => ({ id: m.id, userName: m.userName, text: m.text, createdAt: m.createdAt })),
      presence: this.presenceView(room),
      termSessions: this.termSessionList(),
    });
    this.broadcastPresence(room);
  }

  private onPresence(room: Room, member: Member, msg: Record<string, unknown>): void {
    if (member.userName === '') return; // hello 之前忽略
    if (msg['panel'] !== undefined) member.panel = sanitizeIdent(msg['panel'], MAX_PANEL_NAME, '');
    if (msg['cursor'] !== undefined) {
      const c = msg['cursor'] as { line?: unknown; col?: unknown } | null;
      member.cursor =
        c && Number.isInteger(c.line) && Number.isInteger(c.col)
          ? { line: Math.max(0, c.line as number), col: Math.max(0, c.col as number) }
          : null;
    }
    if (msg['allowFollow'] !== undefined) member.allowFollow = msg['allowFollow'] === true;
    if (msg['color'] !== undefined) member.color = colorFor(member.userName, msg['color']);
    this.broadcastPresence(room);
  }

  private requireOperator(member: Member, what: string): boolean {
    if (roleRank(member.role) >= roleRank('operator')) return true;
    this.send(member, { t: 'error', code: 'RBAC_DENIED', message: `${what} requires operator role` });
    if (!member.denialAudited) {
      member.denialAudited = true;
      this.ctx.audit.record(`collab/${member.userName || member.id}`, 'COLLAB_RBAC_DENIED', 'collab-room', what, {
        role: member.role,
      });
    }
    return false;
  }

  private onOp(room: Room, member: Member, msg: Record<string, unknown>): void {
    if (!this.requireOperator(member, 'doc edit')) return;
    const raw = msg['ops'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPS_PER_MESSAGE) {
      this.send(member, { t: 'error', code: 'BAD_OPS', message: `ops must be a non-empty array (<= ${MAX_OPS_PER_MESSAGE})` });
      return;
    }
    const applied: RgaOp[] = [];
    for (const o of raw) {
      if (!isValidRgaOp(o)) {
        this.send(member, { t: 'error', code: 'BAD_OP', message: 'malformed op rejected' });
        return;
      }
      // 站点必须是自己：防止伪造他人 site 污染排序（MVP 级防线）。
      if (o.type === 'insert' && o.id.site !== member.id) {
        this.send(member, { t: 'error', code: 'BAD_OP', message: 'op site must be your memberId' });
        return;
      }
      const r = room.doc.apply(o);
      if (r === 'applied' || r === 'buffered') applied.push(o);
      // duplicate：已见过，不再广播；rejected：非法，静默丢弃
    }
    if (applied.length > 0) {
      this.broadcast(room, { t: 'ops', from: member.id, ops: applied }, member.id);
      this.ctx.audit.record(`collab/${member.userName}`, 'COLLAB_DOC_EDITED', 'collab-room', room.projectId, {
        ops: applied.length,
        docChars: room.doc.length,
      });
    }
  }

  private onChat(room: Room, member: Member, msg: Record<string, unknown>): void {
    if (!this.requireOperator(member, 'chat')) return;
    const text = sanitizeText(msg['text'], MAX_CHAT_TEXT_CHARS);
    if (!text) {
      this.send(member, { t: 'error', code: 'EMPTY_CHAT', message: 'chat text is empty' });
      return;
    }
    let stored: CollabChatMessage;
    try {
      stored = this.ctx.fdb.collabChat.add(room.projectId, member.userName, text);
    } catch (e) {
      this.send(member, { t: 'error', code: 'CHAT_STORE_FAILED', message: (e as Error).message });
      return;
    }
    const view = { id: stored.id, userName: stored.userName, text: stored.text, createdAt: stored.createdAt };
    this.broadcast(room, { t: 'chat', msg: view });
    this.ctx.audit.record(`collab/${member.userName}`, 'COLLAB_CHAT', 'collab-room', room.projectId, {
      msgId: stored.id,
      chars: text.length,
    });
  }

  // ---------------------------------------------------------- 终端只读 --
  private termSessionList(): Array<Record<string, unknown>> {
    try {
      return terminalSessionManager()
        .list()
        .map((s) => ({ id: s.id, principal: s.principal, createdAt: s.createdAt }));
    } catch {
      return [];
    }
  }

  private onWatchTerm(room: Room, member: Member, msg: Record<string, unknown>): void {
    const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
      this.send(member, { t: 'error', code: 'BAD_SESSION_ID', message: 'invalid sessionId' });
      return;
    }
    let watch = room.termWatches.get(sessionId);
    if (!watch) {
      let session;
      try {
        session = terminalSessionManager().get(sessionId);
      } catch {
        this.send(member, { t: 'error', code: 'SESSION_NOT_FOUND', message: `unknown terminal session: ${sessionId}` });
        return;
      }
      // 与 SSE 流同一脱敏：session 自带的 createStreamRedactor（创建时安装）。
      const hook = (
        session as unknown as {
          createStreamRedactor?: (hitCtx: RouteContext) => TerminalStreamRedactor;
        }
      ).createStreamRedactor;
      const redactor = hook ? hook(this.ctx) : null;
      const decoder = new StringDecoder('utf8');
      const w: TermWatch = {
        sessionId,
        unsubOutput: () => {},
        unsubClose: () => {},
        redactor,
        decoder,
        watchers: new Set(),
      };
      // 只读：只订阅 onOutput，永远不写 stdin——collab 没有输入路径。
      w.unsubOutput = session.onOutput((chunk: Buffer) => {
        const text = redactor ? redactor.push(decoder.write(chunk)) : decoder.write(chunk);
        if (!text) return;
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        for (const watcherId of w.watchers) {
          const m = room.members.get(watcherId);
          if (m) this.send(m, { t: 'termOut', sessionId, b64 });
        }
      });
      w.unsubClose = session.onClose(() => {
        this.broadcast(room, { t: 'termClosed', sessionId });
        this.dropTermWatch(room, sessionId);
      });
      room.termWatches.set(sessionId, w);
      watch = w;
      // 迟到者补 backlog（transcript），与 SSE 流行为一致。
      try {
        const backlog = session.transcriptText();
        if (backlog) {
          this.send(member, {
            t: 'termOut',
            sessionId,
            b64: Buffer.from(backlog, 'utf8').toString('base64'),
          });
        }
      } catch { /* 忽略 */ }
    }
    watch.watchers.add(member.id);
    this.send(member, { t: 'termWatching', sessionId });
  }

  private onUnwatchTerm(room: Room, member: Member, msg: Record<string, unknown>): void {
    const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
    const watch = room.termWatches.get(sessionId);
    if (watch) {
      watch.watchers.delete(member.id);
      if (watch.watchers.size === 0) this.dropTermWatch(room, sessionId);
    }
    this.send(member, { t: 'termWatching', sessionId, stopped: true });
  }

  private dropTermWatch(room: Room, sessionId: string): void {
    const watch = room.termWatches.get(sessionId);
    if (!watch) return;
    try {
      watch.unsubOutput();
    } catch { /* ignore */ }
    try {
      watch.unsubClose();
    } catch { /* ignore */ }
    room.termWatches.delete(sessionId);
  }

  private onFollow(room: Room, member: Member, msg: Record<string, unknown>): void {
    const target = msg['target'];
    if (target !== null && (typeof target !== 'string' || !room.members.has(target))) {
      this.send(member, { t: 'error', code: 'BAD_FOLLOW_TARGET', message: 'unknown member' });
      return;
    }
    if (target !== null) {
      const targetMember = room.members.get(target as string);
      if (targetMember && !targetMember.allowFollow && targetMember.id !== member.id) {
        this.send(member, { t: 'error', code: 'FOLLOW_NOT_ALLOWED', message: 'that member does not allow following' });
        return;
      }
    }
    member.followTarget = target as string | null;
    this.broadcastPresence(room);
  }

  // -------------------------------------------------------------- 广播 --
  private send(member: Member, payload: unknown): void {
    try {
      member.conn.sendText(JSON.stringify(payload));
    } catch { /* 发送失败由 close 清理 */ }
  }

  private broadcast(room: Room, payload: unknown, exceptId?: string): void {
    const text = JSON.stringify(payload);
    for (const m of room.members.values()) {
      if (m.id === exceptId || m.userName === '') continue;
      try {
        m.conn.sendText(text);
      } catch { /* ignore */ }
    }
  }

  private presenceView(room: Room): CollabMemberView[] {
    return [...room.members.values()]
      .filter((m) => m.userName !== '')
      .map((m) => ({
        id: m.id,
        userName: m.userName,
        color: m.color,
        role: m.role,
        panel: m.panel,
        cursor: m.cursor,
        allowFollow: m.allowFollow,
        followTarget: m.followTarget,
      }));
  }

  private broadcastPresence(room: Room): void {
    this.broadcast(room, { t: 'presence', members: this.presenceView(room) });
  }

  private removeMember(room: Room, memberId: string, reason: string): void {
    const member = room.members.get(memberId);
    if (!member) return;
    room.members.delete(memberId);
    for (const [sessionId, watch] of room.termWatches) {
      watch.watchers.delete(memberId);
      if (watch.watchers.size === 0) this.dropTermWatch(room, sessionId);
    }
    if (member.userName !== '') {
      this.ctx.audit.record(`collab/${member.userName}`, 'COLLAB_LEFT', 'collab-room', room.projectId, { reason });
      this.broadcastPresence(room);
    }
    try {
      member.conn.destroy();
    } catch { /* ignore */ }
  }

  private sweep(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const member of [...room.members.values()]) {
        if (now - member.lastActivity > PRESENCE_TIMEOUT_MS) {
          this.send(member, { t: 'error', code: 'PRESENCE_TIMEOUT', message: 'idle too long' });
          this.removeMember(room, member.id, 'presence-timeout');
        } else {
          try {
            member.conn.ping();
          } catch { /* ignore */ }
        }
      }
      // 空房间保留文档（MVP：进程内；重启丢失——与终端 session 同策略，已文档化）。
    }
  }

  // ---------------------------------------------------------- HTTP 路由 --
  getRooms(): Array<{ projectId: string; members: number; docChars: number }> {
    return [...this.rooms.values()].map((r) => ({
      projectId: r.projectId,
      members: [...r.members.values()].filter((m) => m.userName !== '').length,
      docChars: r.doc.length,
    }));
  }

  getDocText(projectId: string): { chars: number; text: string } {
    const room = this.rooms.get(roomKeyOf(projectId));
    const text = room ? room.doc.text() : '';
    return { chars: text.length, text };
  }
}

let service: CollabService | null = null;

/** 进程单例（测试每个文件起独立 server 进程，天然隔离）。 */
export function initCollabService(ctx: RouteContext, authConfig: ApiAuthConfig): CollabService {
  if (!service) {
    service = new CollabService(ctx, authConfig);
    service.start();
  }
  return service;
}

export function collabService(): CollabService | null {
  return service;
}

/**
 * WS upgrade 分发：返回 true 表示已接管（无论成功/拒绝），false 表示
 * 不是 /api/collab（调用方继续处理/404）。
 */
export function handleCollabUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (!service) return false;
  return service.handleUpgrade(req, socket, head);
}

export async function handleCollabRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
  if (!service) {
    ctx.json(res, 503, { error: 'collab service not initialized' });
    return true;
  }
  const role = ctx.callerRole ?? null;

  // GET /api/collab/rooms — viewer（中央门禁已按 requiredRoleFor 默认 viewer 放行）
  if (method === 'GET' && path === `${PREFIX}/rooms`) {
    ctx.json(res, 200, { rooms: service.getRooms() });
    return true;
  }

  // GET /api/collab/chat?projectId=&limit= — viewer
  if (method === 'GET' && path === `${PREFIX}/chat`) {
    const projectId = roomKeyOf(url.searchParams.get('projectId'));
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    try {
      const msgs = ctx.fdb.collabChat.recent(projectId, limit);
      ctx.json(res, 200, {
        messages: msgs.map((m) => ({ id: m.id, userName: m.userName, text: m.text, createdAt: m.createdAt })),
      });
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  // GET /api/collab/doc?projectId= — viewer
  if (method === 'GET' && path === `${PREFIX}/doc`) {
    const projectId = roomKeyOf(url.searchParams.get('projectId'));
    ctx.json(res, 200, service.getDocText(projectId));
    return true;
  }

  // POST /api/collab/chat — operator（中央门禁默认写操作 operator）
  if (method === 'POST' && path === `${PREFIX}/chat`) {
    if (!role || roleRank(role) < roleRank('operator')) {
      ctx.json(res, 403, { error: 'operator role required', code: 'RBAC_DENIED' });
      return true;
    }
    const body = await ctx.readBody(req);
    const projectId = roomKeyOf(body['projectId']);
    const userName = sanitizeIdent(body['user'], MAX_USER_NAME, 'anonymous');
    const text = sanitizeText(body['text'], MAX_CHAT_TEXT_CHARS);
    if (!text) {
      ctx.json(res, 400, { error: 'text is required' });
      return true;
    }
    try {
      const stored = ctx.fdb.collabChat.add(projectId, userName, text);
      ctx.audit.record('human', 'COLLAB_CHAT', 'collab-room', projectId, {
        msgId: stored.id,
        chars: text.length,
        via: 'http',
      });
      ctx.json(res, 201, {
        message: { id: stored.id, userName: stored.userName, text: stored.text, createdAt: stored.createdAt },
      });
    } catch (e) {
      ctx.json(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  return false;
}
