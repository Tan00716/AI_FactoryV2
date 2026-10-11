# AI Factory 实现完整度审计报告 — SPEC_V2 §16–§30

- 审计范围：SPEC_V2.md 第 16–30 章（共 15 章），对照 `~/workspace/ai-factory/packages/*/src`（40 个包）及 `apps/desktop/src`、`apps/server/src`
- 方法：只读审计（grep 符号定位 → 读实现确认行为 → `node -e` 查 dist 导出辅助）。未修改任何代码，未运行构建/安装
- 审计日期：2026-10-11
- 执行方式：6 个审计子代理并行分工（A:§16–17、B:§18–19、C:§20–22、D:§23–24、E:§25–28、F:§29–30），关键高影响断言由主审计员复验确认
- 说明：子代理 B 的明细文件 `/tmp/audit-b.md` 被并行的另一审计组（§6–§10）覆盖，其 10 条缺口以 handoff 摘要为准，证据链完整

## 总览

| 章节 | 主题 | 真缺口 |
|---|---|---|
| §16 | Requirement 一等公民 | 5 |
| §17 | Task、Proposal 与准入 | 9 |
| §18 | Workflow State Machine | 8 |
| §19 | 五层完成定义 | 2 |
| §20 | Deterministic Progress Engine | 5 |
| §21 | Scheduler 与策略优化 | 7 |
| §22 | 并行执行、Lease 与 Fencing | 5 |
| §23 | Policy、Capability 与 Approval | 6 |
| §24 | Factory Runtime Control Plane | 2 |
| §25 | Harness 与 Agent Runtime Loop | 4 |
| §26 | Model Registry、Adapters 与账号 | 4 |
| §27 | Quota-Aware Factory 与 Handoff | 1 |
| §28 | Durable Execution 与 Checkpoint | 3 |
| §29 | Live Agent Observatory | 11 |
| §30 | Watchdog 与停滞诊断 | 4 |
| **合计** | **15 章** | **76 条** |

状态定义：缺失=完全没实现；部分=有骨架但缺关键字段/分支/行为；不符=实现与规格文字矛盾。

---

## §16 Requirement（5 条）

G-01. [§16] "AI 不能为加快 Done 临时更改终点" → 状态：不符 → 证据：`packages/requirements/src/manager.ts` 的 `changeCompletionTarget()`（L205）要求 HUMAN 授权，但公开方法 `newVersion(id, 'TARGET_CHANGE', note, by, mutate)`（L147）允许调用方直接改终点，HUMAN 校验被完全绕过。

G-02. [§16] "AI PM 可提 AC 细化但不能改变业务含义" → 状态：部分/不符 → 证据：`proposeAcRefinement()`（L183）的 `addsNewBehavior` 拒绝可被 `newVersion()` + 任意 `mutate` 绕过，mutate 内可自由添加新产品行为的 AC；约束只在便捷方法层，数据层无强制。

G-03. [§16] "VERIFIED_DELIVERY 仅文档/研究/开发工具/无生产环境项目可用" → 状态：部分 → 证据：`create()`（L112）只要求记录授权理由，不检查项目类别，普通软件产品变更也可声明；创建时声明 VERIFIED_DELIVERY 不要求 HUMAN 授权。

G-04. [§16] "只有经明确兼容性检查的未受影响证据可复用" → 状态：部分 → 证据：`checkEvidenceCompatibility()` 记录存在（L266）但无人消费；`checkTransitionV2`（`packages/core/src/workflow-v2.ts`）只做版本精确匹配，显式判兼容的证据仍被判 STALE。

G-05. [§16] "需求变化后暂停受影响晋级" → 状态：部分 → 证据：`analyzeImpact()` 生成 `PromotionHold`，但门控路径从不查询 `listHolds()`，holds 无强制力。

## §17 Task、Proposal 与准入（9 条）

G-06. [§17.1] Task 字段清单 → 状态：缺失（大批） → 证据：`packages/core/src/types.ts` 的 `Task` 接口缺 `display_id`、`organization_id`、`requirement_id/version`、`task_type`、`root_authorization_id`、`acceptance_criteria_refs`、`completion_target`、Task 级 `authorization_status`、`assigned_manager`、`squad`、`risk_assessment_ref`、`reversibility_class`、`budget_envelope`、`progress_plan_version`、`artifact/evidence/run_refs`、`version` 等；`workspace_id` 被实现为 `workspace: string`（名称与类型不符）。

G-07. [§17.1] "Creator、负责 Manager、当前执行者、验证者、Approver 是不同字段" → 状态：缺失 → 证据：只有 `creator` 和 `currentAgentId/assignedAgentIds`；`assigned_manager`、验证者、Approver 全无。

G-08. [§17.2] `DRAFT → TODO/WAITING_HUMAN_DISPATCH → AUTHORIZED` 与 Human Dispatch → 状态：缺失 → 证据：`packages/core/src/tasks.ts` 的 `create()` 恒以 TODO 起始，无 DRAFT；Task 级无 `authorization_status`；无 Dispatch API 与审计事件流程。

G-09. [§17.2] "Operational 预授权票记录触发政策与 Rule ID" → 状态：缺失 → 证据：全包 grep 预授权票/Rule ID 字段零命中。

G-10. [§17.3] Proposal 流程 → 状态：缺失（整块） → 证据：`packages/employee-factory/src/proposals.ts` 是 §59 组织提案，`packages/evaluation/src/proposals.ts` 是 §58 改进提案；§17.3 的 `PROPOSED → EVIDENCE_REVIEW → HUMAN_OR_POLICY_DECISION → AUTHORIZED_TASK | REJECTED | DEFERRED` 状态机及字段整块无实现。

G-11. [§17.4] 子任务继承与 Scope Checker → 状态：缺失 → 证据：`createSubtask()` 只继承 `projectId`/`parentTaskId`，不继承 root authorization/需求版本/AC/政策上限/预算；无 Scope Checker 实现。

G-12. [§17.5] 外部依赖（Deadline/Owner/失败取消策略） → 状态：缺失 → 证据：`TaskDependency = { kind, taskId }` 无外部依赖类型。

G-13. [§17.5] "依赖取消不能自动满足后继 Gate" → 状态：缺失 → 证据：`P_DEPS_READY` 门控只是调用方传入的布尔值（`workflow-v2.ts`），无依赖取消语义。

G-14. [§17.1] "Parent Task 引用不可成环" → 状态：部分（轻微） → 证据：`addDependency()` 有环检测，但 `parentTaskId` 本身无环检测（无 `setParent` API，结构上难成环，影响小）。

## §18 Workflow State Machine（8 条）

G-15. [§18.2] Transition 定义字段 → 状态：部分 → 证据：`packages/core/src/workflow-v2.ts` 的 `TransitionDefV2` 无 `escalation`、`evidenceInvalidationRules` 字段；`intent` 为单动作而非 Allowed Actions 列表。

G-16. [§18.2] "引擎检查 Lease" → 状态：部分 → 证据：GatePredicate 无 Lease 检查项，`GateContext` 无 lease 字段；"workspace lease valid" 只写在 entryConditions 文字里。

G-17. [§18.2] "成功后更新状态与 Outbox" → 状态：部分 → 证据：`requestTransitionV2` 成功只做 `mutate` + audit，无 Outbox 写入；全仓 `outbox` 零命中。

G-18. [§18.2] "Board 拖拽调用同一 Transition API" → 状态：缺失 → 证据：Board 拖拽调 `POST /api/tasks/:id/transition` 走 v1 引擎；`WorkflowEngineV2` 在 `packages/core` 之外零引用（已复验）——v2 引擎是未接线的死代码。

G-19. [§18.2] "无权直接写状态字段" → 状态：不符 → 证据：`engine-v2.ts` 的 `get(taskId)` 直接返回内部 `TaskV2State` 可变引用（已复验），调用方可绕过门禁直接改 `stage`/`condition`/`milestones`。

G-20. [§18.1] 无适用 UAT/PROD 的版本化工作流与 N/A 依据 → 状态：部分 → 证据：单一 13 阶段线性图无 N/A 跳过边，`VERIFIED_DELIVERY` 任务仍须走完生产阶段；`releaseNaAuthorized` 只是 `finalize` 入参布尔值，不持久化、不审计。

G-21. [§18.3] QA_FAILED/UAT_FAILED/PROD_FAILED/ROLLBACK 带上下文事件与 UI 标签 → 状态：缺失 → 证据：v2 无失败事件记录/发射机制；`failureConditions` 声明了从未被应用。

G-22. [§18.3] 取消语义 → 状态：缺失 → 证据：无 `cancelTask`；`setCondition(CANCELLED)` 只改字段，不停新工作、不回收授权、不协调副作用、不报告留存 Artifact。

## §19 五层完成定义（2 条）

G-23. [§18.1/§19] Board 显示精确阶段和异常 Badge → 状态：部分 → 证据：`apps/desktop/src/components/Board.tsx` 基于 v1 状态，无 `OUTCOME_VERIFICATION` 列；卡片只显示 status 文本，无基于 v2 Condition 的异常 Badge。

G-24. [§19] "UAT 与 Merge 生成的新组合 Revision 仍需重新验证" → 状态：缺失 → 证据：`staleEvidenceIds`/`evidenceReqVersions` 全仓无生产代码填充；candidate 变化后旧 PASS 不自动标 stale；`TransitionDefV2` 无 Evidence Invalidation Rules 字段。

## §20 Progress Engine（5 条）

G-25. [§20] "c_i 来自有效 Evidence；耗时/Token 数不能直接产生完成比例" → 状态：部分 → 证据：`packages/progress/src/engine.ts` 的 `computeProgress()` 接受 `evidenceRef: null` 且不校验有效性，无法阻止调用方用耗时/Token 推导 c。

G-26. [§20] "完成封印为单独权重最终项" → 状态：部分 → 证据：引擎不强制计划含 `kind: 'seal'` 项；无 seal 项的计划可达 100%。

G-27. [§20] "Planning 完成后锁定 weight_plan_version" → 状态：缺失 → 证据：仅 `types.ts:31` 一行注释，全仓无线定函数、无触发调用点。

G-28. [§20] "团队进度按目标工作权重聚合" → 状态：缺失 → 证据：无团队聚合函数；`teamProgress`/`aggregateProgress` 零命中。

G-29. [§20.4] 票显示 `% + current_gate + calculation_version + updated_at`；可展开 Blockers/Critical Path → 状态：部分 → 证据：`ProgressReport` 无 `currentGate` 字段；Critical Path 全仓无实现；阶段/顶层进度分开展示无实现。

## §21 Scheduler（7 条）

G-30. [§21] 九项调度硬约束先通过 → 状态：部分 → 证据：`packages/orchestrator/src/scheduler.ts` 的 `nextBatch()` 只检查 Dependency + 并发槽位；无统一调度前门禁。

G-31. [§21] "默认等级 P0–P4" → 状态：不符 → 证据：`scheduler.ts` 的 `SchedulerPriority` 只有 P0–P3（已复验），与 `core`/`resources` 两处 P0–P4 定义矛盾。

G-32. [§21] 多上级排队（Severity/SLA/Critical Path/风险/容量/Fairness；无效权力先拒绝） → 状态：缺失 → 证据：只有 priority+FIFO；无 SLA/Critical Path/风险/Fairness；`enqueue()` 无权力校验。

G-33. [§21] Aging / P0 安全点抢占 / 迁移保护 / 预留容量 → 状态：缺失 → 证据：无 aging；`packages/resources/src/gate.ts:7` 注释 "never preempts an already-running agent" 与 P0 抢占直接矛盾；预留容量/安全余量无实现。

G-34. [§21] Execution Strategy Optimizer + Human Override 解释拒绝 → 状态：缺失 → 证据：全仓无 `Optimizer` 符号；无 Override 机制。

G-35. [§21] 预算维度与原子 reserve→charge→settle/release；unknown 单列 → 状态：部分 → 证据：`BudgetDimension` 缺货币、CPU/RAM；只有 `consume()` 无原子流程；无 unknown 单列。

G-36. [§21] "超限进入 BUDGET/RESOURCE_BLOCK" → 状态：缺失 → 证据：`TaskConditionValue` 无 BUDGET/RESOURCE_BLOCK 取值；超限只抛 `BudgetExceededError`。

## §22 并行/Lease/Fencing（5 条）

G-37. [§22] 独立 Worktree/Branch/Clone；单 Owner；QA 只读副本；非 Git 快照流程 → 状态：缺失 → 证据：全仓无 worktree/branch/clone 分配实现；`packages/git/src/git.ts` 只是命令封装。

G-38. [§22] "Git 管理动作经可信 Broker 或独立 Clone" → 状态：部分 → 证据：`git.ts` 直接执行 git 命令，无 Broker 层、无独立 Clone 路径。

G-39. [§22] 全局排序锁顺序和超时；默认一次发布；多环境事务/补偿 → 状态：部分 → 证据：`locks.ts` 有排序和六种锁，但 `acquireAll()` 的 `timeoutMs` 实际不等待（`void deadline`）；"一次发布"只是 key 格式约定；多环境补偿无实现。

G-40. [§22] "fencing token 在最终写入/部署时校验" → 状态：不符 → 证据：`LeaseManager.validate()` 与 `WriterLeaseGuard.validateWriter()` 全仓零调用；`db/transactions.ts` 的 `deployScript()` 取 token 后在最终 `broker-execute` 前从不重校验——过期/被接管的旧 owner 仍可执行。

G-41. [§22] 合并前 Base/Candidate/Target SHA 比对；force-push/reset 限制 → 状态：部分 → 证据：`coordination/overlap.ts` 只有路径重叠检测，无 SHA 比对、无合并任务生成；force-push/reset 限制无实现。

## §23 Policy/Capability/Approval（6 条）

G-42. [§23.2] Capability Token 绑定字段与签发交集 → 状态：部分 → 证据：`CapabilityGrant`（`packages/tools/src/types.ts:59-69`）只有 id/principalId/actions/resourcePrefixes/expiresAt/revoked；缺 Org/Project/Task/Run/环境/数据范围/网络目标/参数约束/次数/revocation epoch/fencing token；无签发（mint）函数，无四方交集计算。

G-43. [§23.4] Tool Approval 级别命名与执行点强制 → 状态：不符 → 证据：`approvals` 包用 `'AI_REVIEW'` vs 规格 `'AI_REVIEW_PLUS_POLICY'`（`tools` 包用对，两包矛盾）；`executor.ts:130` 只拦 BLOCKED（已复验），HUMAN_APPROVAL/AI_REVIEW_PLUS_POLICY 工具直接执行，无 ApprovalManager 接线。

G-44. [§23.4] "AI Review 贡献结构化评估、系统做最终授权" → 状态：缺失 → 证据：全仓 grep 零命中，无评估→授权管线。

G-45. [§23.4] Exception Grant → 状态：缺失 → 证据：全仓无 `exceptionGrant` 符号；无可豁免/不可豁免区分；无 FAILED/WAIVED 豁免记账。

G-46. [§23.3] 批准后风险实质变化失效 → 状态：部分 → 证据：`invalidate()` 的 `ApprovalBindingContext` 只比对 candidate_digest/evidence_manifest_hash/policy_version/environment；`risk_level`/`reversibility_ref` 变化不触发失效。

G-47. [§23.1] "只有标注可覆盖的默认项可被授权下级设置" → 状态：部分 → 证据：`PolicyStore.set()` 无调用方身份/授权参数；"授权下级"无校验点。

## §24 Control Plane（2 条）

G-48. [§24.4] UI/后台生命周期分离；关闭 UI 配置；Sleep/Shutdown 心跳；恢复 reconciliation → 状态：缺失 → 证据：无 UI 关闭模式配置；无睡眠/关机感知 API；`durable.ts` 的 `reconcile()` 属 §28 非控制平面恢复路径。

G-49. [§24.3] "事故源是安全服务本身则隔离并保留最小可信告警路径" → 状态：缺失 → 证据：`FactoryController` hooks 只有 revokeExecution/terminateManagedTrees/markExternalUnknown；全仓无相关实现。

## §25 Harness（4 条）

G-50. [§25] Harness 管理 13 项 → 状态：部分 → 证据：`packages/runtime/src/harness.ts` 只实现 Tool Routing/Permissions/Workspace/Timeout/Evidence/Tracing；Context/Model Calls/Memory Retrieval/State/Workflow Requests/Budget 在 runtime 内无实现。

G-51. [§25] 8 个限额执行 → 状态：部分 → 证据：`BudgetTracker` 在 `limits.ts` 定义，但 `runner.ts` 默认路径只传 3 个限额；`consumeModelCall`/`consumeToolCall` 等全仓无调用，限额未被执行。

G-52. [§25] 防权限绕过守卫 + 带总预算 jitter 重试 → 状态：部分 → 证据：`failures.ts`/`limits.ts` 有实现但全仓零调用，是死代码；`runTool` 不重试、不调守卫。

G-53. [§25] Step 执行前持久化 intent → 状态：部分 → 证据：仅调用方传入可选 `intentStore` 时生效；默认 `runAgent` 路径未接线；`StepIntentStore` 为内存 Map，无 DB 持久化、无启动扫描。

## §26 Model Router（4 条）

G-54. [§26.2] Adapter 契约 10 方法 + UNSUPPORTED 语义 + 版本协商 + Contract Tests → 状态：缺失 → 证据：`RuntimeAdapter` 只有 `{name, invoke}`；十个方法名全仓零命中；`CodexAdapter` 占位。

G-55. [§26.1] Authentication Profile 独立保存 → 状态：缺失 → 证据：`ProviderProfile` 只是类型声明；`getAccountStatus` 返回占位值；无存储/读取 API。

G-56. [§26.1] Model Capability Metadata 字段 → 状态：部分 → 证据：`ModelCapabilities` 只有 reasoning/vision/tools/maxContext；缺结构化输出/Streaming/Cancellation/Resume-Session/数据分类/Privacy/Quota Bucket/Supported Host。

G-57. [§26.3] 人工指定 Primary/Fallback/Reasoning/Provider Lock；Router 先查 Capability/Privacy/Permission → 状态：部分 → 证据：`RouteRequest` 无人工指定字段；router 未查 Permission；fallback 数据分类守卫未接线；`router.ts` 硬编码种子模型名（TASK_FIT/`pickEmergency`），与"不硬编码模型名"矛盾。

## §27 Quota（1 条）

G-58. [§27.3] Handoff Package 全字段 + 替代模型 consistency check → 状态：部分 → 证据：`REQUIRED_FIELDS` 只强制 17 字段，decisions/SHA/commands/tests/failures/risks/预算等运行时不校验；consistency check 全仓无实现。

## §28 Durable（3 条）

G-59. [§28.1/28.2] 持久化事实 + Control Plane 事务/Outbox + 启动扫描 → 状态：部分 → 证据：`OperationLedger`/`StepIntentStore` 逻辑完整但内存 Map、无持久化、无消费者；db 缺 external_ops/step_intents/checkpoints/delegations/gates/pending_side_effects 表；Control Plane 事务与 durable.ts 未接线；无启动扫描。

G-60. [§28.3] Resume 重校验授权/政策/需求/凭证/Host → 状态：缺失 → 证据：`loop.ts` 的 `resume()` 只恢复计数器；`resumePreconditions` 只是字符串数组，无校验例程。

G-61. [§28.4] App Restart 先发现存活 Worker/外部作业、处理旧 Lease 再 Resume → 状态：缺失 → 证据：leases 无 worker 发现/存活探测；无"启动→发现→处理旧 lease→resume"编排。

## §29 Observatory（11 条）

G-62. [§29.1] Strip 含 Start/Pause/Freeze/Drain/Stop/Emergency controls → 状态：缺失 → 证据：`OpsPanel` 纯展示；desktop 无按钮/API 方法；服务端 `POST /api/factory/control` 存在但 UI 零入口。

G-63. [§29.1] Agent running/idle/blocked/failed 计数 → 状态：部分 → 证据：`computeStatus` 只统计 runningAgents；idle/blocked/failed 无统计。

G-64. [§29.1] Tasks by gate → 状态：缺失 → 证据：只有 activeTasks/blockedTasks；无按 gate 分组聚合。

G-65. [§29.1] Scheduler/Workflow/Worker/CI/DB 健康 → 状态：部分 → 证据：OpsPanel 只有 watchdog 健康/quota/incidents/deployments；无 Scheduler/Workflow/Worker/DB 健康行。

G-66. [§29.2] Agent detail 实时字段集 → 状态：缺失 → 证据：desktop 唯一的 `EmployeeDetail` 是 §87 静态档案；Heartbeat/Host/PID/CPU/RAM/Runtime/Last File/Tool Activity 等 §29.2 字段一个都没有。

G-67. [§29.2] Pause/Take Control/Stop/Terminal/Diff/Trace/Artifacts/Evidence 统一入口 → 状态：缺失 → 证据：desktop 无 pause/take-control/stop 入口（takeover 后端存在但 UI 零入口）；Terminal/Diff/Trace/Evidence 散落各面板。

G-68. [§29.3] Manager drill-down 团队视图 → 状态：缺失 → 证据：`OrgGraph` 节点弹窗只有姓名/状态/职级/下属数；无委托/Blockers/Critical Path/审批等聚合。

G-69. [§29.3] 横向报告图切换 → 状态：缺失 → 证据：`OrgGraph` 只渲染主树；squads 包有横向关系类型但 desktop/server 未用。

G-70. [§29.4] UI 从持久事件/投影得实时数据 → 状态：不符 → 证据：`packages/events/src/bus.ts` 是内存 EventBus（retention 1000，重启丢失）；db 无事件投影表。

G-71. [§29.4] 六维过滤 + 分页 + 虚拟列表 → 状态：部分 → 证据：`EventsPanel` 只支持 event type 过滤；无 Org/Project/Task/Agent/Run/Time 过滤、无分页、无虚拟列表。

G-72. [§29.4] 权限限制横向团队信息 → 状态：缺失 → 证据：`OrgGraph`/`WorkforcePanel` 无权限过滤。

## §30 Watchdog（4 条）

G-73. [§30] 健康输入含 Expected Duration/进度检查点/历史 Baseline → 状态：缺失 → 证据：`WorkerSignals` 无 expectedDuration/progress checkpoint/baseline 字段；`lastModelStreamAt` 声明了但 `watchdog.ts` 从未消费（死字段）。

G-74. [§30] Model/Build/QA 各自 deadline 与 progress signal → 状态：缺失 → 证据：`ThresholdOverride` 只调 heartbeat 三阈值，非阶段 deadline。

G-75. [§30] "Watchdog 状态转换和 Kill 请求也经 Policy" → 状态：部分/不符 → 证据：`requestRecovery` 走 policyGate 但 `tick()` 健康派生不经过；服务端 `apps/server/src/routes/watchdog.ts:21` 的 `policyGate: () => true` 是恒真桩（已复验），kill/restart 实际不受 Policy 约束。

G-76. [§30] 恢复失败保留现场 Artifact → 状态：缺失 → 证据：`onNotify` 只有字符串消息；`RecoveryRecord` 无 artifact 快照逻辑。

---

## 已确认实现的关键项（非缺口，抽查）

- §16：Requirement 版本 append-only；AC 稳定 id/version/验证类型/责任/预期证据/适用环境；`analyzeImpact` 做 AC diff 与证据切分；默认 RELEASED_OUTCOME。
- §17：四种依赖 + `parallel_with`；`addDependency` 环检测与缺引用校验；`ActorAuthorization` 四值；`P_AUTHORIZED` 门控。
- §18：13 阶段枚举；三态分离存储；7 个 AI 动作；非法 Jump/并发旧请求/重复事件三件套；16 个 reason codes；Condition 十值 + reason/resume_state/blocked_on。
- §19：五 Milestone 精确定义；`recordRollback`（历史保留 + ROLLED_BACK + outcomeGateValid=false）；`invalidateCompletion`（COMPLETION_INVALIDATED 追加不改历史）。
- §20：进度公式与 34% 示例实测通过；`finalize()` 先独立检查谓词再单事务提交 DONE + finalSeal=1；返工下调 c；权重守恒拆分。
- §21：`BudgetTracker.requestIncrease/resolveIncrease` 审批分离；`BudgetLedger.reserve` 原子防超卖。
- §22：Lease 六字段；`reassign()` 递增 generation + fencing_token；过期/被接管 renew/validate 抛 `STALE_OWNER`（库层面完整，缺调用接线见 G-40）。
- §23：Policy 七层 merge（deny 优先/最严格数值/锁定规则/policy_hash/评估输入/规则命中）；Approval 16 字段 + 6 状态 + invalidation；**DEF-001 两处修复确认存在**。
- §24：三轴独立存储；8 操作 × 3 列语义矩阵；PAUSE_NEW_WORK vs PAUSE_AI_WORK 区分；control_epoch 自增；ACK 齐全才显示终态；Emergency Stop 禁止项。
- §25：6 阶段循环；12 种 Run 状态；LOOP_STAGNATION（3 次可配 + 无新增证据语义）；故障六分类；外部动作五态机与三分支 reconcile。
- §26：限额事件五分类；三 Quota Policy；`checkFallbackCompatibility` 四项检查（未与 router 接线见 G-57）。
- §27：Handoff 脱敏 + 验 Hash + 防双写；额度命中时已启动确定性工具继续的五约束。
- §28：CheckpointV2 十三字段；`StorageGuard`（磁盘满停危险副作用 + 应急日志）。
- §30：Health 8 枚举；approval-wait 非 stall（三处实现）；心跳默认 5s/3 次/60s；阈值按 tool/host 配置 + 版本记录；诊断 7 分类；watchdog 自身健康/熔断/失败通知。

---

## BLOCKED（环境限制，非缺口）

1. "体验更好"类表述转可测条件：属 AI PM 运行时行为，代码无法可靠判定自然语言可测性。
2. AI 自发现问题等待 Human Dispatch：属 AI 运行时行为约束，非代码可强制。
3. Human Dispatch / 真实审批人身份 / UAT：需真实 Human 参与验证。
4. 默认暂停按钮（Pause New Work）属纯 UI 要求；单机 Sleep/Shutdown 的 OS 级事件监听需真实桌面环境。
5. 真实 Provider 接入（Codex app-server / OpenAI API / 本地模型真实推理）与供应商 quota 查询：需外部网络与凭证。
6. 真实 CPU/RAM 采集：需目标 Worker Host 上的采集探针。
7. 持久事件投影与 Live 传输端到端行为：需运行中 DB/事件存储及 server+desktop 联调。

---

## 优先修复建议（授权/安全相关，最值得先修）

1. **G-43**：HUMAN_APPROVAL/AI_REVIEW_PLUS_POLICY 工具在执行点零检查——高风险工具批准级别形同虚设，且两包级别字符串互相矛盾。
2. **G-18/G-19**：v2 Workflow Engine 未接入任何服务端点（死代码），且 `get()` 返回可变引用可绕过门禁——门禁体系有两处结构性 bypass。
3. **G-40**：fencing token 在最终写入前不重校验——过期/被接管的旧 owner 仍可执行部署。
4. **G-75**：服务端 watchdog `policyGate` 恒真桩——kill/restart 实际不受 Policy 约束。
5. **G-42**：Capability 无签发函数、无交集计算——签发侧无约束点。
