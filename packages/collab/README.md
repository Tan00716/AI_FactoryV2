# @ai-factory/collab

实时协同 MVP 共享内核（第三波任务⑩）：RGA CRDT（纯文本协同编辑）+ WS 协议消息类型。
server 与 desktop 共用，保证两端语义一致（不各自手写一份，避免漂移）。零外部依赖。

## 双格式构建

本包是首个同时被 **Node（server）** 与 **浏览器（desktop/vite）** 消费的共享包：

- `tsc -p tsconfig.json` → `dist/src/**`（CommonJS，供 server 经 `main` 字段 require）
- `tsc -p tsconfig.esm.json` → `dist/esm/src/**`（ES2022，供 desktop 经 `exports.import` import）

`package.json` 的 `exports` 映射保证两端拿到对应格式；`types` 共用 `dist/src/*.d.ts`。
`npm run build -w @ai-factory/collab` 会构建两种格式，缺一不可——缺 ESM 会导致
桌面端白屏（vite dev 无法 import CJS 产物，见 2026-10-19 冒烟实录）。

## 诚实边界

- RGA 只处理纯文本；上限 `MAX_DOC_CHARS = 200_000` 字符，大文档性能未优化。
- RGA 保证最终一致，不保证操作意图保持（并发插入同位置时按 id 降序 tie-break）。
- 断线重连 = 重新同步快照，不是操作回放。
- 跟随模式是只读视图同步，不抢控制；需对方开启"允许被跟随"。
- 聊天每房间 500 条环形缓冲，持久化到 `collab_chat` 表；审计只记元数据。
