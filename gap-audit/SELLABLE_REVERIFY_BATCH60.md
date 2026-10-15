# 可售清单第九轮全面复验（基线 `d566e5a`，Batch 60 收口，本地）

> 复验日期：2026-10-15。复验方式：`git rev-parse HEAD` 确认基线 `d566e5a`（"Batch 60: Batch59 独立复核 / QA 失败路径走查测试 / 走查总览补到 B59(F41–F48) / AppImage 交互走查 / 启动竞态+PORT 透传修复"）；工作树亲验干净（仅 `.github/` 未跟踪，与历轮一致）；
> 对第八轮（Batch 57，`76dbc78`）以来的全部新增交付物做文件存在性 + 内容亲读（grep 亲验关键断言与结论措辞）；
> QA failure-path 走查做独立抽点亲跑（`first-run-walkthrough-qa-failure.test.ts` → **3/3**，0 fail）；
> 全量测试数字引用 Batch 60 收口人主线亲验（兄弟任务在途时不重跑全套，避免混合口径），复核人此前各轮已亲跑验证。
> 零产品代码改动。未 commit。
> **特别说明**：2026-10-15 Tan 新指令——开发本地进行、先不上传 GitHub，完成后报告再问是否上架。所以本轮基线 `d566e5a` 是**本地 commit**，远端 main 仍为 `7e96bfe`（Batch 54；本次 `git ls-remote origin main` 亲验复核通过）。以下复验针对本地 `main`。

## 复验方式与基线

- HEAD：`d566e5a`（Batch 60）；链：`76dbc78`（Batch 57）→ `e2b32b5`（Batch 58）→ `dfc1e3d`（Batch 59）→ `d566e5a`（Batch 60），本地四连 commit 连续无断档；远端 main 仍 `7e96bfe`（ls-remote 亲验复核通过）。
- `CHANGELOG.md` 头部亲验：`## Batch 55` / `## Batch 56` / `## Batch 57` / `## Batch 58` / `## Batch 59` / `## Batch 60` 六节在位。
- 测试数字（引用 Batch 60 收口人主线亲验）：根 build 0 错误；`npm test` 2517/2517；服务端全套 **469/469**（466 → 469，Batch 60 +3 QA failure-path leg）；desktop tsc 0；electron tsconfig（main.ts）tsc 0；smoke:boot OK。
- 远端 main 亲验复核：`7e96bfe`（Batch 54）；Batch 55–60 本地累积未推送（Tan 2026-10-15 指令）。

## 翻绿项（相对第八轮，Batch 57 基线 76dbc78）

1. **ApprovalsPanel 整树崩溃根因修复 + 修复后真机走查闭环**（Batch 58-5 / Batch 59-2）：根因——面板自带的 `createApprovalsApi` 定义 camelCase `ApprovalItem` 零映射，服务端 `GET /api/approvals` 返回 20 个 snake_case 键的原生 `Approval`；`a.evidenceIds.length` 对 `undefined` 抛 TypeError + 无 error boundary → React 树卸载黑屏（58-2 亲验：黑屏 PNG `walkthrough-b58-2-approvals-crash.png` 在位）。修复：`RawApproval` 接口 + `toApprovalItem()` snake_case→camelCase 映射（`toApprovalItem` 在 `ApprovalsPanel.tsx` 出现 6 次，grep 亲验；全 5 路径 list/get/request/decide/cancel；`requiredApprover ← required_approvers.join(', ')`；status 补 `INVALIDATED`；`(a.evidenceIds ?? []).length` guards；`ApprovalsErrorBoundary` 同文件内）。真机走查闭环（59-2，3 张真 PNG 在位，`file` 亲验）：不再崩溃（字段逐项对上服务端原始 snake_case）、行级 busy（"处理中…" 三按钮 disabled）、approve→decided 完整回路（Pending 0 / History 1 / APPROVED）+ 真实审计事件流。**关键教训**：Batch 57-3 的"零 404 死按钮"只查了**端点存在性**，没查**响应形状兼容性**；`req<ApprovalItem[]>` 类型断言 tsc 拦不住——真机走查才抓得到。
2. **响应形状兼容性审计——桌面全部 38 面板**（Batch 59-3，产品代码改动 2 文件）：真实编译 server 播种真实数据（任务、HIGH 风险审批、memory、evidence），逐个探 20+ 个 GET 端点真实 JSON 键，再对 panel-local 类型断言逐项核对。**又找到 1 个真 bug，已修复**：QaPanel 整树崩溃（与 Approvals 同类）——QA run 失败时 server 写 `summary = { error: message }`，面板 `{run.summary && ...}` 守卫放行 `{error}` 对象，`run.summary.categories.map` 对 undefined 抛错 → 整树黑屏。**修两端**：服务端（`apps/server/src/routes/qa.ts`，grep 亲验在位：失败路径现在写 `total: 0, passed: 0, failed: 0, skipped: 0, categories: [], failures: [], error`）+ 面板（红色 pill + `?? []`）。其他 37 个面板亲验干净（抽查记录在位）。残留低风险诚实记录：`/api/projects` snake_case 裸行（`created_at` 等，桌面只读 id/name/description/path，F48 open-low）；EvaluationPanel 用 `any`（只渲染带 `?.` 标量，崩溃风险低）。desktop tsc 0、server tsc 0。
3. **QA failure-path leg 走查测试**（Batch 60-2，新文件 `apps/server/tests/first-run-walkthrough-qa-failure.test.ts`，A–C 3 条）：真实确定性环境故障——`TMPDIR` 指向普通文件之下 → `mkdir` 抛 `ENOTDIR` → auto-fix 步失败 → server 写归一化失败 summary。断言：失败 summary key 集 = 成功 key 集 + `'error'`；`Array.isArray(categories)`（面板 `categories.map` 的契约——正是修前崩溃点）；记录可经 `GET /api/qa/runs/:id` 取回；成功对照 auto-fix 生效 verdict PASS 无 `error` 键。**复核人独立抽点亲跑：3/3，0 fail**。F49（hygiene：`NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` 必须从测试启动的 server 环境中删掉，生产本来就没有）。
4. **AppImage 打包产物主窗口真实截图 + 交互走查**（Batch 58-3 / Batch 60-4，4 张真 PNG，`file` 亲验在位）：58-3 主窗口首屏（CDP 亲验 renderer 是 built dist：`file:///…/app.asar/apps/desktop/renderer/index.html`，**不是 vite dev**——与之前截图的关键区别）；60-4 真实点击 3 个 tab（Dashboard 真实指标卡 + AI Activity 真实审计事件流；NeedsHuman tab 诚实空态；Ops tab 「拉取全链验证」→ 「✅ 链完整：已验证 23 条」，打包产物 spawn 的后端真实 verify 结果）。**交互走查抓到 2 个真 bug**：(1) 启动竞态 → 永久误报 "Cannot reach the local API"——打包 app 主进程 spawn 后端与创建窗口并发，renderer 挂载时后端还没 listen；`App.tsx` 的 `refresh()` 只在 mount 跑一次（无 retry），`api.health()` 抛 "Failed to fetch" 后 `setBootError` + "Offline" 红点永远不清（后续所有端点都 200、各面板正常加载数据，红横幅仍在）。(2) PORT ≠ 3100 时 renderer 永远连不上后端——renderer 全应用硬编码 `http://localhost:3100/api`，main.ts 只把 PORT 透传给 spawn 的后端；57-4 验了"PORT 透传给后端"但 renderer 侧从没人验——blind spot。
5. **启动竞态 + PORT 透传修复**（Batch 60-5，产品代码改动 23 文件，零服务端改动）：Bug 1——`App.tsx` 加 effect：`bootError` 非空时每 2 秒重跑 `refresh()`，成功后 `setBootError('')` 自动清理（grep 亲验 `bootError` 引用 5 处、注释里有 "misreport" 字样）；Bug 2——`api.ts` 新增 `defaultApiBase()`：优先读 `window.location.search` 的 `apiPort` 查询参数（纯数字才认），回退 `localhost:3100`（grep 亲验导出在位）；`electron/main.ts`：dev 用 `loadURL(?apiPort=)`、打包用 `loadFile(..., {query: {apiPort}})`（grep 亲验 `apiPort` 3 处）；20 个面板 + App.tsx 全部硬编码 3100 改成 `defaultApiBase()`。验证：desktop tsc 0、electron tsconfig tsc 0；PORT=32111 真实亲验（`defaultApiBase()` → `localhost:32111/api`，`/api/health` → 200；fallback 三 case 正确回退）。
6. **走查文档总览索引补齐 + Findings F41–F49**（Batch 59-4 / 60-3，只改文档）：Walkthrough index 20 行数据行（v1–v8 共 8 行 + 12 个 legs：redaction / §81 sweep / escalation / audit-chain / verify endpoint / audit-chain verify / audit-chain watch / usability-fix screenshot / AppImage main-window / ApprovalsPanel response-shape fix / response-shape compatibility audit / QA failure-path；逐行数过，20 行，见卫生注记）+ Findings index F1–F49（49 行，F49 grep 亲验在位，序号连续无断号）；KNOWN_LIMITATIONS 第 68 行已同步（"Walkthrough index 20 行……Findings index（F1–F49…）"，亲读）。新增 F41–F48：F41 High/closed（Approvals 整树崩溃根因 + B57-3 审计盲区）；F42 hygiene（打包 renderer 截图区分）；F43 Info/closed（59-2 走查闭环）；F44 High/closed（QaPanel 同类崩溃，两端修复）；F45 hygiene（/tmp 512MB tmpfs）；F46 hygiene（无 FUSE）；F47 hygiene（SIGKILL 主进程 backend 子进程 reparent）；F48 Low/**open**（`/api/projects` snake_case 裸行，桌面只读子集——今天安全，将来写 `project.createdAt` 会静默 undefined）。
7. **许可证/定价备料**（Batch 59-4，零仓库代码改动）：`~/workspace/goals/ai-factory-app-prototype/files/LICENSE_AND_PRICING_BRIEF.md`（8KB，`ls` 亲验在位）——MIT vs Apache-2.0 对比（只给推荐，不做决定）、定价/渠道待决策清单、代码签名现状（Windows 需 Tan 采购 EV 证书、macOS 需 Apple Developer 会员 + notarization、Linux 无强制要求）；Windows workflow 草稿对齐（4 处修正：Node 22→24、`dist:win` 加 `--publish never`、mac target 已存在、推送路径被 Tan 指令锁住）。仓库仍是**刻意无 LICENSE**（`ls LICENSE` 亲验不存在），无任何决定被替 Tan 做。
8. **独立复核**：`REAUDIT_BATCH57.md` / `REAUDIT_BATCH58.md` / `REAUDIT_BATCH59.md` 在位（逐轮亲读结论：**偏差 0 处**；59-1 附带发现：服务端归一化还保护了 `TaskDetail.tsx:277` 的第二个崩溃点——只修面板端不够）；**REAUDIT_BATCH21–59 连续无断档**（`ls` 按编号排序亲验，21–59 全在位）。

## 新增真实缺口

**1 项真实新缺口（F48，Low/open）**：`/api/projects` 返回 snake_case 裸行（`created_at` 等），桌面 `Project` 接口只读 `id/name/description/path`——今天安全，但这是 F41 同类问题的一个未封闭余项：将来若有人写 `project.createdAt` 会静默 `undefined`。建议：要么把 `Project` 接口补上 `createdAt`（snake_case 对齐），要么加 tripwire 测试钉住"桌面只读这四个字段"。其余 F41–F47、F49 均为 hygiene 或已关闭。

## A/B/C/D verdict

- **A 真实可用**：
  - [ ] 真实模型端到端回路：仍 BLOCKED——Codex device login 仍需 Tan 本人执行（2026-10-12 推迟至今无变化；走查仍用 StubAdapter）。**非 Codex 模型适配器仍 stub**（`packages/runtime/src/adapters.ts` 的 StubAdapter grep 亲验仍在）。
  - [ ] 桌面应用可分发：Linux AppImage 本轮实质性硬化——125MB 重新打出 + boot 到主窗口 + **打包产物（built dist）真机交互走查**（Dashboard/NeedsHuman/Ops 三个 tab 真实点击 + 「拉取全链验证」真实渲染 "✅ 链完整：已验证 23 条"）+ 启动竞态/PORT 透传两个真 bug 修复。但 **Windows/macOS 安装包仍未验证**（Batch 57 打包复验 + 本轮交互走查均为 Linux；无 FUSE 环境连 `.AppImage` 本体都没执行过；mac target 虽在 `electron-builder.yml`，但从未在 macOS 机器实测或签名）。
  - [ ] 首次运行体验：走查继续累积（index 20 行：v1–v8 + 12 legs；Findings F1–F49）——**但仍只覆盖 API 层**，桌面走查是 CDP 驱动的点击/截图（dev 模式 vite renderer；打包产物是 built dist），**不是真人点击验收**；也不是 AppImage 双击体验（无 FUSE）。
  - [x] 关键数据可持久：本轮无变化（§48.2 实体集合落库结论不变）。
- **B 规格完整度**：
  - [x] Batch 1–7、Batch 8–23 关闭项无回退迹象（本轮未动该层）。
  - [ ] 剩余缺口：**13 项硬阻塞亲验全部仍在 Tan/环境侧，一项没动**——
    1. Codex 登录→真实模型 turn（需 Tan 本人，无变化）；
    2. 非 Codex 模型适配器仍 stub（StubAdapter grep 亲验仍在）；
    3. Windows/macOS 安装包+代码签名（本轮只验证了 Linux；Windows/macOS 安装包未构建；三平台签名零配置，证书待 Tan 采购）；
    4. 桌面真人点击验收（本轮是 CDP 驱动交互，不是真人点击；Batch 57 的'好用'审计是代码审计，诚实边界仍在）；
    5. 许可证/定价/渠道待 Tan 拍板（备料完成：LICENSE_AND_PRICING_BRIEF.md；仓库刻意无 LICENSE）；
    6. CI workflow scope（`.github/` 亲验仍本地未跟踪 `??`；GitHub CI 从未运行）；
    7. MCP SSE/HTTP/OAuth（routes 目录 grep 亲验：无 sse/oauth 路由文件）；
    8. 无真实隔离 Host；
    9. 生产 attestation 签名待 Tan 密钥决策；
    10. Windows 工具探测未真机验证；
    11. 远程数据库驱动 / merge queue 多机 M2（待 Tan 拍板；M1 单写者开关在位，无变化）；
    12. 无测试生产环境；
    13. AT-001–AT-064 正式验收（275 条资产不存在，仍 NOT_RUN）。
    **6 项代码侧刻意不做**无动摇证据（Board v1、`db.query` DENY、`mcp.call` definition-only、启动 reconcile 只报告、F20、env-error HTTP 阳性路径不伪造——本轮 QA failure-path 用的是**真实环境故障**，不是伪造的 HTTP 阳性路径，立场一致）。
  - [x] 每批口径不变：实现 → 单测 → 全量复验（build 0 / 全量测试 / demos）→ 本地提交（主线稳定树亲验数字）。
- **C 质量与可信**：
  - [x] 全量测试持续全绿（本轮主线亲验：构建 0 错误；包套件 2517/2517；服务端全套 **469/469**（Batch 60 +3 QA failure-path leg）；desktop tsc 0；electron tsconfig tsc 0；smoke:boot OK；复核人独立抽点亲跑 QA failure-path leg 3/3，0 fail）。注意：QA failure-path 测试 3/3×3 的"连续 3 轮"是收口人数字，复核人只抽点亲跑了 1 轮 3/3——数字不放大口径。
  - [x] README/文档与实现一致：走查文档总览（20 行 + Findings F1–F49，亲验）；KNOWN_LIMITATIONS 第 68 行同步（亲读）；CHANGELOG Batch 55–60 六节在位（亲验）。
  - [x] 独立复核：REAUDIT_BATCH21–59 连续无断档，Batch 57/58/59 逐轮 0 偏差（逐轮亲读结论）；Batch 30/GAP_SWEEP_BATCH30、Batch 49/GAP_SWEEP_BATCH49 扫荡报告在位。
- **D 商业化最小要件**：
  - [x] 版本号与发布说明（CHANGELOG）：版本 0.1.0；Batch 55–60 小节已补（亲验）。
  - [ ] 许可证与第三方声明：备料完成（`docs/release/LICENSING_OPTIONS.md` + 新的 LICENSE_AND_PRICING_BRIEF.md）；仓库**刻意无 LICENSE 文件**（默认保留所有权利，拍板前锁住）；**待 Tan 拍板**。
  - [ ] 定价/分发渠道：**待 Tan 拍板**（助手只备料）。

## 卫生注记（非偏差）

1. Batch 60-3 报告写 "Walkthrough index 19 行（v1–v8 8 行 + 11 legs）"——复核人逐行数过，实际**20 行数据行**（v1–v8 8 行 + **12 个 legs**：报告漏数了 "verify endpoint (operator)" 或 "§81 full-trigger sweep" 其中一行）。KNOWN_LIMITATIONS 第 68 行写的 "20 行" 是正确的。标注 slip，不影响任何验证结论。
2. QA failure-path leg 的 "3/3 连续 3 轮" 是收口人主线数字；复核人独立抽点只跑了 1 轮（3/3）。引用时已注明，不放大口径。
3. 58-2 的黑屏 PNG（`walkthrough-b58-2-approvals-crash.png`）是**真实故障证据**，不是走查失败——它抓住了 bug，现在留在 repo 里当回归证据，这个做法是对的。

## 总结论

**仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 相对第八轮翻绿 8 项（Approvals 整树崩溃修复 + 真机走查闭环 / 响应形状兼容性审计 38 面板 + QaPanel 同类崩溃修复 / QA failure-path leg 走查 3/3（复核人抽点亲跑）/ AppImage 打包产物真机交互走查 + 2 个真 bug（启动竞态/PORT 透传）修复 / 走查总览 20 行 + Findings F1–F49 / 许可证-定价备料 / REAUDIT_BATCH21–59 连续无断档）；新增真实缺口 1 项（**F48 Low/open**：`/api/projects` snake_case 裸行，桌面只读子集，将来写 `project.createdAt` 会静默 undefined）。桌面真机 PNG 累计 **17 张**在位。13 项硬门槛亲验全部仍在 Tan/环境侧，一项没动——真实模型回路（Codex 登录）、三平台分发+代码签名、许可证/定价/渠道——这些决定"卖"的硬门槛，一项没动，全部需要 Tan 本人动作或外部环境；代码侧已无可代劳的路径。**补充**：本轮基线是本地 commit（`d566e5a`），按 Tan 2026-10-15 指令先不推送 GitHub；远端 main 仍为 `7e96bfe`（ls-remote 亲验复核通过）。
