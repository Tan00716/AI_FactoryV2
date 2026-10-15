# 可售清单第十轮全面复验（基线 `b445896`，Batch 64 收口，本地）

> 复验日期：2026-10-15。复验方式：`git rev-parse HEAD` 确认基线 `b445896`（"Batch 64: Batch63 独立复核 / G10 INV-28 §45.4 自动治理 / G1-G5 小缺口三件套 / G11-G7-G3-G4 数据外发与关联缺口"）；工作树亲验（`M CHANGELOG.md` 是 Batch 64 收口后追加的 1 行算术口径措辞修正（复验人亲读 diff 确认），`?? .github/` 未跟踪，与历轮一致）；
> 对第九轮（Batch 61，`2bb5dfb`，基线 `d566e5a`）以来的全部新增交付物做文件存在性 + 内容亲读（grep 亲验关键符号与结论措辞）；
> G8 exec-confinement leg 做独立抽点亲跑（`first-run-walkthrough-exec-confinement.test.ts` → **3/3**，0 fail，真实编译 server，$HOME 临时目录）；
> 全量测试数字引用 Batch 64 收口人主线亲验（兄弟任务在途时不重跑全套，避免混合口径），复核人此前各轮已亲跑验证。
> 零产品代码改动。未 commit。
> **特别说明**：Tan 2026-10-15 指令——开发本地进行、先不上传 GitHub，完成后报告再问是否上架。所以本轮基线 `b445896` 是**本地 commit**，远端 main 仍为 `7e96bfe`（Batch 54；本次 `git ls-remote origin main` 亲验复核通过）。以下复验针对本地 `main`。

## 复验方式与基线

- HEAD：`b445896`（Batch 64）；链：`d566e5a`（Batch 60）→ `2bb5dfb`（Batch 61）→ `0f27c30`（Batch 62）→ `8459647`（Batch 63）→ `b445896`（Batch 64），本地五连 commit 连续无断档；远端 main 仍 `7e96bfe`（ls-remote 亲验复核通过）。
- `CHANGELOG.md` 头部亲验：`## Batch 61` / `## Batch 62` / `## Batch 63` / `## Batch 64` 四节在位。
- 测试数字（引用 Batch 64 收口人主线亲验）：根 build 0 错误；`npm test` **2563/2563**（基线 2520 + 43：evaluation 22 + runtime 5 + cicd 7 + core 4 + qa 5；算术亲验吻合）；服务端全套 **483/483**（基线 474 + 9：G1 5 + G2 2 + G5 1 + G10 walkthrough 1；算术亲验吻合）；desktop tsc 0；electron tsconfig tsc 0；smoke:boot OK。
- 远端 main 亲验复核：`7e96bfe`（Batch 54）；Batch 55–64 本地累积未推送（Tan 2026-10-15 指令）。

## 翻绿项（相对第九轮，Batch 61–64）

1. **打包产物完整 Electron 走查**（Batch 61-2，3 张真 PNG 在位，`file` 亲验）：`NODE_ENV=production` Electron（main.ts 打包路径：`loadFile` + 后端 spawn），renderer 用编译产物（临时软链走查后已删）；(a) PORT=32111 — `apiPort` 经 `loadFile(..., { query: { apiPort } })` 注入成功，页面 URL `…/index.html?apiPort=32111`，`defaultApiBase()` → `http://localhost:32111/api`，完整 dashboard 渲染，无 "Cannot reach" 横幅、无 Offline；(b) 启动竞态模拟（kill backend + reload）→ 红色横幅写的是解析后的 API_BASE（`http://localhost:32111/api`）+ ● Offline；重启后端 → 横幅消失、● Running 恢复（2 秒重试生效）。**60-5 的两个修复在真实打包路径全部验证通过**（F50 关闭）。
2. **桌面剩余交互盲区走查**（Batch 61-4，4 张真 PNG 在位）：Electron+Xvfb+vite dev+真实 server，真实 `executeJavaScript` handler + 截图：Board 拖拽（IN PROGRESS→CODE REVIEW，合成 HTML5 drag 走 React 真实 `onDragStart`/`onDrop`）→ 门禁 toast "⛔ 门禁拒绝（缺证据）" + 真实 `WORKFLOW_TRANSITION_DENIED`（服务端 422 `GATE_DENIED` 先用 curl 亲验，UI 与服务端一致）；真实 QA run（默认 unit 分类）→ verdict PASS，attempts=3（attempt 1 `PRODUCT_FAILURE` → auto-fix → 2/3 通过），红色 pill 未出现；Approvals 回归（真实 HIGH 审批）→ 面板正常渲染，无崩溃（F51 关闭）。**桌面真机 PNG 证据累计 24 张**（Batch 60 记 17 张 + Batch 61 新增 7 张）。
3. **F48 闭环**（Batch 62，产品代码改动 1 文件：`apps/desktop/src/api.ts`，grep 亲验 `toProject` 4 处在位；零服务端改动）：新增 `RawProject` 接口（文档化服务端完整 snake_case 原生形状，注释写明"§6.1 原生契约，正确设计，不做服务端改名"）；`Project` 接口扩展为显式 camelCase 契约（`status: 'active'|'archived'`，`createdAt`/`updatedAt`，注释说明 F48 闭环 + 引用 F41 教训）；`toProject()` 映射（status 非 'archived' 回退 'active'；`created_at`/`updated_at` 非 string 回退 `''`）；`projects()` 经同一归一化点。**第九轮的新增真实缺口 F48（Low/open）→ closed**。残留诚实记录：EvaluationPanel 的 `any`、其他 snake_case 残留不在本次范围。
4. **SPEC_V2 INV 覆盖扫荡**（Batch 62，`gap-audit/INV_COVERAGE_SWEEP.md` 新建，19494 bytes，`ls` 亲验在位；零产品代码改动）：结论 **24/35 invariants 被测试/走查钉死，11 条真实缺口（G1–G11）**；口径诚实（"测试/走查钉死才算覆盖，有代码没测试=未覆盖"）；G9/G10 的声称经复核人抽点亲验成立（runner.ts:132-133 的 `adapter.invoke` 确实直接发送；loop.ts:268 确实注释级承诺，未冒充实现）。
5. **G9 / INV-26 闭环——预发送 prompt 密钥扫描接入**（Batch 63，产品代码改动 2 文件：`packages/runtime/src/runner.ts`（grep 亲验 `scanForSecrets` 2 处在位）、`packages/runtime/package.json`；新建 `packages/runtime/tests/runner-secret-scan.test.ts` 5208 bytes）：`defaultStepFn` 的 ACT 阶段、`consumeModelCall()` 之前、`adapter.invoke` 之前，用 `scanForSecrets(prompt)` 扫描组装好的 prompt；检出 → fail-closed 返回 `{ ok: false, errorSignature: 'adapter:secret-in-prompt' }`，adapter 完全不被调用、model-call 预算不消耗；确定性重试清不掉签名 → stagnation 路径 3 次同签名后 `LoopStagnation` 升级；错误文本只带签名和 spec 引用（`[adapter:secret-in-prompt] (§46.2/INV-26)`），不回显密钥值。runtime 包全套 176/176（174+2，3 轮全绿）。诚实边界（报告如实）：run trace 仍逐字记录用户自己的 task 文本（全链路脱敏需单独立项）；Git commit 路径的密钥扫描不在本次范围。
6. **G8 / INV-15 闭环——`/api/exec` 的 `CONFINEMENT_UNAVAILABLE` 拒绝钉住**（Batch 63，新建 `apps/server/tests/first-run-walkthrough-exec-confinement.test.ts` 7902 bytes，A–C 3 条；零产品代码改动）：A actor='agent' + 合法命令 → 403 `CONFINEMENT_UNAVAILABLE` + `EXEC_DENIED` 审计 + 零 `EXEC_RUN`；B actor='human' + 同一命令 → 200 ok:true；C actor='agent' + `rm -rf /`（deny-pattern）→ 仍是 `CONFINEMENT_UNAVAILABLE` 而非 POLICY_DENIED——钉死 fail-closed 顺序（confinement 检查先于策略检查）。**复核人独立抽点亲跑：3/3，0 fail**（真实编译 server，$HOME 临时目录，16.7s）。诚实边界（测试文件头注释在位）：钉住的是拒绝，不是真实 OS 隔离（`UnverifiedBackend.verifyConfinement()` 恒返回 `verified:false`；已知硬门槛"无通用真实隔离 Host"）。
7. **G6 / INV-10 闭环——RunManifest 版本 pin 字段**（Batch 63，产品代码改动 4 文件：`packages/db/src/run-manifests.ts`（grep 亲验 `RunManifestVersionPins` 5 处在位）、`schema.ts`、`db.ts`、`apps/server/src/routes/runtime.ts`；2 个测试文件）：run 创建时记录 `employee_version` / `organization_version` / `policy_version` / `requirement_version`（POST /runs 和 resume 两个创建点）；`NULL_VERSION_PINS`（null = 未记录绝不虚构）；`migrateRunManifestsTable` 原地迁移 pre-pin 行。测试 +3（db 1 + server 2），npm test 2517→2520 算术吻合。
8. **G10 / INV-28 闭环——§45.4 自动治理**（Batch 64，新建 `packages/evaluation/src/auto-governance.ts` 9101 bytes；改 `loop.ts`/`index.ts`/`apps/server/src/routes/evaluation.ts`；新建 3 测试文件）：`evaluateAutoGovern(input)` 纯策略函数（确定性阈值文档+测试钉死：≥1 失败观察或独立评估失败 → `disable-version`；尾部 ≥2 连续失败或独立评估失败 → `downgrade-autonomy`；被禁用版本 + 有已批准未禁用 fallback + 未在 fallback 上 → `switch-to-fallback`；幂等）；硬负约束（决策类型只有 3 种变体，无授权变体；高分输入 → 零决策）；`VersionRegistry`（ACTIVE/DISABLED、`POLICY_APPROVAL` 批准标记、禁用保留效果记录）；`ImprovementLoop.autoGovern(caseId, {by})` 执行三项决策；observations 打 version 标签（测试抓到的真问题：迁移后旧版本失败观察不再用来禁用新版本）；advance 新增 `auto-govern` step，写 `AUTO_GOVERNANCE_APPLIED` 审计。测试：auto-governance.test.ts 16/16、auto-governance-loop.test.ts 6/6、first-run-walkthrough-auto-governance.test.ts 1/1×3（真实编译 server + 纯 HTTP）；evaluation 包全套 118/118×3。**loop.ts:268 的注释级承诺 → 真代码 + 22 条测试**。诚实边界（报告如实）：downgrade-autonomy 的决策发出并记录在 admission trail，但实际改 autonomy store 的执行是 autonomy 层的事（evaluation 包零依赖约定不跨包写）；观察阈值是文档化的工程选择，不是 spec 给的数字。
9. **G1/G2/G5 小缺口三件套**（Batch 64，3 个新测试文件在位，`ls` 亲验；零产品代码改动）：`board-drag-transition.test.ts`（5 条：只有 `POST /transition` 改变状态，裸 status/stage 写入 → 400，混写被忽略，非法 jump → 422 + `WORKFLOW_TRANSITION_DENIED`）；`git-merge-queue-broker-gate.test.ts`（2 条：broker deny → 403 `GIT_BROKER_DENIED` 零副作用；对照组 202 enqueue）；`product-authority-default.test.ts`（1 条含 A–D：提案 `WAITING_HUMAN_DISPATCH` 不静默授权；`via=POLICY` 无 Rule ID → 400；未授权 run → 403 `TASK_NOT_AUTHORIZED`；`via=HUMAN` dispatch → AUTHORIZED 后 run 才 202）。诚实边界如实（文件头注释）：build-runner 的 git 子进程是已 broker 授权的 merge 决策的下游 mechanics（double-gating 错误）；v1 transition 不查 §17.2 轴（改 v1 是产品决策，KNOWN_LIMITATIONS 在案）。
10. **G11 / INV-30 闭环——云模型调用建模为受控数据外发事件**（Batch 64，改 `packages/runtime/src/runner.ts`（grep 亲验 `dataExportEventFor` 2 处在位）；新建 `packages/runtime/tests/runner-data-export.test.ts` 6723 bytes）：`dataExportEventFor()` 纯函数；ACT 阶段在 secret 扫描之后、预算消耗之后、`adapter.invoke` 之前：非 local provider 记录显式 `data_export` evidence 事件（`event: 'DATA_EXPORT'` + provider/model/privacy/agentId/taskId）；local 豁免；provider 未知时 fail-safe 记为 'unknown'。测试 5/5。诚实边界（报告如实）：事件是 run evidence 级别的审计记录，不是 approvals 包的正式授权票（"预发送导出授权票"需接 approvals，单独立项）。
11. **G7 / INV-11 闭环——Release↔需求版本关联**（Batch 64，改 `packages/cicd/src/release.ts`（grep 亲验 `requirementRef` 12 处在位）；测试 +7）：`Release.requirementRef`（`'REQ-001@2'` 形式，创建时记录，缺省不捏造）；`checkReleaseEvidenceCompatibility()` 纯函数；deployRelease 新增 Gate 2b（release 有 pin 且 evidence pins 不一致、无兼容性声明 → fail-closed 拒绝 + 审计 `RELEASE_EVIDENCE_MISMATCH`；有显式声明 → 放行 + 审计 `RELEASE_COMPATIBILITY_DECLARED`）。release.test.ts 49/49。诚实边界（报告如实）：系统只记录与审计调用方的兼容性声明，不验证声明真实性。
12. **G3 / INV-07 闭环——发现→待派工票据路径**（Batch 64，改 `packages/core/src/tasks.ts`（grep 亲验 `reportFinding` 2 处在位）+ `types.ts`；测试 +4）：`TaskManager.reportFinding()` 固定入口（证据必填，空数组→抛错；建 TODO + `WAITING_HUMAN_DISPATCH`，永不直接 AUTHORIZED）。task-dispatch.test.ts 12/12。
13. **G4 / INV-08 闭环——专家创建/QA 自动的政策门**（Batch 64，改 `packages/qa/src/org.ts`（grep 亲验 `QaCreationGate` 3 处在位）+ `package.json`；测试 +5）：`ensureQaLead` / `createQaSpecialist` 新增可选 `QaCreationGate { policy: FactoryPolicy; estimatedBudget? }`；传 gate 时走 `@ai-factory/employee-factory` 的 `enforcePolicy`；拒绝 → 抛 `GovernanceError` 且零注册；不传 gate → 行为完全一致。org.test.ts 12/12。诚实边界（报告如实）：gate 是 opt-in；server 的 `qa.ts` 路由未传 policy（项目政策存储目前不存在），server 路径的自动创建仍无门；接线是后续项。
14. **扫荡清单状态**：**G1–G11 全部闭环**。35 条 invariants 现状：**35/35 都有测试或走查证据**（各缺口的诚实边界如实记录在案，见上）。这是相对第九轮"24/35 覆盖、11 条真实缺口"的最大翻绿。
15. **走查文档总览补到 Batch 61**（Batch 62，只改 2 个文档文件）：Walkthrough index **22 行数据行**（v1–v8 8 行 + 14 个 legs，复验人脚本亲验逐行数过；含 packaged full Electron walkthrough + desktop interaction walkthrough 两个新 legs）；Findings index **F1–F51**（51 行，序号连续无断号，脚本亲验）；KNOWN_LIMITATIONS 第 68 行同步。新增 F50–F51（Info/closed）。
16. **独立复核**：`REAUDIT_BATCH60.md` / `REAUDIT_BATCH61.md` / `REAUDIT_BATCH62.md` / `REAUDIT_BATCH63.md` 在位（逐轮亲读结论：**偏差 0 处**）；**REAUDIT_BATCH21–63 连续无断档**（`ls` 按编号排序亲验，21–63 全在位）。卫生注记：63-1 复核时隔离 worktree 首轮服务端全套 252/117 fail——缺编译产物（dist 被 gitignore）+ /tmp（512MB tmpfs）被失败轮次的 `factory-*-e2e-*` 临时 SQLite 目录塞满；清理后 474/474；环境侧问题。

## 新增真实缺口

**0 项**。第九轮的新增真实缺口 F48（Low/open）已于 Batch 62 闭环（见上第 3 项）。Batch 61–64 挖出的 F50–F51 均为 Info/closed（走查闭环）。扫荡报告的 G1–G11 在本轮全部闭环——没有新的未封闭余项冒出来。

## A/B/C/D verdict

- **A 真实可用**：
  - [ ] 真实模型端到端回路：仍 BLOCKED——Codex device login 仍需 Tan 本人执行（2026-10-12 推迟至今无变化；走查仍用 StubAdapter）。**非 Codex 模型适配器仍 stub**（`packages/runtime/src/adapters.ts` 的 `class StubAdapter` grep 亲验仍在）。
  - [ ] 桌面应用可分发：Linux 路径实质性硬化——125MB AppImage + boot 到主窗口 + **打包产物（built dist）真机交互走查**（60-4：Dashboard/NeedsHuman/Ops 三个 tab 真实点击 + 「拉取全链验证」真实渲染 "✅ 链完整：已验证 23 条"）+ **61-2 打包产物完整 Electron 走查**（PORT=32111 apiPort 注入 + 启动竞态重试闭环，3 张真 PNG）。但 **Windows/macOS 安装包仍未验证**（mac target 虽在 `electron-builder.yml`，从未在 macOS 机器实测或签名；无 FUSE 环境连 `.AppImage` 本体都没执行过）。
  - [ ] 首次运行体验：走查继续累积（index **22 行**：v1–v8 + 14 legs；Findings **F1–F51**）——**但仍只覆盖 API 层**，桌面走查是 CDP 驱动的点击/截图（dev 模式 vite renderer；61-2 是 packaged built dist），**不是真人点击验收**；也不是 AppImage 双击体验（无 FUSE）。**桌面真机 PNG 证据累计 24 张**（`ls gap-audit/*.png` 亲验）。
  - [x] 关键数据可持久：本轮无变化（§48.2 实体集合落库结论不变）。
- **B 规格完整度**：
  - [x] Batch 1–7、Batch 8–23 关闭项无回退迹象（本轮未动该层）。
  - [x] **SPEC_V2 35 条 invariants 全部有测试/走查证据**（相对第九轮 24/35 的最大翻绿；G1–G11 逐条见上；各诚实边界如实记录）。
  - [ ] 剩余缺口：**13 项硬阻塞亲验全部仍在 Tan/环境侧，一项没动**——
    1. Codex 登录→真实模型 turn（需 Tan 本人，无变化）；
    2. 非 Codex 模型适配器仍 stub（StubAdapter grep 亲验仍在）；
    3. Windows/macOS 安装包+代码签名（本轮只验证了 Linux；三平台签名零配置，证书待 Tan 采购）；
    4. 桌面真人点击验收（61-2/61-4 均为 CDP 驱动交互，不是真人点击；Batch 57 的'好用'审计是代码审计，诚实边界仍在）；
    5. 许可证/定价/渠道待 Tan 拍板（备料完成：LICENSE_AND_PRICING_BRIEF.md；仓库刻意无 LICENSE，`ls` 亲验不存在）；
    6. CI workflow scope（`.github/` 亲验仍本地未跟踪 `??`；GitHub CI 从未运行）；
    7. MCP SSE/HTTP/OAuth（routes 目录 grep 亲验：无 sse/oauth 路由文件）；
    8. 无真实隔离 Host（G8 的诚实边界：`verifyConfinement()` 恒 `verified:false`，是拒绝不是假装有 OS 边界）；
    9. 生产 attestation 签名待 Tan 密钥决策；
    10. Windows 工具探测未真机验证；
    11. 远程数据库驱动 / merge queue 多机 M2（待 Tan 拍板；M1 单写者开关在位，无变化）；
    12. 无测试生产环境；
    13. AT-001–AT-064 正式验收（275 条资产不存在，仍 NOT_RUN）。
    **6 项代码侧刻意不做**无动摇证据（Board v1、`db.query` DENY、`mcp.call` definition-only、启动 reconcile 只报告、F20、env-error HTTP 阳性路径不伪造——立场一致）。
  - [x] 每批口径不变：实现 → 单测 → 全量复验（build 0 / 全量测试 / demos）→ 本地提交（主线稳定树亲验数字）。
- **C 质量与可信**：
  - [x] 全量测试持续全绿（本轮主线亲验：构建 0 错误；包套件 **2563/2563**；服务端全套 **483/483**；desktop tsc 0；electron tsconfig tsc 0；smoke:boot OK；**复核人独立抽点亲跑 G8 exec-confinement leg 3/3，0 fail**（真实编译 server，$HOME 临时目录，16.7s））。注意：demo:e2e-v8（1/1×4）等 walkthrough legs 本轮未重跑——Batch 61–64 未动走查链路代码，全量套件 + 新 legs 的亲跑数字为本轮口径。
  - [x] README/文档与实现一致：走查文档总览（22 行 + Findings F1–F51，亲验）；KNOWN_LIMITATIONS 第 68 行同步（亲读）；CHANGELOG Batch 61–64 四节在位（亲验）。
  - [x] 独立复核：REAUDIT_BATCH21–63 连续无断档，Batch 60/61/62/63 逐轮 0 偏差（逐轮亲读结论）；Batch 30/GAP_SWEEP_BATCH30、Batch 49/GAP_SWEEP_BATCH49、Batch 62/INV_COVERAGE_SWEEP 扫荡报告在位。
- **D 商业化最小要件**：
  - [x] 版本号与发布说明（CHANGELOG）：版本 0.1.0；Batch 61–64 小节已补（亲验）。
  - [ ] 许可证与第三方声明：备料完成（`docs/release/LICENSING_OPTIONS.md` + LICENSE_AND_PRICING_BRIEF.md）；仓库**刻意无 LICENSE 文件**（默认保留所有权利，拍板前锁住）；**待 Tan 拍板**。
  - [ ] 定价/分发渠道：**待 Tan 拍板**（助手只备料）。

## 卫生注记（非偏差）

1. Batch 63 中途的工作树事故（63-4 在共享主树上跑 `git stash -u`，重演 Batch 39/43 铁律）：亲手恢复，逐文件和 stash 版本 diff 确认字节级一致（0 diff）；63-3 的文件按原内容重建，和 `stash@{0}^3` 的版本 SHA-256 字节级一致；`.github/workflows/ci.yml` 用 `git reset HEAD` 褪回未跟踪；stash 在验证后 drop。**零文件丢失，零数据损坏**。教训已钉进 AGENTS.md：此后每个 spawn brief 必须明写"共享工作树禁止 `git stash`，要看干净基线用隔离 worktree"。**本轮复验全程未运行 `git stash`**（兄弟 65-1 在途）。
2. 主树 `M CHANGELOG.md` 是 Batch 64 收口后追加的 1 行算术口径措辞修正（复验人亲读 diff 确认是同一行的措辞替换，无实质改动）；它是 parent 在途工作，复验人未碰。
3. 本机 `/dev/null` 缺失（mknod 被容器禁止，连 root 也不行）；64-4 建了一个普通空文件应急顶替让 git 能工作（会随写入累积，不会自动丢弃）。runtime 级别的容器问题，这边修不了，只能记录。
4. 9th round 的"连续 3 轮"数字（如 runtime 176/176×3、confinement 3/3×3 等）是各批收口人主线数字；复核人独立抽点只跑了 1 轮（本次 G8 leg 3/3）。引用时已注明，不放大口径。
5. demo:e2e-v8（1/1×4）、redaction leg（1/1×3）、§81 sweep（1/1×3）、escalation leg（1/1×3）、audit-chain legs（1/1×3）、watch leg（1/1×3）、QA failure-path leg（1/1×3）本轮未重跑——Batch 61–64 未动这些走查链路的代码（61-2/61-4 是新增 legs，属 desktop 走查；G8/G10 的新 legs 在各自批次亲跑过）。

## 总结论

**仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 相对第九轮翻绿 14 项（61-2 打包产物完整 Electron 走查 / 61-4 桌面剩余交互盲区走查（桌面真机 PNG 累计 24 张）/ F48 闭环（第九轮唯一新增缺口已关）/ SPEC_V2 INV 覆盖扫荡（24/35 → 35/35，G1–G11 全部闭环，这是本轮最大翻绿）/ G9 预发送 prompt 密钥扫描 / G8 exec-confinement 拒绝钉住（复核人独立抽点亲跑 3/3）/ G6 RunManifest 版本 pin / G10 §45.4 自动治理（注释级承诺 → 真代码 + 22 条测试）/ G1-G5 小缺口三件套 / G11 数据外发事件 / G7 Release↔需求版本关联 / G3 发现→待派工票据 / G4 QA 创建政策门 / REAUDIT_BATCH21–63 连续无断档）；**新增真实缺口 0 项**（F48 已关；F50–F51 均为 Info/closed）。13 项硬门槛亲验全部仍在 Tan/环境侧，一项没动——真实模型回路（Codex 登录）、三平台分发+代码签名、许可证/定价/渠道——这些决定"卖"的硬门槛，一项没动，全部需要 Tan 本人动作或外部环境；代码侧已无可代劳的路径。**补充**：本轮基线是本地 commit（`b445896`），按 Tan 2026-10-15 指令先不推送 GitHub；远端 main 仍为 `7e96bfe`（ls-remote 亲验复核通过）。
