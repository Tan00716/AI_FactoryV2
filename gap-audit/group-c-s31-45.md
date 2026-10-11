# Gap Audit Report — SPEC v2 §§31–45

- 审计日期：2026-10-11
- 规格基线：`~/workspace/user/files/SPEC_V2.md`（v2.0，SHA-256 `45e6c5ca…ded2b8`）
- 代码基线：`~/workspace/ai-factory`（main @ `47856d7`）
- 方法：只读审计。每章提取硬性条款（"必须/MUST/不得/恰好 N 种/至少"），到对应包源码验证导出符号与行为。不评测试覆盖率。
- 图例：✅ 完整 / ⚠️ 部分 / ❌ 缺失

## 逐章结论

| 章 | 包 | 结论 |
|---|---|---|
| §31 Takeover | takeover | ⚠️ 部分（1 小项） |
| §32 Event/Audit/Notify | events, core(audit), notifications | ❌/⚠️（6 项，envelope 与新事件类型缺失最严重） |
| §33 Tools | tools | ⚠️ 部分（2 小项） |
| §34 MCP | mcp | ❌/⚠️（4 项，negotiated version MUST 缺失） |
| §35 Skills | skills | ❌/⚠️（状态机 3/8，元数据缺项） |
| §36 Git | git | ❌/⚠️（Broker/MergeQueue/SHA 记录缺失） |
| §37 Review | review | ✅ 完整 |
| §38 QA | qa | ⚠️ 部分（1 小项） |
| §39 Artifact/Evidence | artifacts, core | ❌（8 种新 Artifact 类型缺失；其余完整） |
| §40 CI/CD | cicd | ⚠️ 部分（1 小项） |
| §41 Production | cicd | ✅ 完整 |
| §42 Incidents | incidents, autonomy, factory-control | ✅ 完整 |
| §43 Memory | memory | ✅ 完整 |
| §44 Knowledge | knowledge | ✅ 完整 |
| §45 Evaluation | evaluation | ⚠️ 部分（1 小项） |

## 缺口清单

[§31] "依据 Dependency/Impact Analysis 决定重跑集合，保留理由" → 状态：部分 → 证据：`packages/takeover/src/types.ts` 的 `TakeoverRecord` 有 `revalidatedEvidence` 列表但无决策理由字段；`returnControl()` 的重跑集合由调用方传入 `affectedEvidenceIds`，无"保留理由"的建模。

[§32] "每个事件包含 event_id, event_type, schema_version, org/project/task/run refs, aggregate_id/version, actor_id/type, correlation_id, causation_id, idempotency_key, occurred_at, recorded_at, payload, payload_hash" → 状态：缺失 → 证据：`packages/events/src/types.ts` 的 `FactoryEvent` 只有 `seq/id/type/ts/source/payload`，12 个规范字段全部缺失。

[§32] "新增 Authorization、Requirement Version、Delegation/Report、Control Epoch、Lease/Fencing、Quota/Handoff、Evidence Invalidation、Takeover、Outcome 和 Completion Invalidation" → 状态：缺失 → 证据：`packages/events/src/eventTypes.ts` 的 `EVENT_TYPES` 只有 29 个 v1 类型（注释仍引用 v1 的 §91），10 种 v2 新增类型一个都没有；全仓库无 `EVIDENCE_INVALIDATION`/`COMPLETION_INVALIDATION`/`CONTROL_EPOCH` 等事件类型定义。

[§32] "消息至少一次交付，消费者按 event_id/aggregate_version 幂等。乱序和重复消息不得完成 Gate 两次或重复 Deploy" → 状态：部分 → 证据：`packages/events/src/bus.ts` 无去重/幂等机制（`db` 包有事务 outbox，但事件消费侧无按 event_id/aggregate_version 的幂等）。

[§32] "记录身份、理由、版本、结果和摘要 Hash"＋"本地可实施 append-only 应用写入规则与 hash chain"＋"删除数据用受控 Retention/Tombstone 事件" → 状态：部分 → 证据：`packages/core/src/audit.ts` 的 `AuditRecord` 只有 `id/ts/actor/action/entityType/entityId/details`，无理由/版本/结果/摘要 Hash 字段；无 hash chain；无 Tombstone 事件（仅 `squads` 有无关的 tombstone）。

[§32] "In-app、Desktop、Webhook，以及已接入的邮件/聊天工具"＋"按 P0/Block/Approval/Quota/Completion 分类、去重、合并、重试与限流"＋"发送对象、渠道、数据范围和允许动作必须预先授权" → 状态：部分 → 证据：`packages/notifications` 只有 `in_app` 通道（注释写明 email/webhook "can be added" 即未实现）；`engine.ts`/`rules.ts` 无去重/合并/重试/限流；无发送对象预授权。

[§33] "覆盖 Filesystem、Shell、Git、Package Manager、Test/Build Runner、Browser、Database、CI、Deploy、MCP 和 Custom Tools" → 状态：部分 → 证据：`packages/tools` 的 registry 是通用注册表，`src/` 无 11 类工具的内置定义/分类枚举。

[§33] "工具输出 Schema 错误、非零退出、超时、空结果分别处理" → 状态：部分 → 证据：`packages/tools/src/types.ts` 的 `ExecutionOutcome` 只有 `SUCCEEDED/FAILED/TIMED_OUT/DENIED`，无空结果的单独建模；`executor.ts` 无 empty-result 分支。

[§34] "实现 MUST 保存 negotiated version 与 extension set" → 状态：缺失 → 证据：`packages/mcp` 全包无 "negotiat" 字样；`McpServer` 无协议版本/扩展字段。

[§34] "MCP Server 元数据：ID/Version/Provider、Source/Package Hash、Transport、Protocol Versions/Extensions、Tool/Resource/Prompt schemas、Scopes、Permissions、Trust、Approval、Network targets、Credential refs、Health、Install/Activate history" → 状态：部分 → 证据：`packages/mcp/src/types.ts` 的 `McpServer` 缺 Source/Package Hash、Protocol Versions/Extensions、Prompt schemas、Credential refs、Health、Install/Activate history（Unknown MCP 默认 BLOCK 已实现，`gate.ts:36`）。

[§34] "失联 → classify → bounded retry/circuit breaker → compatible alternative"＋"健康检查区分启动成功、协议连接、工具可用和真实执行成功" → 状态：缺失 → 证据：`packages/mcp` 全包无 circuit/retry 实现；无分级健康检查。

[§34] "限制 subprocess/stdio 继承环境、HTTP credentials、redirect、OAuth audience/scope、TLS、动态 URL 和资源大小" → 状态：部分 → 证据：`packages/mcp/src/security.ts` 只有安装时 trust 评估＋审批门控，无上述运行时限制的建模。

[§35] "状态：DRAFT、QUARANTINED、VALIDATED、EVALUATED、APPROVED、ACTIVE、DEPRECATED、RETIRED"（恰好 8 种） → 状态：缺失 → 证据：`packages/skills/src/types.ts:29` 的 `SkillStatus` 只有 `ACTIVE|DEPRECATED|RETIRED` 3 种，缺 DRAFT、QUARANTINED、VALIDATED、EVALUATED、APPROVED。

[§35] "Metadata 包含 Skill ID/Version、Description、适用条件、Source/Author、Hash、Runtime Compatibility、Required Capabilities、Trust、Evaluation、依赖、License 和 lifecycle" → 状态：部分 → 证据：`packages/skills/src/types.ts` 的 `SkillVersion` 无 Hash、Required Capabilities、依赖、License、适用条件字段。

[§36] "Git Broker 按动作控制远端、Branch、Repository 和凭证" → 状态：缺失 → 证据：`packages/git` 无 broker 实现（`src/` 只有 `git.ts`/`evidence.ts`/`protection.ts`/`taskBranch.ts`）。

[§36] "用 Merge Queue/合并候选验证处理'PR 都测试通过，但合并一起失败'" → 状态：缺失 → 证据：`packages/git` 全包无 merge queue 实现（PR 记录 `PrStore` 存在，但无合并队列）。

[§36] "Base SHA、Candidate SHA、Target SHA、Diff Hash、Artifact Digest 必须记录" → 状态：缺失 → 证据：`packages/git/src/evidence.ts` 的 `CodeChangeLogEntry` 只有 `sha/message/author/date`，5 个规范字段全部缺失。

[§36] "Dependency/Lockfile、Generated Files、Migration、Test 删除及安全配置变化都有结构化变更分类" → 状态：部分 → 证据：`packages/git` 无变更分类实现。

[§38] "对 UAT 与 Prod 配置/数据差异做检查，测试数据脱敏" → 状态：部分 → 证据：`packages/qa/src/uat.ts` 有 `driftCheck` 但无测试数据脱敏建模。

[§39] "新增 REQUIREMENT_VERSION、DELEGATION、MANAGEMENT_REPORT、RISK_ASSESSMENT、OUTCOME_RESULT、HANDOFF、CHECKPOINT、IMPROVEMENT_PROPOSAL" → 状态：缺失 → 证据：`packages/artifacts/src/types.ts` 的 `ArtifactType` 只有 19 个 v1 类型，8 种 v2 新增类型一个都没有（Evidence contract 18 字段、8 种 Gate verdict、不可变/失效追加均已实现）。

[§40] "Pipeline 支持 Build、Test、Lint、Typecheck、Security、Package、Artifact、Review/QA Gate、UAT、Release、Smoke/Observe/Outcome、Recovery" → 状态：部分 → 证据：`packages/cicd/src/types.ts` 的 `StageName` 只有 8 个（build/test/lint/typecheck/security/package/deploy/smoke）；Artifact、Review/QA Gate、UAT、Release、Observe/Outcome、Recovery 散落在 `review`/`qa`/`release.ts`/`outcome.ts` 等 sibling 模块，未接入 pipeline stage 模型（外部 CI 校验、pre-deploy 17 门、build 锁定均已实现）。

[§45] "允许 Policy 自动降低自主权、禁用缺陷版本、切换已批准 Fallback" → 状态：部分 → 证据：`packages/evaluation`＋`packages/autonomy` 无自动治理动作实现（locked domain 禁止、holdout 分离、proposal 需 human 批准均已实现；"不得自动获取 Prod Admin"因无自动治理入口而空转）。

## BLOCKED（环境限制，不算实现缺口）

- §33：Browser 在真实隔离 Profile/Host 中运行、Database 生产写经最小权限 Broker —— 需真实浏览器/隔离环境，本机无法验证。
- §33：Windows 工具探测（PowerShell/CMD、.NET 等）—— 需 Windows，本机为 Linux。
- §34：真实 MCP 服务器的协议交互、OAuth/TLS 实际握手、动态 URL 拉取 —— 需真实 MCP 服务。
- §40：真实 CI 平台 Adapter（GitHub/Azure）与认证 Webhook —— 需真实平台与凭证。
- §41：真实生产部署、Canary 真实流量、Outcome 真实业务指标 —— 需生产环境。

## 完整无缺口的章节

- §37：10 维度、4 verdict、自审禁止（资源不足显式 BLOCKED）、warning 阈值均已实现。
- §41：风险 4 级＋授权＋不可降低下限、可逆性 4 类（未知从严）、pre-deploy 17 门、canary（遥测丢失/样本不足→HOLD、可执行谓词）、feature flag（owner/expiry）、rollback 服务均已实现。
- §42：Incident 8 状态、Runbook（含预授权）、失控工具触发时隔离恢复（`planRecovery` 禁止同工具）、Factory Pause 下监控继续、Emergency Stop 禁止项均已实现。
- §43：9 类型、6 状态、5 scope、ACL 先过滤再检索、secret 扫描、禁止结论、manager 断言≠测试结果、memory 永不授权均已实现。
- §44：知识 8 状态、4 tier、Scout 6 阶段（只读 compare＋proposal）、Feed Activate/Defer/Reject、Scout 独立预算＋P4 均已实现。

## 汇总

- 审计章节：15（§§31–45）
- 确认真缺口：21 条（缺失 9， 部分 12）
- 最严重的 3 条：§32 事件 envelope＋新事件类型整体未升级（events 包仍是 v1）、§35 技能状态机 3/8、§39 8 种新 Artifact 类型缺失 —— 三者都是"v2 新增内容未落代码"，模式一致：v2 在既有包上加了新模块，但 `events`、`skills`、`artifacts` 三个包的 v2 增量被遗漏。
