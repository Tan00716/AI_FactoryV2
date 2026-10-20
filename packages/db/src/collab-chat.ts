/**
 * 协同聊天持久化 — 第三波任务⑩（实时协同 MVP）。
 *
 * collab_chat 表：(id, room_id, user_name, text, created_at)。
 * 每房间保留最近 MAX_PER_ROOM 条，插入时顺手裁剪（bounded）。
 * 内容在入库前已由调用方过 sanitizeUntrusted；审计只记元数据。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface CollabChatMessage {
  id: string;
  roomId: string;
  userName: string;
  text: string;
  createdAt: number;
}

/** 每房间保留上限（MVP 诚实边界：聊天记录是轻量环形缓冲，不是无限存档）。 */
export const MAX_CHAT_PER_ROOM = 500;
/** 单条消息上限（字符）。 */
export const MAX_CHAT_TEXT_CHARS = 2000;

export class SqliteCollabChatStore {
  constructor(private db: DatabaseSync) {}

  add(roomId: string, userName: string, text: string, now: number = Date.now()): CollabChatMessage {
    const msg: CollabChatMessage = {
      id: randomUUID(),
      roomId,
      userName,
      text,
      createdAt: now,
    };
    this.db
      .prepare('INSERT INTO collab_chat (id, room_id, user_name, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msg.id, msg.roomId, msg.userName, msg.text, msg.createdAt);
    // 裁剪：只保留最近 MAX_PER_ROOM 条
    this.db
      .prepare(
        `DELETE FROM collab_chat WHERE room_id = ? AND id NOT IN (
           SELECT id FROM collab_chat WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(roomId, roomId, MAX_CHAT_PER_ROOM);
    return msg;
  }

  /** 最近消息（按时间升序），limit 上限 200。 */
  recent(roomId: string, limit: number = 50): CollabChatMessage[] {
    const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    const rows = this.db
      .prepare('SELECT id, room_id, user_name, text, created_at FROM collab_chat WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(roomId, n) as Array<{ id: string; room_id: string; user_name: string; text: string; created_at: number }>;
    return rows.reverse().map((r) => ({
      id: r.id,
      roomId: r.room_id,
      userName: r.user_name,
      text: r.text,
      createdAt: r.created_at,
    }));
  }

  count(roomId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM collab_chat WHERE room_id = ?').get(roomId) as { n: number };
    return row.n;
  }
}
