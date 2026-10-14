# 可售清单复验报告（Batch 46，第四轮）

> 复验基线：`b0046e2`（Batch 46，已推送，远端 main 经 `git ls-remote` 复验一致）。上次复验：Batch 44 第三轮全量复验（基线 `e20c5df`，`gap-audit/SELLABLE_REVERIFY_BATCH44.md`），中间走了 Batch 45（`cc528e8`）、Batch 46（`b0046e2`）。
> 本报告为增量：只记录相对 Batch 44 的变化，不重复 44 全文。复验方式：亲读 CHANGELOG（Batch 45–46）、KNOWN_LIMITATIONS、`docs/needs-human-triggers.md`、`docs/merge-queue-multimachine.md`、相关代码 grep 与文件存在性验证；HEAD 亲验为 `b0046e2`；测试数字引用主线亲验（收口人全绿复验），本人对关键新文件做存在性+内容亲读；零产品代码改动，未 commit。

## 主线验证数字（Batch 46 收口，主线亲验，引用）

- 根 `npm run build`：0 TS 错误
- `npm test`：**2504/2504**（Batch 44：2502/2502；Batch 45：2504/2504，+2：env-error-codes 窄版放行）
- `node --test apps/server/tests/*.test.ts`：**424/424**（Batch 44：408/408；Batch 45：422/422，+14：narrative builder 断言、backup-project-files 12；Batch 46：424/424，+1：audit-list-contract 契约测试，+1：走查 v7）
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误；`npm run smoke:boot`：OK
- `demo:e2e-v7`：1/1 连续 3 次（含 11 个包构建链）

## A. 真实可用

| 条目 | 44 状态 | 本次状态 | 说明 |
|---|---|---|---|
| 真实模型端到端回路 | BLOCKED（卡 Codex 登录） | **仍 BLOCKED，无变化** | 卡点未变：需 Tan 本人在开发机执行 `codex login --device-auth`（Tan 2026-10-12 明确推迟，不催）。`packages/runtime/src/adapters.ts` 的 StubAdapter 本轮亲验仍在（7 处匹配）——非 Codex 适配器仍 stub。 |
| 桌面应用可分发 | 部分（Linux 验证过） | **部分，无变化** | Linux AppImage（Batch 25）仍是唯一亲验过的分发；Windows 无构建环境、macOS 需 Mac 本机、代码签名零配置（证书待 Tan 采购）。 |
| 首次运行体验 | 走查第六版 1/1 | **走查第七版，保持** | v7（`first-run-walkthrough-b46.test.ts`，`demo:e2e-v7`，`package.json:80` 亲验在位），单 test 纯 HTTP 零 mock 串完 B43–B45 新链路（N1 narrative 持久化、K1 备份项目文件 E2E、E1(a) env-error 包级真路径、E1(b) HTTP 负向对照），1/1 连续 3 次。走查仍只覆盖 API 层，**无真机桌面点验**（诚实边界不变）。Findings：**F22 — Low（真实产品缺口，新）**：备份 collector 信任 project 记录的 `path` 字段——`POST /api/projects` 对 path 无任何校验，`createBackup` 会 walk 该字段指向的任意已存在目录；open 模式下任何 API 调用者都能 plant 一条指向 `/etc` 的记录。建议建记录时校验收敛（产品批次修）。**F23 — Info（走查卫生）**：v7 import 编译后 runtime dist，demo:e2e-v7 构建链必须同步扩展。 |
| 关键数据可持久 | ✅ 勾选，§48.2 全落库 | **保持勾选** | Batch 45 新增持久化面：`needs_human_upgrades` 的 8 个 builder 的 `detailJson.narrative`（见 B）。F19 关闭。 |

## B. 规格完整度

### Batch 45–46 新关闭的真实缺口（亲验在位）

1. **F19 关闭——narrative 持久化 8/8 全覆盖（Batch 45）**：亲读确认 7 个文件位置在位——`workforce.ts`（policy-violation，Batch 44 前例）、`redaction-monitor.ts`（security-issue，Batch 44）、`requirements.ts`（requirement-ambiguity，Batch 44）、`authority.ts`（ai-disagreement，本批：导出测试缝 + "the conflict is structural, not a judgment on either principal"）、`cicd.ts`（high-risk-deployment，本批："no deployment was executed — the gate held"）、`runtime.ts`（budget-exceeded/repeated-failure 两版限定语，本批）、`runtime.ts`（irrecoverable-env-error，本批："'Irrecoverable' describes the loop's own recovery being exhausted — a fact about the run's terminal state, not a prediction"）。模式统一（`const narrative` → `detail: narrative` → `detailJson.narrative`），无表结构变更、发射逻辑逐行未动。走查 v7 N1 断言"诚实限定语活过持久化"已钉住。
2. **env-error 窄版放行落地（Batch 45）**：设计评审结论亲读 `docs/needs-human-triggers.md`——(a-full) 全量放行否决（改变 stagnation 分组语义，blast radius 过大）；(a-narrow) 采纳（只有 `ENV_ERROR_CODES` 集合内 code 保留为签名，其余仍掩 `tool:<name>:fail`；零已注册工具会抛环境码，今天零行为变更）；(b) 无条件 `assertSandboxAvailable()` 否决（本环境 `bwrap: command not found`，会杀死所有 run，违背 best-effort 设计）。诚实边界钉死：**HTTP 阳性路径依然不存在**——没有伪造可达性。
3. **备份覆盖面扩展（Batch 45）**：KNOWN_LIMITATIONS 的"Backup 只覆盖 SQLite DB"条目已关闭（亲读新口径：工厂数据库 + 各活跃项目工作文件含 `.ai/`；符号链接永不跟随；默认排除 node_modules/dist/build/.git 等；单文件 25MiB、单次 512MiB；skipped 原因码记录在案不静默丢）。新端点 `POST /api/restore/project-files`（路由注释亲验在位 `backup.ts:66`；先全量校验→422 不动现树；pre-restore 拷贝；逐文件重哈希校验；`PROJECT_FILES_RESTORED` 审计）。scope 语义诚实（`factory-database+project-files` 仅当实际收录 ≥1 个项目文件）。备份测试 `backup-project-files.test.ts` 在位。
4. **F21 修复（Batch 46）**：`GET /api/audit` 钉死裸数组为正式契约——亲读 `apps/server/src/index.ts:1583` 注释（"formal contract (Batch 46, F21): returns a BARE JSON" / "Never an envelope"）；新建 `apps/server/tests/audit-list-contract.test.ts`（三条契约 tripwire：裸数组/新在前/limit=2）。决策：~27 个 server 测试消费方都按裸数组工作，包 envelope 是破坏性变更；同级 `/api/evidence` 同样裸数组；无分页元数据可带。桌面端无调用。
5. **走查第七版（Batch 46）**：v7 + `demo:e2e-v7`（`package.json:80` 亲验在位），N1/K1/E1(a)/E1(b) 见 A 表；`docs/FIRST_RUN_WALKTHROUGH.md` Batch 46 一节 + F22–F23 在位。
6. **merge queue 多机共识诚实界定（Batch 46）**：`docs/merge-queue-multimachine.md` 新建（亲验在位）；KNOWN_LIMITATIONS merge queue 三处条目口径收紧（亲验：34/48/73 行均指向设计文档）。结论：**只换分布式锁（Redis Redlock）不动状态是伪方案**——"写到哪"比"谁先写"更根本；真解是共享数据库（Postgres），但前置"远程 DB 驱动"本身是硬阻塞；M1（`FACTORY_MERGE_DRAIN=0` 单写者开关）是唯一今天能动手的；M2（Postgres 迁移 RFC 或明确不支持多机）需要 Tan 拍板。明确不做：NFS 共享 SQLite、只上 Redis 锁、跨机复用本地时钟租约。部署建议：merge queue 只跑单实例。

### 剩余真实缺口（诚实边界，非遗漏）

1. Codex 以外模型适配器仍 stub（`packages/runtime/src/adapters.ts` 本轮亲验仍在）。
2. 远程数据库驱动未做（Postgres 迁移 RFC 待 Tan 拍板，见 merge-queue M2）。
3. merge queue 多机并发未做（只覆盖同一 DB 文件多进程；多机脑裂场景已文档化，部署建议单实例；M2 待 Tan 决策）。
4. Windows 工具探测未在 Windows 验证。
5. 桌面真人点击验收未做。
6. SBOM attestation 生产签名（待 Tan 密钥决策；dev 路径已关闭并纳入 retention）。
7. **F22（新，Low）**：备份 collector 信任 project 记录的 `path` 字段（建议建记录时校验收敛）。
8. CI：`.github/workflows/ci.yml` 仍是本地未跟踪状态（本轮 `git status --short .github/` 亲验 `??`），因 OAuth 缺 `workflow` scope 无法推送，**GitHub CI 从未运行过**。
9. doc nit 修复（Batch 45 收口）：`docs/needs-human-triggers.md` 两处旧的 `` `POST /api/runtime/run` `` 已改为 `/api/runtime/runs`。

## C. 质量与可信

- **全量测试持续全绿**：✅ 保持勾选。数字见上（2504/2504、424/424、tsc 0、smoke OK、demo:e2e-v7 1/1×3）。
- **文档与实现一致**：✅ 保持勾选。CHANGELOG Batch 45–46 小节在位；KNOWN_LIMITATIONS merge queue 条目为新口径（指向设计文档）；needs-human-triggers.md 窄版放行设计评审已钉死；KNOWN_LIMITATIONS 备份条目为项目文件新口径。
- **独立复核**：✅ 保持勾选，追加：Batch 43（REAUDIT_BATCH43.md，偏差 0）、Batch 44（REAUDIT_BATCH44.md，偏差 0）、Batch 45（REAUDIT_BATCH45.md，偏差 0）。**`gap-audit/REAUDIT_BATCH21.md`–`REAUDIT_BATCH45.md` 连续无断档**（本轮 `ls` 亲验 REAUDIT_BATCH44/45 在位）。

## D. 商业化最小要件

- **版本号与 CHANGELOG**：✅ 保持勾选。版本仍 0.1.0；CHANGELOG 按批维护（Batch 45–46 小节在位）。
- **许可证**：**仍待 Tan 拍板**（无变化）。`docs/release/LICENSING_OPTIONS.md` 在位；仓库无 LICENSE 文件是刻意状态（默认保留所有权利，本轮亲验 `ls LICENSE` 仍不存在）。
- **定价/分发渠道**：**仍待 Tan 拍板**（无变化）。

## 建议的清单勾选更新（相对 44）

1. B-剩余缺口列表：F19（narrative 持久化）移出剩余项（已关闭）；新增"F22（Low）：备份 collector 信任 project 记录 path 字段，建记录时未校验收敛"；merge queue 多机条目更新为"多机脑裂已文档化（docs/merge-queue-multimachine.md），M2 待 Tan 决策，部署建议单实例"。
2. B-已关闭列表追加：F19 narrative 持久化 8/8（Batch 45）、备份覆盖项目工作文件+.ai/（Batch 45）、F21 审计列表裸数组契约（Batch 46）、走查第七版（Batch 46）、merge queue 多机设计界定（Batch 46）。
3. C-测试基线：→ 基线 `b0046e2`：包套件 2504/2504，服务端全套 424/424，desktop tsc 0，smoke:boot OK，demo:e2e-v7 1/1×3。
4. C-独立复核："Batch 22–42" → "**Batch 22–45** 每批独立复核全成立"。
5. 顶部新增"当前状态（2026-10-14，Batch 46 收口，基线 b0046e2）"小节（结论见下）。

## 总结论

- **翻绿项（相对 Batch 44）**：F19 关闭——narrative 持久化 8/8 全覆盖（走查 v7 N1 钉住）；备份覆盖面扩展（"Backup 只覆盖 SQLite DB"条目关闭）；F21 审计列表契约钉死；走查 v7 串完 B43–B45 新链路（1/1×3）；merge queue 多机共识诚实界定（文档层面闭环"未做"的论证）；Batch 43/44/45 独立复核 0 偏差。
- **新增真实缺口 1 项**：F22（Low）——备份 collector 信任未校验的 project.path（产品批次修，建记录时校验收敛）。
- **仍卡项（硬卡点全在 Tan 一侧或环境项，无变化）**：A-真实模型回路（卡 Codex 登录，Tan 本人动作）；A-桌面分发 Windows/macOS + 代码签名（环境/采购）；D-许可证/定价/渠道（Tan 决策）；B-剩余：非 Codex 适配器 stub、远程数据库驱动、merge queue 多机（M2 待 Tan 拍板）、Windows 工具探测、桌面真人验收、attestation 生产签名、F22；CI 在 GitHub 从未运行过。
- **当前仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 测试全绿（2504/2504、424/424）、文档诚实、Batch 22–45 独立复核 0 偏差、§81 全部接上且 narrative 活过持久化，但决定"卖"的硬门槛——真实模型回路（Codex 登录）、三平台分发+签名、许可证/定价/渠道——一项没动；这些全部需要 Tan 本人动作或外部环境，代码侧已无可代劳的路径。
