# 可售清单复验报告（Batch 49，第五轮）

> 复验基线：`e86b75d`（Batch 49，已推送，远端 main 经 `git ls-remote` 复验一致）。上次复验：Batch 46 第四轮全量复验（基线 `b0046e2`，`gap-audit/SELLABLE_REVERIFY_BATCH46.md`），中间走了 Batch 47（`8004764`）、Batch 48（`52b8413`）、Batch 49（`e86b75d`）。
> 本报告为增量：只记录相对 Batch 46 的变化，不重复 46 全文。复验方式：亲读 CHANGELOG（Batch 47–49）、KNOWN_LIMITATIONS、`docs/FIRST_RUN_WALKTHROUGH.md`、`gap-audit/GAP_SWEEP_BATCH49.md`、`gap-audit/REAUDIT_BATCH4[6-8].md`、相关代码 grep 与文件存在性验证；HEAD 亲验为 `e86b75d`；测试数字引用主线亲验（收口人全绿复验），本人对关键新文件做存在性+内容亲读；零产品代码改动，未 commit。

## 主线验证数字（Batch 49 收口，主线亲验，引用）

- 根 `npm run build`：0 TS 错误
- `npm test`：**2517/2517**（Batch 46：2504/2504；+13：cross-chunk-redaction）
- `node --test apps/server/tests/*.test.ts`：**451/451**（Batch 46：424/424 → Batch 47：432（+6：project-path-validation，+2：merge-queue drain-switch）→ Batch 48：438（+5：terminal 跨块，+1：走查 v8）→ Batch 49：451（+11：run budgets，+1：tools 预置，+1：redaction 走查））
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误；`npm run smoke:boot`：OK
- `demo:e2e-v8`：1/1 连续 4 次（含 11 个包构建链）；redaction leg 走查 1/1 连续 3 次

## A. 真实可用

| 条目 | 46 状态 | 本次状态 | 说明 |
|---|---|---|---|
| 真实模型端到端回路 | BLOCKED（卡 Codex 登录） | **仍 BLOCKED，无变化** | 卡点未变：需 Tan 本人在开发机执行 `codex login --device-auth`（Tan 2026-10-12 明确推迟，不催）。`packages/runtime/src/adapters.ts` 的 StubAdapter 本轮亲验仍在（grep 7 处匹配）——非 Codex 适配器仍 stub。 |
| 桌面应用可分发 | 部分（Linux 验证过） | **部分，无变化** | Linux AppImage（Batch 25）仍是唯一亲验过的分发；Windows 无构建环境、macOS 需 Mac 本机、代码签名零配置（证书待 Tan 采购）。**新增诚实性变化**：BackupPanel 的虚假文案（"备份范围仅为工厂数据库"——Batch 45 起已收项目文件）已改写；`BackupSummary` 补 `scope`/`projectFiles`；新增「恢复项目文件…」入口（立即生效不排队、preRestoreDir 回滚点、422 时现树不动）+ 备份表「范围」列；桌面 tsc 0。桌面仍无 needs-human 面板（注释在案）。 |
| 首次运行体验 | 走查第七版 1/1×3 | **走查第八版 + redaction leg，保持** | v8（`first-run-walkthrough-b48.test.ts`，`demo:e2e-v8`，`package.json:81` 亲验在位），单 test 纯 HTTP 零 mock、两次真实 server 启动串完 B47 新链路：P1 path 校验（plant `/etc` → 400 `PROJECT_PATH_OUTSIDE_ROOT`、`..` 转义 → 同码、相对路径/不存在/非目录各对码，四条被拒无一写入；纵深防御——运行时直接 DB plant 越界 path → 备份时 `/etc` 从未被 walk，记 `manifest.skippedProjects`）；M1 on/off 双验证（on → 202+`drainPending:true`+entry 保持 QUEUED；off → 201+entry MERGED，老行为逐行未动），1/1 连续 4 次。redaction leg（`first-run-walkthrough-redaction.test.ts`，新建）：真实 server+真 pty、确定性跨块（split printf，两半 transcript 连续但成两个独立 push），R1 零秘密字节、R2 前缀重叠 live（Batch 48 `xxAB\|CDEFyy` 场景）、R3 marker 恰好 1 次、R4 `SECRET_REDACTED_HIT` 在位，1/1 连续 3 次。走查仍只覆盖 API 层，**无真机桌面点验**（诚实边界不变）。Findings：**F24 — Info**（P1(c) live DB plant 依赖 HTTP 请求间无打开事务，timing-adjacent）；**F25 — Info**（并发走查共享 24xxx–44xxx 随机端口池，冲突响亮失败）；**F26 — Info**（诚实契约是响应无 `value` 键，不是字符串不包含）；**F27 — Info**（audit 行用 camelCase，db.ts 映射）。 |
| 关键数据可持久 | ✅ 勾选，§48.2 全落库 | **保持勾选** | 无新增持久化面变化。Batch 49 新增：run `budgets` 请求参数（非持久化契约，manifest 快照 `budgetLimits.loop` 按请求生效，Batch-15 不漂移）。 |

## B. 规格完整度

### Batch 47–49 新关闭的真实缺口（亲验在位）

1. **F22 关闭（Batch 47）**：亲读 `apps/server/src/routes/backup.ts`——`resolveProjectsRoot`（`FACTORY_PROJECTS_ROOT` 非空即用，否则默认 `<db 目录>/projects`）+ `validateProjectPath`（绝对→词法收敛→存在性→是目录→realpath 双检查；收敛在存在性之前防存在性预言；拒绝码 `PROJECT_PATH_NOT_ABSOLUTE`/`_NOT_FOUND`/`_NOT_DIRECTORY`/`_OUTSIDE_ROOT`；空 path 合法）；`POST /api/projects` 建记录门控在位（不过 → 400 + 明确 code，记录不写入）；纵深防御在位（createBackup 越界行跳过记 `manifest.skippedProjects` reason `path-outside-root`；restore 对越界现目录拒绝写入）；restore 侧同信任链一并修。dual-mode 取舍成立（canonical 拷贝放 `backup.ts` 内，注释写明原因）。`apps/server/tests/project-path-validation.test.ts` 在位。`docs/FIRST_RUN_WALKTHROUGH.md` 的 F22 已改写为"Batch 47 已修复"。
2. **merge queue M1 单写者开关（Batch 47）**：亲读 `apps/server/src/routes/git.ts:623`——`FACTORY_MERGE_DRAIN === '0'` 时 enqueue 后直接返回 202 + `drainPending: true`（审计 `MERGE_QUEUE_ENQUEUED`），默认路径逐行未动。`apps/server/tests/git-merge-queue-drain-switch.test.ts` 在位。`docs/merge-queue-multimachine.md` M1 标已落地。诚实限定在位：只解决 drain 互斥、不解决状态共享；M2（Postgres 迁移 RFC 或明确不支持多机）**仍需要 Tan 拍板**。
3. **terminal 输出脱敏跨块泄漏修复（Batch 48）**：KNOWN_LIMITATIONS ④ 已改写为"已跨块安全（Batch 48）"（本轮亲读行 45 在位）。`packages/secrets/src/broker.ts` 的 `createCrossChunkRedactor`（气密阈值 `match.end ≤ len − carryLen`；前缀重叠场景不漏；emitEnd 负值已钳住）+ `apps/server/src/routes/terminal.ts` 接线（每 SSE 订阅独立实例，backlog+live 同一实例，close 事件前 flush）。`packages/secrets/tests/cross-chunk-redaction.test.ts`（13/13，含 50 轮 fuzz）与 `apps/server/tests/terminal-cross-chunk-redaction.test.ts`（5/5）均在位。诚实边界在文档在位：尾部 ≤ carryLen 码点滞后、carryLen 取舍、密钥含 `***` 的病态构造未处理。
4. **KNOWN_LIMITATIONS 诚实性扫荡（Batch 48，零产品代码改动）**：5 处改动亲验在位——结论基线 → `8004764`（Batch 48 前基线）、§81 追加 Batch 44/45 实测口径（narrative 8/8；env-error HTTP 阳性路径不存在——三重证据+负向对照+走查 v7 E1(b) 钉住；窄版放行只是 tool 层原则上可达）、两处旧句 `` `POST /api/runtime/run` `` 全部改为 `/api/runtime/runs`（grep 亲验 = 0）、走查章节加指针（F19/F21/F22 已关闭）、Database 条目编号清理。
5. **F14 关闭（Batch 49）**：亲读 `apps/server/src/routes/runtime.ts`——`POST /api/runtime/runs` 与 `:id/resume` 接受可选 `budgets`（`{maxSteps?, timeMs?, maxRetries?}`），`resolveRunLoopBudgets()` fail-closed（非对象/未知键/非正整数 → 400 `INVALID_BUDGETS`，无 run 记录产生），有效值喂给 `AgentLoop` 与 manifest `budgetLimits.loop` 快照；`budgets:{maxSteps:3}` → 真实 FAILED、`reasonCode:BUDGET_EXEEDED` → §81 'budget-exceeded' 记录（含诚实 narrative）——**该触发器首次经纯 HTTP 确定性可达**。默认行为零变更。`apps/server/tests/runtime-run-budgets.test.ts`（11/11）在位。`docs/FIRST_RUN_WALKTHROUGH.md` 的 F14 已改写为"Batch 49 已关闭"。
6. **内置工具目录服务端预置（Batch 49）**：`GET /api/tools` 不再返回 `[]`（启动即 `registerBuiltinTools(new ToolRegistry())`——纯元数据，执行仍走 implementationGate + runner + capability 校验）。`apps/server/tests/tools-builtin-preregister.test.ts`（1/1，16 个在位；`runtime.echo` 免注册 SUCCEEDED；`fs.read` 仍 DENIED）在位。
7. **走查第八版（Batch 48）**：v8 + `demo:e2e-v8`（`package.json:81` 亲验在位），P1/M1 见 A 表；`docs/FIRST_RUN_WALKTHROUGH.md` Batch 48 一节 + F24–F25 在位。
8. **redaction leg 走查补钉（Batch 49）**：`apps/server/tests/first-run-walkthrough-redaction.test.ts` 在位；走查文档 'redaction leg' 一节 + F26–F27 在位。
9. **gap-audit 剩余项按可售扫荡（Batch 49）**：`gap-audit/GAP_SWEEP_BATCH49.md` 新建（5710 bytes，亲验在位）——13 项硬阻塞（Tan/环境侧）+ 6 项代码侧刻意不做（论证在位），见下节。

### 剩余真实缺口（诚实边界，非遗漏）

**硬阻塞（Tan/环境侧，代码无可代劳，13 项，见 `gap-audit/GAP_SWEEP_BATCH49.md`）：**
1. Codex 登录 → 真实模型 turn（需 Tan 本人 `codex login --device-auth`，Tan 2026-10-12 明确推迟）
2. 非 Codex 模型适配器仍 stub（`packages/runtime/src/adapters.ts` 本轮亲验仍在）
3. Windows/macOS 安装包 + 代码签名（Windows 无构建环境；macOS 需 Mac 本机；证书待 Tan 采购）
4. 桌面真人点击验收未做
5. 许可证路线与署名主体（待 Tan 拍板；`docs/release/LICENSING_OPTIONS.md` 备料在位）
6. 定价/分发渠道（待 Tan 拍板）
7. CI workflow scope：`.github/workflows/ci.yml` 仍是本地未跟踪状态（本轮 `git status --short` 亲验 `??`），因 OAuth 缺 `workflow` scope 无法推送，**GitHub CI 从未运行过**
8. MCP SSE/HTTP/OAuth（真实握手未验证）
9. 无真实隔离 Host（Browser 只有 Profile 目录隔离；build-sandbox 是 bubblewrap best-effort）
10. 生产 attestation 签名（待 Tan 密钥决策；dev 路径已关闭并纳入 retention）
11. Windows 工具探测（Linux 已验证，Windows 未真机验证）
12. 远程数据库驱动 / merge queue 多机 M2（Postgres 迁移 RFC 或明确不支持多机，待 Tan 拍板）
13. 无测试生产环境；AT-001–AT-064 正式验收（275 条资产目录不存在，记 NOT_RUN）

**代码侧刻意不做（有理由，6 项）：**
1. Board 仍走 v1——诚实迁移需 UI 收集 gate 输入，硬切 = 假接线
2. `db.query` 工具 DENY——刻意分层（Batch 29）
3. `mcp.call` definition-only——刻意只定分类
4. 启动 reconcile 只报告——处置留给上层是设计
5. F20——文档化的产品规则
6. env-error HTTP 阳性路径——Batch 44/45 立场不变，不伪造可达性（Batch 49 仍亲验：走查 v7 E1(b) 负向对照 + tripwire 在位）

## C. 质量与可信

- **全量测试持续全绿**：✅ 保持勾选。数字见上（2517/2517、451/451、tsc 0、smoke OK、demo:e2e-v8 1/1×4、redaction leg 1/1×3）。
- **文档与实现一致**：✅ 保持勾选。CHANGELOG Batch 47–49 小节在位；KNOWN_LIMITATIONS 经 Batch 48 扫荡（基线 `8004764`、§81 口径、terminal ④ 已跨块安全、走查指针）；走查文档含 v8 + redaction leg（F24–F27）；`docs/merge-queue-multimachine.md` M1 标已落地。
- **独立复核**：✅ 保持勾选，追加：Batch 46（REAUDIT_BATCH46.md，偏差 0）、Batch 47（REAUDIT_BATCH47.md，偏差 0）、Batch 48（REAUDIT_BATCH48.md，偏差 0）。**`gap-audit/REAUDIT_BATCH21.md`–`REAUDIT_BATCH48.md` 连续无断档**（本轮 `ls` 亲验 REAUDIT_BATCH46/47/48 在位；REAUDIT_BATCH47 的 F22 脏数据走查注记：是 worker 对本地库的一次性动作，复核如实标注未独立重验、不计偏差）。

## D. 商业化最小要件

- **版本号与 CHANGELOG**：✅ 保持勾选。版本仍 0.1.0；CHANGELOG 按批维护（Batch 47–49 小节在位）。
- **许可证**：**仍待 Tan 拍板**（无变化）。`docs/release/LICENSING_OPTIONS.md` 在位；仓库无 LICENSE 文件是刻意状态（默认保留所有权利，本轮亲验 `ls LICENSE` 仍不存在）。
- **定价/分发渠道**：**仍待 Tan 拍板**（无变化）。

## 建议的清单勾选更新（相对 46）

1. A-首次运行体验："第七版 … F22 — Low（真实产品缺口，新）" → **第八版**（`first-run-walkthrough-b48.test.ts`，`demo:e2e-v8`，1/1 连续 4 次；串完 B47 新链路：P1 path 校验 + M1 开关 on/off 双验证）+ **redaction leg**（`first-run-walkthrough-redaction.test.ts`，1/1 连续 3 次；脱敏跨块修复的 live 钉住）；F22 条目改写为"Batch 47 已修复"；Findings 追加 F24–F27。
2. B-剩余缺口列表：F22 移出剩余项（Batch 47 已关闭）；新增"F14 已关闭（Batch 49）"、"merge queue M1 单写者开关已落地（Batch 47）"、"terminal 脱敏跨块泄漏已修复（Batch 48）"、"工具目录服务端预置（Batch 49）"；merge queue 多机条目更新为"M2 待 Tan 决策（Postgres 迁移 RFC 或明确不支持多机），部署建议单实例"；剩余项更新为 13 项硬阻塞 + 6 项代码侧刻意不做（见 `gap-audit/GAP_SWEEP_BATCH49.md`）。
3. B-已关闭列表追加：F22 项目 path 校验三层机制（Batch 47）、merge queue M1 单写者开关（Batch 47）、terminal 跨块脱敏修复（Batch 48）、F14 run budgets 确定性 HTTP 触发（Batch 49）、内置工具目录预置（Batch 49）。
4. C-测试基线：→ 基线 `e86b75d`：包套件 2517/2517，服务端全套 451/451，desktop tsc 0，smoke:boot OK，demo:e2e-v8 1/1×4，redaction leg 1/1×3。
5. C-独立复核："Batch 22–45" → "**Batch 22–48** 每批独立复核全成立，偏差 0"。
6. 顶部新增"当前状态（2026-10-14，Batch 49 收口，基线 e86b75d）"小节（结论见下）。

## 总结论

- **翻绿项（相对 Batch 46）**：F22 关闭——项目 path 校验三层机制（走查 v8 P1 钉住）；merge queue M1 单写者开关落地（走查 v8 M1 on/off 双验证钉住）；terminal 跨块脱敏修复（KNOWN_LIMITATIONS ④ 关闭，包级 13/13 + server 端 5/5 + redaction leg live 钉住）；F14 关闭——'budget-exceeded' 首次经纯 HTTP 确定性可达；内置工具目录服务端预置（`GET /api/tools` 不再 `[]`）；走查 v8 串完 B47 新链路（1/1×4）；桌面端诚实性修复（BackupPanel 虚假文案改写 + 项目文件恢复入口）；KNOWN_LIMITATIONS 诚实性扫荡；Batch 46/47/48 独立复核 0 偏差。
- **新增真实缺口 0 项**：Batch 47–49 挖出的 F24–F27 均为 Info 级（走查卫生/测试卫生），F22 是 Batch 46 遗留缺口的关闭而非新增。
- **仍卡项（硬卡点全在 Tan 一侧或环境项，无变化）**：13 项硬阻塞 + 6 项代码侧刻意不做（见上节）。决定"卖"的硬门槛——真实模型回路（Codex 登录）、三平台分发+签名、许可证/定价/渠道——一项没动；这些全部需要 Tan 本人动作或外部环境，代码侧已无可代劳的路径。
- **当前仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 测试全绿（2517/2517、451/451）、文档诚实、Batch 22–48 独立复核 0 偏差无断档、§81 全部接上且 narrative 活过持久化、备份覆盖项目文件且 path 校验三层在位、脱敏跨块安全。
