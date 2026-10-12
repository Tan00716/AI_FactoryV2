# 下一批补强提案（Batch 6）— 待 Tan 批准

> 生成：2026-10-12（周一）后台整理，复验基线 HEAD `4ec1db6`（Batch 5 已提交，本地 main 领先 origin/main 1 个提交，工作区干净 — 后台 `git status` 实测）。
> 来源：2026-10-11 的 59 章审计 group-c（§§31–45）/ group-d（§§46–59）清单。审计基线是旧提交 `47856d7`，其中多条已被 Batch 1–5 与 24 项批次修掉；以下 4 条已在 `4ec1db6` 逐条用 grep/读源码重新复验，确认仍是真缺口，不是照抄旧账。
> 本文件只是提案，未动任何代码。批准后按「开发完了才报告」的节奏执行。

## 先行事项：待推提交（1 个）

| 提交 | 内容 | 状态 |
|---|---|---|
| `4ec1db6` | Batch 5 接线（评审独立性服务端门 / StepIntent 默认接线 / fallback 兼容性进路由）1655/1655 测试 | **未推**，等 Tan 发话 |

## Batch 6 候选（4 条，均已在 4ec1db6 复验）

1. **§58 G-19 v1 迁移函数无生产调用方** — `packages/project-io/src/migrate-v1.ts` 五个迁移函数（migrateOrgEdges / migratePermissionsToCeilings / migrateTaskCompletion / migrateMemoryText / migrateProductionApproval）全仓只有 tests 和 demo 在调；服务端导入路径 `apps/server/src/routes/project-io.ts:170` 直接 `importProjectAi(files, { targetDir })`，从不跑迁移。改法：导入路径识别 v1 数据并执行迁移（或至少检测 + 报告 + 拒绝静默按 v2 解释），迁移结果进导入报告。小改、「已建未通」型，正中 Batch 3/5 的同类卖点。
2. **§36 Git 证据五字段缺失** — 规格要求代码变更证据记录 Base SHA、Candidate SHA、Target SHA、Diff Hash、Artifact Digest；`packages/git/src/evidence.ts` 的 `CodeChangeLogEntry` 只有 `{sha, message, author, date}`，`codeChangeEvidencePayload()` 也只透传这四项，五个规范字段一个都没有。改法：扩展 log entry 与 payload，commit/merge 时填充（diff hash 可由 git diff 计算，artifact digest 无产物时如实 null 并标注）。小改、证据链完整性价值高。
3. **§33 工具空结果未单独建模** — `packages/tools/src/types.ts:84` 的 `ExecutionOutcome` 只有 `SUCCEEDED | FAILED | TIMED_OUT | DENIED`，规格要求 Schema 错误、非零退出、超时、空结果分别处理；executor 无 empty-result 分支，空结果现被当成功吞掉。改法：新增 `EMPTY_RESULT` 结局 + executor 判定（零输出/空集合），harness 对空结果不 seal 成功证据。中小改，防止「假成功」进证据链。
4. **§32 通知无去重/合并/限流** — `packages/notifications/src/engine.ts`、`rules.ts` 全文无 dedupe/merge/retry/rate-limit 逻辑（已复验 grep 零命中）；现状只有 in_app 通道 + 发送时脱敏（24 项批次加的）。同一事件风暴会逐条刷屏。改法：engine 加按 (type, entity, 窗口) 去重合并 + 每接收者限流，合并计数写进通知本身。范围只做 in_app 通道内的去重/限流，不做 email/webhook 新通道（那是大项）。

## 明确不进 Batch 6（大功能，单独立项）

G-59 StepIntent/OperationLedger DB 持久化 + 启动扫描、outbox_events 落库写入者、DB backup/restore（G-05）、Retention/Legal Hold（G-06）、Project 生命周期（G-07）、Git Broker/Merge Queue（§36 其余部分）、MCP 熔断/分级健康（§34）、真实 PTY、完整 RBAC、Final Report 生成器、e2e 验收套件、打包/签名、Codex 真回路登录验证（Tan 已明确搁置，不催）。

## 执行口径（沿用前五批）

每条：实现 → 单测 → 全量复验（build 0 错误 / 全量测试 / demos / 相关端点 curl 实测）→ 本地提交 → 报告时连同推送决定一起请 Tan 定。
