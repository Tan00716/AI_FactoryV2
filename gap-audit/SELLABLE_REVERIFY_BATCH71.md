# 可售清单第十一轮全面复验（基线 `6618b36`，Batch 71 收口，本地）

> 复验日期：2026-10-15。复验方式：`git rev-parse HEAD` 确认基线 `6618b36`（"Batch 71: Batch70 独立复核 / SPEC_V2 §58 migration-map 合规检查（0 偏差）/ Windows 安装包可行性调研"）；工作树亲验（`git status` 干净，仅 `?? .github/` 未跟踪，与历轮一致）；
> 对第十轮（Batch 65，`SELLABLE_REVERIFY_BATCH64.md`，基线 `b445896`）以来全部新增交付物（Batch 66–71）做文件存在性 + 内容亲读；
> 全量测试数字为**本轮复验人在主线亲跑**（兄弟任务在途时未重跑全套——本次复验时主树干净，无兄弟在途改动，遂亲跑）；
> 零产品代码改动（本轮 Batch 71 只有 1 个文档文件改动，见下）。未 commit。
> **特别说明**：Tan 2026-10-15 指令——开发本地进行、先不上传 GitHub，完成后报告再问是否上架。所以本轮基线 `6618b36` 是**本地 commit**，远端 main 仍为 `7e96bfe`（Batch 54；远端确认沿用既定结论，本轮未重复跑 ls-remote）。

## 复验方式与基线

- HEAD：`6618b36`（Batch 71）；链：`b445896`（Batch 64）→ `cc169e5`（Batch 65，纯审计）→ `9aadfd5`（Batch 66）→ `b54d36c`（Batch 67）→ `c631974`（Batch 68）→ `5c9b8c4`（Batch 69）→ `45e34d5`（Batch 70）→ `6618b36`（Batch 71），本地七连 commit 连续无断档；远端 main 仍 `7e96bfe`（沿用既定结论，未重复跑 ls-remote）。
- 本轮亲跑数字（基线 `6618b36`，本地，主线亲验）：根 build **0** TS 错误；`npm test` **2567/2567**，0 fail；服务端全套 **490/490**，0 fail；desktop tsc 0；electron tsconfig tsc 0；`smoke:boot` OK（编译 server 启动，`GET /api/health` → 200）。
- 复核链：`REAUDIT_BATCH66.md`（5667 bytes）/ `REAUDIT_BATCH67.md`（3685 bytes）/ `REAUDIT_BATCH68.md`（3584 bytes）/ `REAUDIT_BATCH69.md`（2456 bytes）/ `REAUDIT_BATCH70.md`（3283 bytes）在位，各轮结论均为**偏差 0 处**；**REAUDIT_BATCH21–70 连续无断档**。

## 翻绿项（相对第十轮，Batch 66–71）

1. **`/api/profiles` 门禁真 bug 修复**（Batch 66）：服务端 `routes/evaluation.ts` 的 `inScope` 遗漏 `GET /api/profiles`（leaderboard）——服务端自己的契约没被自己的门禁放行；6 行服务端修复，零契约变更；回归测试 2/2×3。**Batch 67 独立复核确认**：文件头部文档第 7–8 行自己写着 `GET /api/profiles`，handler 也实现了两者，只有 `inScope` 遗漏——确认不是 58-5 式的桌面端映射场景。
2. **run trace 脱敏落地**（Batch 66）：`loop.ts` 的 `recordTrace` 和 `harness.ts` 的 `trace()` 两个 choke 点接入 `redactText`（bare-specifier，dual-mode 合规）；测试 4/4。残余边界如实（无 key 前缀的裸高熵字符串可能抓不到；adapter 路径 fail-closed 仍是硬保证）。
3. **项目政策存储 + QA 创建门接线**（Batch 66）：`FactoryPolicyStore` + `QA_CREATION_POLICY` + `qa.ts` 两个创建点传 gate（`GovernanceError → 403 {governance:true}`）；接线测试 5/5；修了一个 dual-mode 真回归（extensionless value import）。边界：默认策略故意 permissive；收紧是按部署的产品决策。
4. **AppImage 打包产物重新验证**（Batch 67-2 / Batch 70-2）：`AI Factory-0.1.0.AppImage`（130MB，`~/appimage-out-b70`），linux-unpacked 生产路径（`app.isPackaged=true`：loadFile renderer + spawn backend）；xvfb + PORT=32111/32112 透传生效；`/api/health` → 200；Dashboard/Evaluation/Models 真实点击无崩溃；**66-3 的 `/api/profiles` 修复在打包产物里生效**（红色 "Not found" 横幅消失）；68/69 的修复也在新包里（解包 app.asar 亲验 minified 产物）。启动竞态的 pill 时序是偶发——20 秒窗口内未出现（69-2 的 dev-mode 复验已覆盖出现又自愈的逻辑）。
5. **文档诚实扫荡**（Batch 67-3）：6 处，3 个文件，零产品代码改动——Findings index F1–F4 `open → closed (B12)`（`git log -S` 亲验：index 自 Batch 12 起从未更新过，真滞后）；F53/F57 → closed (B66)（状态+边界重写）；KNOWN_LIMITATIONS 的 Electron 走查口径补了 Batch 60–66 四轮现状；SELLABLE_CHECKLIST 新增"当前状态（2026-10-15，Batch 66 收口）"小节。F1–F62 序号连续无断号（62 行，脚本亲验）。
6. **"审计日志加载失败：Failed to fetch" pill 根因调查**（Batch 68-2）：**真 bug，已修**。服务端无辜（`GET /api/audit?limit=50` → 200）；文案来自启动瞬间的后端不可达（打包 App 里 renderer 先于 spawn 的 backend 就绪，B60 那类启动竞态在 BottomPanel 自己 fetch 上的残留）；根因是 `BottomPanel.tsx` 的状态机：`load(false)` 撞上竞态 → `setErr("Failed to fetch")` → 之后每 5 秒的 `load(true)` 静默轮询成功、行数滚动，但**静默成功永远不清除 err** → 陈旧 pill 永久残留。修复（6 行，桌面端，服务端零改动）：成功时无条件 `setErr(null)`，失败时无条件 `setErr(...)`；`silent` 只管 spinner。69-2 **在真实 Electron 上复验生效**：pill 出现（后端不可达）→ 后端恢复后一个 5 秒周期 pill **消失**，17 行审计事件正常滚动（2 张真 PNG）。
7. **剩余 open findings 逐项复核**（Batch 68-3）：14 条中 **F36 → closed (B55)**（Batch 55 的周期自检政策确实落地了：`audit-chain-watch.ts` 默认开启，`index.ts:609-621` 亲验），其余 13 条保持 open 且逐条给出依据（F5 by-design、F6 被 CI scope 卡在 Tan 侧、F8 文档语义、F10 诚实测试工具链限制、F11 设计约定、F12 真实耐久缺口需功能开发、F15/F16 环境、F20 文档化产品规则、F28 需产品决策、F32 验证器指导、F35 信息性、F61 产品决策）。**需要 Tan 拍板的 3 项**：(1) v1 `POST /transition` 要不要检查 §17.2 授权轴（影响 Board 拖拽 UX）；(2) 要不要新增 HTTP 可达的环境错误信号让 S8 从负向对照变正向触发；(3) authority-conflict 内存态要不要持久化。
8. **桌面端错误状态机扫荡**（Batch 69-3）：31 个含 `setErr/setError` 的 tsx 文件全读过，8 个带轮询的面板逐个亲读；**抓到 1 个同类真 bug（已修）**：`ApprovalsPanel.tsx` 的 `refresh().then(setItems)` 成功不清 error，陈旧横幅永久残留（4 行修复，桌面端，服务端零改动，58-5 模式）。其余面板逐个确认无问题（ActivityPanel/DashboardPanel/EventsPanel/ModelsPanel/NotificationsBell/OpsPanel/App.tsx bootError/TaskDetail/RunDetail）。
9. **打包产物 bug-hunt 扫荡**（Batch 70-3）：CDP 逐个点击 **27 个中心 tab**，**27/27 通过，0 真 bug**：零整树崩溃、零 error boundary、零 "Failed to fetch" pill、零 "Not found" 横幅。脚本 flag 的 2 处深挖后都不是 bug（Agents 全新 DB 的诚实空态引导 UX；Models "degraded" 只是 AVAILABILITY 列单元格值）。**桌面真机 PNG 累计 39 张**。
10. **SPEC_V2 §58 migration-map 合规检查**（Batch 71-2）：亲读 §58 全表（135 个 v1.0 章节 → v2.0 章节对照），逐条抽点代码库：**全部可操作迁移条目合规，0 处真偏差**。v1.29 共享额度钉死（`quota/policy.ts:125` 注释、model-router `router.ts:21,238`）；v1.76 隔离升级逐字钉在代码里（`isolation.ts` 头注释，fail-closed `CONFINEMENT_UNAVAILABLE`）；v1.126 代码库零引用（不依赖 agent builder）；§52.4 v1 数据迁移落实（`migrate-v1.ts` + `migrate-import.ts`；旧 Runs 不导入、MCP 重验证在基础设施落地时补——属 vacuous 而非违反）；v1.12/v1.109–118 状态机迁移诚实标注 lossy 点。AT-001–AT-064 仍 NOT_RUN（如实记录）。
11. **Windows 安装包可行性调研**（Batch 71-3，隔离 worktree，**未改任何 tracked 配置**）：`electron-builder.yml` 的 win target（nsis + portable）、NSIS 配置、icon 全部就绪，但**三平台全部未签名、零证书配置**。在 Linux 上实际跑 `electron-builder --win --publish never`：全量 build OK（2m45s），下载 Windows 版 Electron、组装 `win-unpacked/`、**产出 `ai-factory-0.1.0-x64.nsis.7z` 载荷（109MB）**；**失败点**（真实复现 `docs/packaging.md` 的旧记录）：`⨯ wine process failed ENOENT`——即使无签名配置，electron-builder 在 Linux 上仍需 wine 跑 signtool.exe/rcedit；230KB 的 Setup exe 是未合入载荷的 stub，**不可用**。**wine 装不上**（Ubuntu 源从本容器不可达，与 Batch 11 结论一致）。macOS：本机无 hdiutil/sips，DMG 完全不能在 Linux 上构建。结论：最终 exe 必须 Windows 实机（`npm run dist:win` 一键；但需补 `--publish never`）或 wine 环境；macOS 必须 macOS 实机；签名证书（OV/EV、Apple Developer ID、Apple ID）**都是 Tan 的决定，不代劳**。
12. **走查文档总览**：Walkthrough index **30 行**（v1–v8 + 22 legs）+ Findings **F1–F62**（序号连续无断号，脚本亲验；F1–F4→closed(B12)、F36→closed(B55)、F48→closed(B62)、F53/F57→closed(B66) 均为复验人亲验）。
13. **独立复核链**：Batch 66–70 五个复核报告全部 0 偏差；REAUDIT_BATCH21–70 连续无断档（`ls` 按编号排序亲验）。

## 新增真实缺口

**0 项**。第十轮的新增真实缺口计数已归零（F48 已于 Batch 62 闭环）。Batch 66–71 挖出的：2 个真 bug（`/api/profiles` 门禁遗漏、BottomPanel/ApprovalsPanel 陈旧错误 pill）**均已修复并真机复验闭环**；F36 index 滞后已关闭；其余均为 Info/hygiene 或如实记录的产品决策项（3 项待 Tan 拍板，见上第 7 项）。

## A/B/C/D verdict

- **A 真实可用**：
  - [ ] 真实模型端到端回路：仍 BLOCKED——Codex CLI 二进制在位（`/opt/hatch-image/bin/codex`），但 `~/.codex/auth.json` **不存在** → device login 仍需 Tan 本人执行（2026-10-12 推迟至今无变化；走查仍用 StubAdapter）。**非 Codex 模型适配器仍 stub**（`packages/runtime/src/adapters.ts:101` 的 `class StubAdapter` grep 亲验仍在）。
  - [ ] 桌面应用可分发：Linux 路径继续硬化——AppImage 重打（带 68/69 修复）+ 打包产物真机交互走查（67-2/70-2：Dashboard/Evaluation/Models 真实点击）+ **27/27 面板 bug-hunt 扫荡 0 真 bug**（70-3）+ `/api/profiles` 修复在打包产物里生效 + 启动竞态 pill 自愈逻辑在真实 Electron 上验证（69-2）。但 **Windows 最终 exe 仍未验证**（本轮 71-3 真实复现：缺 wine，最终 Setup exe 不可用；必须 Windows 实机或 wine 环境）；**macOS 仍完全未动**；**三平台全部未签名、零证书配置**（Windows → SmartScreen 警告；macOS → Gatekeeper 拦截；证书采购主体/类型/Apple ID 都是 Tan 的决定）。
  - [ ] 首次运行体验：走查继续累积（index **30 行**：v1–v8 + 22 legs；Findings **F1–F62**）——但**仍只覆盖 API 层**，桌面走查是 CDP 驱动的点击/截图（dev 模式 vite renderer；61-2/67-2/70-2 是 packaged built dist），**不是真人点击验收**；也不是 AppImage 双击体验（无 FUSE，本机从未执行过 `.AppImage` 本体）。**桌面真机 PNG 证据累计 39 张**（`ls gap-audit/*.png` 亲验）。
  - [x] 关键数据可持久：本轮无变化（§48.2 实体集合落库结论不变）。
- **B 规格完整度**：
  - [x] Batch 1–7、Batch 8–23 关闭项无回退迹象（本轮未动该层）。
  - [x] **SPEC_V2 35 条 invariants 全部有测试/走查证据**（结论不变；G1–G11 逐条边界如实记录）。
  - [x] **SPEC_V2 §58 migration-map 合规**（本轮 71-2 新增：135 条对照表全部可操作迁移条目合规，0 真偏差）。
  - [ ] 剩余缺口：**13 项硬阻塞亲验全部仍在 Tan/环境侧，一项没动**——
    1. Codex 登录→真实模型 turn（需 Tan 本人：`~/.codex/auth.json` 不存在，无变化）；
    2. 非 Codex 模型适配器仍 stub（StubAdapter grep 亲验仍在）；
    3. Windows/macOS 安装包+代码签名（71-3 本轮真实复现：Linux 只能产 NSIS 载荷 7z；最终 exe 需 wine（本机装不上）或 Windows 实机；macOS 需 macOS 实机；三平台签名零配置，证书待 Tan 采购）；
    4. 桌面真人点击验收（67-2/69-2/70-2/70-3 均为 CDP 驱动交互，不是真人点击；Batch 57 的"好用"审计是代码审计，诚实边界仍在）；
    5. 许可证/定价/渠道待 Tan 拍板（备料完成：LICENSE_AND_PRICING_BRIEF.md + `docs/release/LICENSING_OPTIONS.md`；仓库刻意无 LICENSE 文件，`ls` 亲验不存在）；
    6. CI workflow scope（`.github/` 亲验仍本地未跟踪 `??`；GitHub CI 从未运行）；
    7. MCP SSE/HTTP/OAuth（routes 目录 grep 亲验：无 sse/oauth 路由文件）；
    8. 无真实隔离 Host（G8 的诚实边界：`verifyConfinement()` 恒 `verified:false`，是拒绝不是假装有 OS 边界）；
    9. 生产 attestation 签名待 Tan 密钥决策；
    10. Windows 工具探测未真机验证；
    11. 远程数据库驱动 / merge queue 多机 M2（待 Tan 拍板；M1 单写者开关在位，无变化）；
    12. 无测试生产环境；
    13. AT-001–AT-064 正式验收（正式验收资产不存在，仍 NOT_RUN）。
    **6 项代码侧刻意不做**无动摇证据（Board v1、`db.query` DENY、`mcp.call` definition-only、启动 reconcile 只报告、F20、env-error HTTP 阳性路径不伪造——立场一致）。
  - [x] 每批口径不变：实现 → 单测 → 全量复验（build 0 / 全量测试 / demos）→ 本地提交（主线稳定树亲验数字）。
- **C 质量与可信**：
  - [x] 全量测试持续全绿（本轮主线亲验：构建 0 错误；包套件 **2567/2567**；服务端全套 **490/490**；desktop tsc 0；electron tsconfig tsc 0；smoke:boot OK）。
  - [x] README/文档与实现一致：走查文档总览（30 行 + Findings F1–F62，亲验）；KNOWN_LIMITATIONS 第 68 行口径同步（亲读）；CHANGELOG Batch 61–71 小节在位（亲验）。
  - [x] 独立复核：REAUDIT_BATCH21–70 连续无断档，Batch 66/67/68/69/70 逐轮 0 偏差（逐轮亲读结论）；Batch 30/GAP_SWEEP_BATCH30、Batch 49/GAP_SWEEP_BATCH49、Batch 62/INV_COVERAGE_SWEEP 扫荡报告在位。
- **D 商业化最小要件**：
  - [x] 版本号与发布说明（CHANGELOG）：版本 0.1.0；Batch 61–71 小节已补（亲验）。
  - [ ] 许可证与第三方声明：备料完成（`docs/release/LICENSING_OPTIONS.md` + LICENSE_AND_PRICING_BRIEF.md）；仓库**刻意无 LICENSE 文件**（默认保留所有权利，拍板前锁住）；**待 Tan 拍板**。
  - [ ] 定价/分发渠道：**待 Tan 拍板**（助手只备料）。

## 卫生注记（非偏差）

1. 本轮复验时主树干净、无兄弟在途改动，遂由复验人亲跑了全量套件（build、npm test、server suite、tsc、smoke:boot）——与历轮"引用收口人数字"不同，本次是独立亲跑数字，同样全绿。
2. Batch 63 的 `git stash -u` 工作树事故的教训仍有效：本轮复验全程未运行 `git stash`；`git status` 干净（仅 `?? .github/` 未跟踪，为既定状态）。
3. 本机 `/dev/null` 缺失状态无变化（625 bytes 普通文件，容器/mknod 权限问题这边修不了）；git 和测试可工作，但继续记录。
4. `/tmp` 是 512MB tmpfs；本次测试无重 IO 产物，无异常。
5. 无 FUSE 环境：`.AppImage` 本体从未被执行（历轮同款边界）；本次跑的是 `linux-unpacked/`，与 67-2/70-2 一致。
6. demo:e2e-v8（1/1×4）、redaction leg（1/1×3）、§81 sweep（1/1×3）、escalation leg（1/1×3）、audit-chain legs（1/1×3）、watch leg（1/1×3）、QA failure-path leg（1/1×3）本轮未重跑——Batch 66–71 未动这些走查链路的代码（本轮数字是全量回归套件的亲跑口径）。

## 总结论

**仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 相对第十轮翻绿 13 项（`/api/profiles` 门禁真 bug 修复 / run trace 脱敏 / 项目政策存储 + QA 门接线 / AppImage 重打（含 68/69 修复）+ 打包产物真机交互走查 / 文档诚实扫荡（F1–F4→closed(B12) 等 6 处）/ BottomPanel 陈旧 pill 真 bug 修复 + 真实 Electron 复验闭环 / F36→closed(B55) + 13 条 open findings 逐项复核（3 项待 Tan 拍板）/ ApprovalsPanel 同类陈旧横幅真 bug 修复 / 27/27 面板 bug-hunt 扫荡 0 真 bug（桌面真机 PNG 累计 39 张）/ SPEC_V2 §58 migration-map 合规（0 真偏差）/ Windows 安装包可行性调研（NSIS 载荷 109MB 在 Linux 上真实产出；最终 exe 需 wine 或 Windows 实机）/ REAUDIT_BATCH21–70 连续无断档）；**新增真实缺口 0 项**（Batch 66–71 抓到的 2 个真 bug 均已修复并真机复验闭环）。13 项硬门槛亲验全部仍在 Tan/环境侧，一项没动——真实模型回路（Codex 登录）、三平台分发+代码签名、许可证/定价/渠道——这些决定"卖"的硬门槛，一项没动，全部需要 Tan 本人动作或外部环境；代码侧已无可代劳的路径。**补充**：本轮基线是本地 commit（`6618b36`），按 Tan 2026-10-15 指令先不推送 GitHub；远端 main 仍为 `7e96bfe`（沿用既定结论，未重复跑 ls-remote）。
