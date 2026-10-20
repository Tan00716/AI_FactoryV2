/**
 * @ai-factory/collab — 实时协同 MVP 共享内核（第三波任务⑩）。
 *
 * RGA CRDT（纯文本协同编辑）+ WS 协议消息类型，server 与 desktop 共用，
 * 保证两端语义一致（不各自手写一份，避免漂移）。零外部依赖。
 */
export * from './rga';
export * from './protocol';
