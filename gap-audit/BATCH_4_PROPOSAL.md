# 下一批补强提案（Batch 4）— 待 Tan 批准

> 生成：2026-10-12（周一）后台整理。主题延续 Batch 3：专挑「已建未通」的接线尾巴。
> 三条候选均已于 2026-10-12 在当前代码（HEAD `6b55110`）逐条复验，不是照抄 10-11 审计原文（审计中 §7.5 confinement 一条经复验已在 `packages/projects/src/executor.ts` 接线，故未入选）。
> 本文件只是提案，未动任何代码。批准后按「开发完了才报告」的节奏执行。

## 先行事项：待推提交（2 个）

本地 `main` 领先 `origin/main` **2 个提交**，工作区干净（2026-10-12 后台 `git status` 实测）：

| 提交 | 内容 | 状态 |
|---|---|---|
| `96ade1c` | Batch 2 | 已在远端（本地跟踪引用） |
| `18fce3c` | Codex app-server 适配器（真实模型接入 route B） | **未推** |
| `6b55110` | Batch 3 接线收尾（linkEntities 端点 / AOCR 真数据 / 账号状态实时化 / demo 45） | **未推** |

远端实时状态后台无法联网复验（`git ls-remote` 被后台网络限制拦截）；上表以本地 `origin/main` 跟踪引用（`96ade1c`）为准，推送时以实际结果为准。两个提交快进推送、预期无冲突。真回路登录验证按 Tan 指示搁置，不在本提案内。

## Batch 4 候选（均为审计原文条目 + 本次复验）

1. **§37/§10.2 评审独立性未过服务端门** — `packages/review` 已有 `reviewWithIndependence()`（先 `assertReviewIndependence` 再 `reviewCode`），但服务端 `POST /api/review`（`apps/server/src/routes/review.ts`）直接调 `reviewCode`，作者=评审者的自审在 HTTP 层无人拦。改法：路由接受 author/reviewer 身份字段、走 `reviewWithIndependence`，自审时 fail-closed 拒绝并写明 reasonCode；证据记录评审者身份。小改、高完整性价值，正中「评审独立性」差异化卖点。
2. **§25/§28 G-53 StepIntent 默认路径未接线（仅接线一半）** — `ToolHarness` 支持可选 `intentStore`，但 `runAgent` 默认路径从不创建/传入（`runner.ts`/`loop.ts` 零引用，复验确认），与 Batch 2 给 BudgetTracker 的接法同型：默认路径建一个并传入即可。**边界**：`StepIntentStore` 本身仍是内存 Map，其 DB 持久化 + 启动扫描属 G-59 大项，不进本批，只接线、不冒充持久化（KNOWN_LIMITATIONS 同步注明）。
3. **§27 G-57 残余：fallback 兼容性检查未进路由决策** — `packages/quota` 的 `checkFallbackCompatibility()`（四项检查）目前仅被 quota 包自己的 demo/测试引用（复验确认），model-router 选 fallback 时不查。改法：router 选 fallback 时调用该检查，不兼容的候选降级/剔除并在路由理由中标注。小改，补齐 §26/§27 接线。

## 明确不进 Batch 4（大功能，单独立项）

StepIntent/OperationLedger 的 DB 持久化与启动扫描（G-59 整块）、outbox_events 落库写入者、Board UI 切 v2 引擎（Batch 2 已明确不切，理由仍成立）、真实 PTY、Git Broker/Merge Queue、完整 RBAC、OS Secret Broker、备份/恢复、Final Report 生成器、e2e 验收套件、打包 .exe。

## 执行口径（沿用前三批）

每条：实现 → 单测 → 全量复验（build 0 错误 / 全量测试 / demos / 相关端点 curl 实测）→ 本地提交 → 报告时连同推送决定一起请 Tan 定。
