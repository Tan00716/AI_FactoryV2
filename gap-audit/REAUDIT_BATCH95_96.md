# Batch 95+96 联合独立复核（Batch 97-1）——偏差 0 处

复核对象：
- `541764f`（Batch 95：B94 独立复核 + 桌面全面板走查 + Terminal CORS 修复）
- `44ef111`（Batch 96：CORS 修复后回归 + AppImage 重打）

复核人不重跑全量测试；条目中数字为子任务/收口人声称。

## 1. 文件清单 vs CHANGELOG 描述——一致

- `541764f`：恰好 4 个文件（`CHANGELOG.md`、`apps/server/src/index.ts`、`apps/server/src/routes/terminal.ts`、`gap-audit/REAUDIT_BATCH94.md`），与 Batch 95 条目描述一致
- `44ef111`：恰好 1 个文件（`CHANGELOG.md`），与 Batch 96 条目描述一致
- 两 commit 均无 `.github`、无意外文件；工作树干净，仅剩既定的 `?? .github/` 未跟踪项

## 2. 抽点

- `gap-audit/REAUDIT_BATCH94.md` 在位（1817 bytes，首行"偏差 0 处"）
- CORS 修复 diff 抽查：
  - `apps/server/src/index.ts`：两处 `Access-Control-Allow-Methods` 确为 `'GET,POST,PUT,PATCH,DELETE,OPTIONS'`（`json()` + OPTIONS 处理器）
  - `apps/server/src/routes/terminal.ts`：SSE 流 `writeHead` 确加了 `'Access-Control-Allow-Origin': '*'`
- "27/27 渲染、25 PASS"（B95 走查）记录为**子任务声称**（复核人不重跑 Electron 走查）
- "500/500"（B96 回归）记录为**子任务声称**（复核人不重跑全量测试）
- "真 server 验证"（preflight 新方法列表、SSE 头在位、DELETE 200）记录为**收口人/子任务声称**
- REAUDIT 链连续：1–10 + 21–94 既有，本轮补上 95 + 96，无断号

## 3. 偏差计数：0 处

## 卫生注记

- 全程未 `git stash`、未 commit、未碰 `.github/`（仍是未跟踪原样）
- 未跑全量测试
