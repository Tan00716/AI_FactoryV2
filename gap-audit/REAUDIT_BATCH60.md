# REAUDIT_BATCH60 — Batch 60 独立复核（偏差 0 处）

- 基线：`d566e5a`（Batch 60 收口 commit，本地，未推送）
- 复核人：Batch 61-1
- 方式：隔离 worktree（detached HEAD `d566e5a`，`node_modules` + `apps/server/dist` + `packages/*/dist` 软链自主树，亲读 + 亲跑；主树零干扰；复核后 worktree 已删）

## (a) 启动竞态 + PORT 透传修复 —— 成立

逐行亲读 `git diff dfc1e3d d566e5a -- apps/desktop/src apps/desktop/electron`：

**Bug 1 — 启动竞态（`apps/desktop/src/App.tsx`，+20/−4）**
- `useEffect`：`bootError` 非空时每 2 秒 `void refresh()`；`refresh` 成功路径内部 `setBootError('')`，error 清除后 effect 自动 `clearInterval`。竞态窗口只会闪一下红横幅，不会永久 Offline。
- `bootError` 文案里的硬编码 `http://localhost:3100` 改成解析后的 `API_BASE`（`const API_BASE = defaultApiBase()`，模块作用域，浏览器上下文安全）。

**Bug 2 — PORT 透传（`api.ts` + `electron/main.ts` + 20 个面板）**
- `api.ts` 新增 `defaultApiBase()`：读 `window.location.search` 的 `apiPort`，纯数字正则 `/^\d+$/` 才认 → `http://localhost:<port>/api`；解析一次缓存；`window` 不存在/异常 → 回退 `http://localhost:3100/api`。
- `electron/main.ts`：`API_PORT = Number(process.env.PORT ?? 3100)`，后端 spawn 时 `env: { ..., PORT: String(API_PORT) }`；dev 用 `loadURL('http://localhost:${UI_PORT}?apiPort=${API_PORT}')`，打包用 `loadFile(renderer/index.html, { query: { apiPort: String(API_PORT) } })`。链条闭环：后端真实端口 == 注入值。
- 20 个面板文件（Approvals/Qa/Cicd/Skills/Memory/Workforce/Mcp/Knowledge/Evaluation/Terminal/Editor/DiffViewer/Changes/NotificationsBell/Dashboard/Activity/Events/Models/Stability/Orchestrate）+ App.tsx：**全部是机械替换**——`import { defaultApiBase, authHeaders } from '../api'` + 默认参数 `'http://localhost:3100/api'` → `defaultApiBase()`。过滤 diff 后的非平凡行只有 main.ts/App.tsx/api.ts 的预期改动，无逻辑掺杂。
- 桌面 src 内**零残留**硬编码 3100（只剩 api.ts 里有意的 fallback 字面量）；`grep -rln defaultApiBase apps/desktop/src/` = 22 个文件（api.ts 本体 + App.tsx + 20 面板）。

**亲验**：`npx tsc -p apps/desktop/tsconfig.json` → 0 错误；`npx tsc -p apps/desktop/tsconfig.electron.json` → 0 错误（隔离 worktree @d566e5a）。

## (b) QA failure-path leg 测试 —— 成立

- `apps/server/tests/first-run-walkthrough-qa-failure.test.ts` 在位（11269 bytes，`git show` 确认已提交）。
- 亲跑：**3/3 × 3 轮**，0 fail（隔离 worktree，真 server 进程，TMPDIR 指向普通文件之下的确定性 ENOTDIR 触发）。

## (c) 走查文档总览 —— 成立

- `# Walkthrough index (Batch 60)` 表头在位；数据行 = **20 行**（v1–v8 8 行 + 12 个 legs，逐行数过；60-3 报告写"19 行"是它自己编辑时的中间数，60-2 随后追加了 QA failure-path leg 行 → 20，KL 同步为"20 行"，一致，非偏差）。
- Findings index：`| F1` … `| F49` 共 **49 行**，序号连续无断号（F49 逐字亲读在位）。
- `docs/KNOWN_LIMITATIONS.md` 第 68 行：'Walkthrough index 20 行 … Findings index（F1–F49，closed/open/hygiene 三态）'——前瞻性口径一致。

## (d) commit 文件清单 —— 成立

`git show --name-only d566e5a`：**恰好 31 个文件**——CHANGELOG.md、electron/main.ts、App.tsx、api.ts、20 个面板组件、qa-failure 测试文件、2 个 docs、REAUDIT_BATCH59.md、3 张 b60-4 PNG。无意外文件，零服务端产品代码改动（qa.ts 未动）。

## 真实验证数字（隔离 worktree @d566e5a）

- 服务端全套：**469/469**，0 fail（466 → 469 算术吻合：Batch 60 新增 QA failure-path leg 3 条）
- QA failure-path leg：3/3 × 3 轮
- desktop tsc：0 错误；electron tsc：0 错误

## 卫生注记（非偏差）

1. `/tmp` 512MB tmpfs：两次 worktree 全套亲跑中途 ENOSPC（第一次 468/1、第二次 194 失败级联）——清理测试残留目录后重跑 469/469。`/tmp` 满导致的失败是环境事故，不是产品回归。重 IO 测试一律避开 `/tmp`（Batch 57-4 同款教训）。
2. 复核中途运行时清空了整个 `/tmp`（worktree 丢失，注册残留 prunable）：`git worktree prune` 后在 `$HOME/reaudit-b60` 重建，复核后已删。主树零干扰。
3. 60-3 报告的"index 19 行"是它编辑时的中间值，60-2 的 QA leg 行追加后为 20 行；KL 已同步为 20 行。前瞻性口径无滞后。

**偏差：0 处。**
