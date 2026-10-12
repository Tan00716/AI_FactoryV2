# 下一批补强提案（Batch 5）— 待 Tan 批准

> 生成：2026-10-12（周一）后台整理，复验基线 HEAD `b3e42bf`（Batch 4 已提交）。
> 来源说明：这 3 条原是 `BATCH_4_PROPOSAL.md` 里的候选；实际执行的 Batch 4 换成了「完整性硬约束」12 条（§16/§20/§18/§6），这 3 条没有被做掉，也没有被否决。本次已在 `b3e42bf` 逐条重新复验，确认仍是真缺口，不是照抄旧提案。
> 本文件只是提案，未动任何代码。批准后按「开发完了才报告」的节奏执行。

## 先行事项：待推提交（3 个）

本地 `main` 领先 `origin/main` **3 个提交**，工作区干净（2026-10-12 后台 `git status` 实测，`main...origin/main [ahead 3]`）：

| 提交 | 内容 | 状态 |
|---|---|---|
| `18fce3c` | Codex app-server 适配器（真实模型接入 route B） | **未推** |
| `6b55110` | Batch 3 接线收尾 | **未推** |
| `b3e42bf` | Batch 4 完整性硬约束（1646/1646 测试） | **未推** |

Tan 已于 2026-10-12 明确「先不推，继续下一批」，故本批继续只做本地提交，推送决定攒着一起定。远端实时状态后台未联网复验，上表以本地跟踪引用为准。

## Batch 5 候选（3 条，均已在 b3e42bf 复验）

1. **§37/§10.2 评审独立性未过服务端门** — `packages/review/src/independence.ts:127` 已有 `reviewWithIndependence()`（先 `assertReviewIndependence` 再 `reviewCode`），但服务端 `apps/server/src/routes/review.ts:75` 仍直接调 `reviewCode(input)`，作者=评审者的自审在 HTTP 层无人拦。改法：路由接受 author/reviewer 身份字段、改走 `reviewWithIndependence`，自审时 fail-closed 拒绝并写明 reasonCode；证据记录评审者身份。小改、高完整性价值，正中「评审独立性」差异化卖点。
2. **§25/§28 G-53 StepIntent 默认路径未接线** — `packages/runtime/src/harness.ts:63` 的 `ToolHarness` 支持可选 `intentStore`，`StepIntentStore` 在 `packages/runtime/src/durable.ts:271`；但全仓 grep 确认 runner/loop/server 默认路径零处实例化或传入，与 Batch 2 给 BudgetTracker 的接法同型：默认路径建一个并传入即可。**边界**：`StepIntentStore` 本身仍是内存 Map，其 DB 持久化 + 启动扫描属 G-59 大项，不进本批，只接线、不冒充持久化（KNOWN_LIMITATIONS 同步注明）。
3. **§27 G-57 残余：fallback 兼容性检查未进路由决策** — `packages/quota/src/policy.ts:67` 的 `checkFallbackCompatibility()` 目前仅被 quota 包自己的 demo/测试引用（复验确认）；`packages/model-router/src/router.ts:152` 选 fallback 时直接取 `scored[1]`，不查兼容性。改法：router 选 fallback 时调用该检查，不兼容的候选降级/剔除并在路由理由中标注。小改，补齐 §26/§27 接线。

## 明确不进 Batch 5（大功能，单独立项）

StepIntent/OperationLedger 的 DB 持久化与启动扫描（G-59 整块）、outbox_events 落库写入者、Board UI 切 v2 引擎（Batch 2 已明确不切，理由仍成立）、真实 PTY、Git Broker/Merge Queue、完整 RBAC、OS Secret Broker、备份/恢复、Final Report 生成器、e2e 验收套件、打包 .exe、Codex 真回路登录验证（Tan 已明确搁置，不催）。

## 执行口径（沿用前四批）

每条：实现 → 单测 → 全量复验（build 0 错误 / 全量测试 / demos / 相关端点 curl 实测）→ 本地提交 → 报告时连同推送决定一起请 Tan 定。
