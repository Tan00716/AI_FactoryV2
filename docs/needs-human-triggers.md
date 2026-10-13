# §81 needsHuman 触发器勘察（Batch 36–39）

SPEC §81："Human intervention should mainly occur when: Requirement
ambiguity, Policy violation, Repeated failure, Budget exceeded,
High-risk deployment, Security issue, Irrecoverable environment error,
AI disagreement." 八个触发器在 `@ai-factory/autonomy` 的
`HUMAN_NEED_REASONS` 里有定义（`packages/autonomy/src/escalation.ts`），
`needsHuman()` 只接受这八个 reason。

发射原则（Batch 36 立下的）：只在**确定性发射点**接——系统状态本身
就是该触发器的定义，而不是用启发式/硬编码标签冒充。recipient 为
null（server 只有粗粒度 token RBAC，无具名人类账号），记
requiredDeciderLevel 而不编造人。

## 已发射（4/8）

| 触发器 | 发射点 | 批次 |
|---|---|---|
| `ai-disagreement`（AI 分歧） | AUTHORITY_CONFLICT 进入 OPEN：同级不兼容指令 → `AuthorityConflictRegistry.onConflictOpened` → `needsHuman('ai-disagreement', …)` 写透 `needs_human_upgrades`。requiredDeciderLevel：严格更高一级（§8.1 upward 规则）；owner-vs-owner 死锁时记 maxLevel + suggestion 说明需带外裁决。 | Batch 36 |
| `budget-exceeded`（预算超限） | runtime run 终局时 `RunResult.reasonCode === 'BUDGET_EXCEEDED'`：`BudgetExceeded` 是 `FactoryError`（machine-readable `code`），`runAgent` 把 code 透传为 `reasonCode`（Batch 38 新增桥），server 按 code 分类、**不匹配 message 字符串** → `needsHuman('budget-exceeded', …)`，source `runtime-run:<runId>`。requiredDeciderLevel：`operator`（做日常 run 工作的 API 角色，可重调预算/改任务/放弃）。severity high。 | Batch 38 |
| `repeated-failure`（重复失败） | runtime run 终局时 `RunResult.reasonCode === 'LOOP_STAGNATION'`：同一错误签名连续 N 次（`stagnationLimit`，默认 3）→ `LoopStagnation` → `runAgent` 转 `outcome: 'escalated'` 并透传 code → `needsHuman('repeated-failure', …)`。注意：loop 决策的 `ESCALATE`（`outcome: 'escalated'` 但无 code）**不**发射——只有 stagnation 这个确定性形状才发射。requiredDeciderLevel：`operator`。severity medium。 | Batch 38 |
| `high-risk-deployment`（高风险部署） | `POST /api/pipelines/:id/deploy` 停靠审批时调真实 `assessRisk`（`packages/cicd/src/risk.ts`，§41.1：un-lowerable floor，unknown → strict）：请求可带可选 `risk` 对象（严格类型校验，400 拒垃圾）；未给的信号按 assessRisk 自己的严格契约默认（booleans false、changeType ''、blastRadius 'unknown' 中性）——无信号输入按"无验证恢复路径"等真实理由评出 HIGH，不是硬编码。票据的 `risk_level` 改为**评估值**（替代硬编码 'HIGH'）；HIGH/CRITICAL 评估额外发射 `needsHuman('high-risk-deployment', …)`，source `cicd-deploy:<deploymentId>`。requiredDeciderLevel：`manager`（§8 人类审批者等级；§41.1 HIGH 需人类+专家复核）。severity high。低风险（LOW/MEDIUM）不发射，`DEPLOYMENT_RISK_ASSESSED` 审计记录评估值与 caller-provided 信号。 | Batch 39 |

写透失败一律审计 `NEEDS_HUMAN_PERSIST_FAILED`，**永不回滚**已提交的主记录（冲突记录 / run 记录）。

## 未发射（4/8）——诚实原因

| 触发器 | 勘察结论 |
|---|---|
| `requirement-ambiguity`（需求歧义） | `packages/qa/src/classify.ts` 有 `REQUIREMENT_AMBIGUITY` 分类（正则启发式）→ owner 记 `'human'` 并落 QA evidence。但这是**启发式猜测**，不是确定性状态；`QaLoop.escalated` 是通用标志不区分原因。在正则上发射等于用启发式冒充确定性——不接。 |
| `policy-violation`（策略违规） | `packages/policy` 只有**事前拒绝**（`RELATIVE_CEILING_DENIED` / `TASK_SCOPE_CEILING_DENIED` 等），代码库中**零**"违规已发生"的检测路径。拒绝 ≠ 违规，不接。 |
| `security-issue`（安全问题） | 代码库中**零**安全事件检测路径（无漏洞扫描结果、无密钥泄漏事件、无入侵信号）。无发射点，不接。 |
| `irrecoverable-env-error`（不可恢复环境错误） | Batch 39 深挖结论（维持不接，理由比 Batch 38 更精确）：① `RecoveryLoop` 本体**不是** stub——`run()` 有确定性终局（`success`/`aborted`/`escalated` + `failure.type` + history），但"环境类"一半来自 `classifyFailure`，其文件头明写 **heuristic classifier**（正则规则，confidence 0.9/0.6/0.1）；在正则上发射 = 38-4 拒绝 `requirement-ambiguity` 时的同一条"启发式冒充确定性"，标准必须一致。② `RecoveryLoop` 在 server **零生产调用者**（`apps/server/src/routes/recovery.ts` 只 import `SnapshotStore`/`classifyFailure`/`selectStrategy`）；在 loop 里接发射，生产环境永远跑不到，是"定义存在冒充实现存在"。③"重试耗尽"本身不是环境专属——对所有 failure type 都耗尽，在耗尽上不分类型发射会把 model error 误标成环境错误。真要接，需要先给环境错误一个 machine-readable 的确定性信号（如 `BudgetExceeded` 的 `code` 那样），再把 loop 接入 server 的真实调用点。**前者在 Batch 40 已落地**（`SandboxUnavailableError`/`MissingBinaryError`，code 经 `RunResult.reasonCode` 透出，`runCommandPipe` 的 spawn ENOENT 确定性映射；`assertSandboxAvailable()` 严格探针；信号层，不自动发射）；后者仍不存在，不接。 |

## 消解面

`GET /api/needs-human[/:id]`（读 viewer）、`POST /api/needs-human/:id/resolve`
（operator，人工标记 `'acknowledged'`/`'resolved'`，终端行 409）。
**永不自动消解**：authority `/resolve` 与 run 终局都不碰本表。
Open 行跨重启原样水合（终局记录，无降级）。
