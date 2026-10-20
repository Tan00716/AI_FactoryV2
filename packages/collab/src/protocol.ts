/**
 * 协同通道 WS 协议消息类型 — 第三波任务⑩（server/desktop 共用）。
 *
 * 全部为 JSON 文本帧。字段均为宽进严出校验（见 routes/collab.ts）。
 */
import type { RgaOp } from './rga';

/** 客户端 → 服务端 */
export type CollabClientMsg =
  | { t: 'hello'; user?: string; color?: string; panel?: string }
  | { t: 'heartbeat' }
  | { t: 'presence'; panel?: string; cursor?: { line: number; col: number } | null; allowFollow?: boolean; color?: string }
  | { t: 'op'; ops: RgaOp[] }
  | { t: 'chat'; text: string }
  | { t: 'watchTerm'; sessionId: string }
  | { t: 'unwatchTerm'; sessionId: string }
  | { t: 'follow'; target: string | null };

export interface CollabMemberView {
  id: string;
  userName: string;
  color: string;
  role: string;
  panel: string;
  cursor: { line: number; col: number } | null;
  allowFollow: boolean;
  followTarget: string | null;
}

export interface CollabChatView {
  id: string;
  userName: string;
  text: string;
  createdAt: number;
}

/** 服务端 → 客户端 */
export type CollabServerMsg =
  | { t: 'welcome'; memberId: string; snapshot: RgaOp[]; chat: CollabChatView[]; presence: CollabMemberView[]; termSessions: Array<{ id: string; principal: string }> }
  | { t: 'presence'; members: CollabMemberView[] }
  | { t: 'ops'; from: string; ops: RgaOp[] }
  | { t: 'chat'; msg: CollabChatView }
  | { t: 'termOut'; sessionId: string; b64: string }
  | { t: 'termClosed'; sessionId: string }
  | { t: 'termWatching'; sessionId: string; stopped?: boolean }
  | { t: 'error'; code: string; message: string };
