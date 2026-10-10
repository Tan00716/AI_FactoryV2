# AI Factory v1 → SPEC_V2 差距矩阵（Gap Analysis）

- 分析日期：2026-10-10
- 基线规格：`~/workspace/user/files/SPEC_V2.md` v2.0（59 章，INV-01–INV-35）——已完整替代 v1.0（`AI_factory.txt`）
- 被测实现：`~/workspace/ai-factory/`，30 个 packages（ls 实得 30 个，任务简报称 29）
- 方法：通读 SPEC_V2 全文 1778 行；逐包读取 `src/index.ts` 导出 + 核心文件头注释；关键硬化点已用 grep 亲手核实代码位置
- 判定：COVERED（满足 v2）/ PARTIAL（有但弱于 v2，注明差在哪）/ MISSING（无对应实现）/ N/A（规格信息性章节，非实现项）
- 铁律：只写实际看到的；拿不准的标 NEEDS_REVIEW

## 摘要统计

| 状态 | 数量 | 章号 |
|---|---|---|
| COVERED | 2 | §5, §53 |
| PARTIAL | 43 | §1–§4, §6–§15, §17, §18, §21, §22, §23(.1–.4), §25–§29, §32, §34–§41, §43–§50, §52, §59 |
| MISSING | 11 | §16, §19, §20, §24, §30, §31, §33, §42, §51, §54, §55 |
| N/A（信息性） | 3 | §56, §57, §58 |

**已知严重缺陷**：DEF-001（审批管理器未强制策略，`packages/approvals/src/manager.ts`）——已并入 §23.3 硬化。

## 逐章差距表

| 章 | 标题 | 状态 | 对应包 | 差距描述 |
|---|---|---|---|---|
| §1 | 最终产品定义 | PARTIAL | 全体 | 自主闭环在 demo 层走通；缺真实模型/真实执行，Authorized Outcome Completion Rate 无实际度量 |
| §2 | 原则与 INV-01–INV-35 | PARTIAL | core/policy/security | 多数不变量有代码对应（INV-03 状态机、INV-04 门禁、INV-12 无 LLM 进度）；缺：INV-05 全路径覆盖未证、INV-15 真实隔离缺失、DEF-001 违反 INV-02/INV-05 |
| §3 | 范围与自主权 | PARTIAL | autonomy | `decide()` 风险矩阵、`needsHuman()` 8 触发器、`approval-bridge` 存在；缺：发现工作→TODO+WAITING_HUMAN_DISPATCH 的强制链路未见代码 |
| §4 | 架构（控制/执行/安全面分离） | PARTIAL | runtime/apps/server | server+runtime adapter 分层存在；缺：远程 Host、安全运行域（Safety plane）、控制面/执行面认证隔离 |
| §5 | 模块边界 | COVERED | 全体 | 30 个包与 §5 模块表基本对应 |
| §6 | 项目与项目发现 | PARTIAL | projects | 只读发现✓、5 模板✓、不覆盖非空目录✓、诊断记录✓；缺：Project Profile 版本化、`profile_version` 等记录字段不全 |
| §7 | 真实隔离 | PARTIAL | security | `sandbox.ts` 有 local/strong 两档、目录逃逸拦截✓（P1 探针通过）；缺：**真实 OS 级隔离后端抽象**（无 VM/受限 OS 账户/JOB 验证）、`confinement_verified_at`、CONFINEMENT_UNAVAILABLE fail-closed（§7.5） |
| §8 | 身份、角色与 Authority | PARTIAL | policy | `checkCapability`/`canPerform`/`DEFAULT_DENIED_CAPABILITIES` 存在；缺：RBAC 角色绑定模型、Authority→Policy→Scheduler 冲突仲裁引擎、revocation epoch（NEEDS_REVIEW：server 层是否有仲裁） |
| §9 | 混合组织图 | PARTIAL | squads | `OrganizationDesigner` 存在；缺：9 种边类型及权限语义、方向约定（MANAGES 为反向投影）、图版本化、环检查 |
| §10 | AI Employee | PARTIAL | core/employee-factory | AgentRegistry+模板创建✓；缺：Employee Version 完整字段、生命周期 DRAFT→…→ARCHIVED、autonomy 0–5 分级、Run 版本 pinning（NEEDS_REVIEW：factory 治理细节） |
| §11 | 指令与上下文组装 | PARTIAL | runtime/comms | Harness 有上下文管理；缺：版本化 Instruction Manifest（来源/版本/Hash/信任类别）、平台锁定不依赖 Prompt 的声明式边界 |
| §12 | Management Runtime | PARTIAL | orchestrator | `decideNextAction`/`Scheduler`/`decompose`/选人评分✓；缺：Delegation 对象完整字段、scope⊆父级强制、预算从父预留 |
| §13 | 动态员工与 Task Squad | PARTIAL | employee-factory/squads | 创建治理+数量/深度限制✓、Squad 归档✓；缺：idle 员工计入上限、跨项目复用新 Scope、预算上限 |
| §14 | 结构化报告 | PARTIAL | comms | 8 种消息原语、report payload、`TaskTrace`✓；缺：schema 2.0 全字段、系统附加计算进度（非 LLM）、报告序号/引用校验 |
| §15 | 升级与争议 | PARTIAL | autonomy/evaluation | `evaluateEscalation()`+`DisputeCoordinator`✓；缺：`DISPUTED` Gate 状态、升级策略链（到 Security/Human）、P0 独立通知路径 |
| §16 | Requirement 一等公民 | MISSING | — | 无 Requirement 实体：无不可变版本、无 AC 稳定 ID、无影响分析、无 `completion_target`（IMPLEMENTATION/VERIFIED_DELIVERY/RELEASED_OUTCOME） |
| §17 | Task、Proposal 与准入 | PARTIAL | core | Task/依赖 DAG/环检查✓；缺：`authorization_status`（DRAFT→TODO/WAITING_HUMAN_DISPATCH→AUTHORIZED）、Proposal 生命周期、子任务 Scope Checker |
| §18 | 工作流三态分离 | PARTIAL | core | `types.ts`：12 阶段+8 异常态✓，transition 合约✓；缺：**Condition 独立字段**（10 值）、**Lifecycle Milestones 独立字段**（5 层）、OUTCOME_VERIFICATION 阶段（现有 12 阶段无此项） |
| §19 | 五层完成定义 | MISSING | — | 无 Milestone 概念；DONE 为终态但无 final_seal；缺：DONE 与 final_seal 同事务、ROLLBACK→ROLLED_BACK、`COMPLETION_INVALIDATED` 追加历史 |
| §20 | 确定性进度引擎 | MISSING | — | 无权重进度引擎；dashboard 仅做聚合展示，无 `100×Σ(wᵢcᵢ)/Σwᵢ`、无 weight_plan_version、无失效下降 |
| §21 | 调度与预算 | PARTIAL | orchestrator/resources | 调度器+BudgetTracker 硬拒绝+超支升级✓；缺：原子 reserve→charge→settle/release（`tracker.ts` 只有 set/consume）、并发不超卖、公平 aging、P0–P4 等级 |
| §22 | 并行、Lease 与 Fencing | PARTIAL | coordination | DAG 调度+文件重叠检测+TTL LockManager（6 种锁）✓；缺：**durable Lease**（generation+fencing_token）、STALE_OWNER 拒绝、最终执行点 fencing 校验 |
| §23.1 | 策略合并 | PARTIAL | policy | 7 层 PolicyStore✓；**语义错误**：`store.ts:111` "merge layers top-down, upper wins" ≠ v2 要求的**限制交集**（deny 优先、数值取最严） |
| §23.2 | Capability Token | PARTIAL | policy | capability 检查引擎✓；缺：绑定维度（过期、单次/次数、revocation epoch、fencing token、参数约束） |
| §23.3 | 审批对象 | PARTIAL | approvals | 生命周期 PENDING→…✓；**DEF-001**：`manager.ts` `request()` 不查策略（BLOCKED 可建）、`decide()` 不校验 `decidedBy` vs `requiredApprover`；缺：action_digest/candidate_digest 绑定、变更后 INVALIDATED |
| §23.4 | 高风险与豁免 | PARTIAL | approvals/policy | `TOOL_APPROVAL_LEVELS` 含 BLOCKED✓；缺：Exception Grant 模型、WAIVED 保留 FAILED 痕迹（不改 PASS） |
| §24 | Factory 三轴控制 | MISSING | — | 无 control_state/health_state/capacity_state 三字段；无 control_epoch；无 Worker ACK；无 PAUSE NEW WORK / PAUSE AI WORK / FREEZE / DRAIN / EMERGENCY STOP 语义区分 |
| §25 | Harness 与 Agent 循环 | PARTIAL | runtime | AgentLoop（OBSERVE→…→EVALUATE）+预算/停滞/checkpoint✓；缺：12 种 Run 状态、LOOP_STAGNATION 可配置判定、SUCCEEDED≠DONE 的显式隔离 |
| §26 | 模型注册与 Adapter | PARTIAL | model-router/runtime | provider-independent 路由✓（硬约束→打分）；缺：Adapter 契约（discoverCapabilities/getQuota/startSession/runTurn/streamEvents/cancelTurn/exportCheckpoint/recoverSession/closeSession）；`CodexAdapter` 为占位抛 `AdapterNotImplemented` |
| §27 | Quota 与 Handoff | PARTIAL | model-router | fallback 路由✓；缺：**quota 模型**（provider/bucket/用量窗口）、三策略（STRICT_PROVIDER/ALLOW_COMPATIBLE_FALLBACK/GLOBAL_PAUSE_ON_PRIMARY_LIMIT）、Handoff Package |
| §28 | 持久执行与对账 | PARTIAL | recovery/runtime | 快照（真实 FS 写入）+恢复编排✓；缺：外部动作三态（PREPARED→DISPATCHED→CONFIRMED_*/UNKNOWN）、幂等键、Outbox、重启 reconciliation |
| §29 | 观察台 | PARTIAL | dashboard/apps/desktop | 聚合引擎✓（无数据诚实 null）；缺：Factory Strip（控制/健康/容量）、Agent 详情字段、Manager drill-down、断线 stale 语义 |
| §30 | Watchdog | MISSING | — | 无独立 Watchdog：无 heartbeat 5s/3 次 SUSPECTED_STALL/60s STALLED 判定、无诊断分类、无熔断限流 |
| §31 | Human 接管 | MISSING | — | 无 Takeover 流程：无 quiesce、无 writer lease 撤销/fence、无 TAKEOVER_PENDING、无 `author_type=HUMAN` 修改记录、无 Return Control 对账 |
| §32 | 事件、审计与通知 | PARTIAL | events/core/notifications | EventBus（内存）+AuditLog+secret 脱敏✓；缺：完整事件信封（idempotency_key/causation_id/payload_hash 等）、事务+Outbox、hash chain、通知去重/限流/无秘密 |
| §33 | 工具注册表 | MISSING | — | 无 Tool Registry 包：无工具元数据（副作用分类/幂等/取消支持）、无统一执行审计；`projects.WorkspaceExecutor` 仅为项目级执行器 |
| §34 | MCP 注册表 | PARTIAL | mcp/security | 注册表+信任评估+审批门+unknown=BLOCK✓；缺：协议 2026-07-28 协商版本保存、per-request capability negotiation、旧 Server 兼容层 |
| §35 | Skills | PARTIAL | skills | 注册表+生命周期+发现管线+安装安全扫描✓；缺：SKILL.md 包格式（references/scripts/assets）、Agent 自建技能提案→评测→发布流（`proposals.ts` 仅覆盖 agent 生命周期） |
| §36 | Git | PARTIAL | git | CLI 薄封装+任务分支+分支保护+PR store✓；缺：Git Broker（远端/凭证管控）、Merge Queue、变更分类强制（删测试提 CI 的拦截在 review 启发式层） |
| §37 | Code Review | PARTIAL | review | 10 维度+verdict 聚合+门禁证据✓；缺：独立性强制（不同执行身份、Gate Store 实现者不可写、自审唯一 Reviewer 时 BLOCKED） |
| §38 | QA | PARTIAL | qa | QaLoop+失败分类+修复循环+ specialists✓；缺：机器可读报告（环境指纹）、skipped≠PASS 强制、Flaky quarantine（owner+expiry）、UAT 业务验收定义 |
| §39 | 证据契约 | PARTIAL | core/artifacts | 封印不可变✓（`EvidenceSealedError`）；缺：**契约全字段**——`CreateEvidenceInput` 仅 5 字段（taskId/type/title/payload/createdBy），缺 requirement_version/AC_refs/candidate_revision/build_digest/test_definition_hash/environment_fingerprint/collector_identity/trust_level/validity_state/lineage；缺 Gate 8 verdict、代码谓词求值器 |
| §40 | CI/CD 与环境 | PARTIAL | cicd | 8 阶段 pipeline+环境管理+ReleaseManager+自动回滚✓；缺：可复现构建（digest/SBOM/attestation）、外部 CI 认证 webhook/result 校验 |
| §41 | 生产发布 | PARTIAL | cicd/autonomy | 审批门禁+生产就绪检查+回滚✓；缺：风险 4 级评估、可逆性 4 分类、渐进发布（cohort/样本/阈值/promotion-abort 规则）、观察窗口、OUTCOME_VERIFIED |
| §42 | 事故管理 | MISSING | — | 无 Incident 实体/生命周期（DETECTED→…→CLOSED）、无 Runbook 模型、无预授权自动恢复 |
| §43 | 记忆引擎 | PARTIAL | memory | 去重/过期/置信度衰减/verify/Lesson✓；缺：5 scopes 的 ACL、检索前 scope/security 过滤（先过滤后检索）、冲突处理、跨项目撤销同步 |
| §44 | 知识引擎 | PARTIAL | knowledge | 层级回退+生命周期+Scout 管线+Feed✓；缺：Scout 默认 handler 为占位规则（verify 数数、evaluate 按长度打分），来源可信度体系弱 |
| §45 | 评测与自改进 | PARTIAL | evaluation | 指标+画像+Lesson+提案状态机+争议裁决✓；缺：holdout 分离、Golden Harness 不可改边界、自动治理上限（不自动升权） |
| §46 | 安全 | PARTIAL | security | SecretRef 引用+脱敏+注入分类+扫描器✓；缺：OS Credential Store 真实接入（现为引用模型）、Electron 主进程加固核验（NEEDS_REVIEW）、供应链签名 |
| §47 | 快照、备份与保留 | PARTIAL | recovery | 快照 seal/verify/restore（真实 FS）✓；缺：DB 一致性备份、外部恢复点、恢复验证 Gate、RPO/RTO 演练、Retention 策略、归档/删除规则 |
| §48 | 数据模型 | PARTIAL | db | SQLite（node:sqlite）+ 11 表✓；缺：Outbox 表、单 Writer 强制、FK/环检查约束、migration 机制、预算原子性（`db` 包无 tests） |
| §49 | API 契约 | PARTIAL | apps/server | 26 路由组全✓（54/54 冒烟通过）；缺：**统一信封**（schemaVersion/idempotencyKey/expectedVersion/服务端派生 actor）、**16 reason codes**（grep 为零命中）、Zod 完整校验 |
| §50 | UI | PARTIAL | apps/desktop | Electron+React+Monaco+xterm✓，多页面✓；缺：§50.2 11 页面逐项核验、透明性规则（Review/Waiver/N-A 不用同一绿色 PASS）、Final Report 内容清单（NEEDS_REVIEW：逐页对照） |
| §51 | NFR | MISSING | — | 无基准实现：8 并发 Run、50+ 远程、p95 指标、重启 <30s、disk-full safe mode 均未作为代码目标 |
| §52 | 导入导出与迁移 | PARTIAL | project-io | 脱敏导出+严格导入校验✓；缺：v1 迁移规则（`legacy_completion_unverified`、旧 DONE→Milestone 转换条件、旧 Memory 标 UNVERIFIED） |
| §53 | 技术选型 | COVERED | 全体 | Electron/React/TS/Monaco/xterm/Node/SQLite/Drizzle/outbox 设计/Git CLI/adapters/MCP/electron-builder 均已采用 |
| §54 | 验收套件 AT-001–064 | MISSING | — | 64 场景无对应自动化验收实现 |
| §55 | 产品 DoD | MISSING | — | 产品级 10 条件，非代码项 |
| §56 | 盲点登记 | N/A | — | 信息性章节，已映射到规范 |
| §57 | 决策登记 | N/A | — | 信息性章节 |
| §58 | v1 迁移对照 | N/A | — | 信息性章节 |
| §59 | 官方集成核对 | PARTIAL | model-router/runtime | CodexAdapter 占位、MCP 基线待实现；缺：按安装版本 Schema 适配、quota 元数据实时读取 |

## 必须新建的包清单

| # | 包名 | 覆盖章节 | 核心职责 |
|---|---|---|---|
| 1 | `requirements` | §16 | Requirement 不可变版本、AC（稳定 ID/验证类型/责任/证据）、影响分析、`completion_target` |
| 2 | `progress` | §20 | 确定性进度引擎：`100×Σ(wᵢcᵢ)/Σwᵢ`、weight_plan_version、失效下降、父聚合只算叶子 |
| 3 | `factory-control` | §24 | 三轴状态（control/health/capacity）、control_epoch、Worker ACK、8 操作语义、Emergency Stop |
| 4 | `watchdog` | §30 | heartbeat 5s/3 次疑似/60s STALLED、诊断分类、熔断限流、自身健康 |
| 5 | `takeover` | §31 | 11 步接管流、quiesce、lease 撤销/fence、`author_type=HUMAN`、Return 对账 |
| 6 | `incidents` | §42 | Incident 生命周期、Runbook 模型、预授权自动恢复、postmortem |
| 7 | `tools` | §33 | Tool Registry：元数据、副作用分类、幂等/取消支持、统一执行审计、替代路径同权 |
| 8 | `quota` | §27 | quota bucket 模型、三策略、Handoff Package、确定性工具豁免规则 |
| 9 | `leases` | §22 | durable Lease（generation+fencing_token）、STALE_OWNER、最终执行点校验（或并入 coordination） |
| 10 | `api-contracts` | §49 | 统一信封、16 reason codes、Zod schemas、TransitionRequest/DelegationRequest/EvidenceRecord 类型 |

注：`leases` 可并入 `coordination`，`quota` 可并入 `model-router`，`api-contracts` 可落在 `apps/server`；但独立成包更符合仓库既有的一包一域约定。

## 按优先级排序的开发批次建议（6 批）

**第 1 批 — P0 安全与授权**（DEF-001 在此批必须修）
- 包：`approvals`（硬化）、`policy`、`api-contracts`（新建）
- 章：§23.1（合并改限制交集）、§23.2（Capability 绑定维度）、§23.3（digest 绑定+变更失效+decidedBy 校验，修 DEF-001）、§23.4（Exception Grant）、§49（信封+16 reason codes）、§46.2（Secret Broker OS 接入）
- 验收：P0 探针 6 项全过 + 新旧 policy merge 差异测试

**第 2 批 — 状态真相（工作流/完成/进度/需求）**
- 包：`core`（改造）、`requirements`（新建）、`progress`（新建）
- 章：§16（Requirement 一等公民）、§17（authorization_status+Proposal）、§18（三态分离+OUTCOME_VERIFICATION）、§19（五层 Milestone+final_seal 同事务）、§20（确定性进度）
- 验收：状态机边集生成测试、进度可复算（34% 示例）、Done 封印事务测试

**第 3 批 — 执行面硬化**
- 包：`security`（改造）、`tools`（新建）、`coordination`+`leases`（新建/并入）、`factory-control`（新建）
- 章：§7（真实隔离后端抽象+fail-closed）、§33（Tool Registry）、§22（Lease+fencing）、§24（三轴控制+ACK）、§28（外部动作三态+幂等+Outbox）
- 验收：路径逃逸全路径拒绝、STALE_OWNER 拒绝、控制操作 ACK 一致性

**第 4 批 — 模型、额度与自保**
- 包：`runtime`（改造）、`model-router`+`quota`（新建/并入）、`watchdog`（新建）、`takeover`（新建）
- 章：§25（Run 状态完备）、§26（Adapter 全契约）、§27（三策略+Handoff）、§30（Watchdog）、§31（Takeover）
- 验收：quota 三策略行为测试、watchdog 阈值测试、takeover 旧 worker 写被拒测试

**第 5 批 — 验证与发布**
- 包：`core`（证据改造）、`review`、`qa`、`cicd`、`incidents`（新建）
- 章：§39（证据契约全字段+Gate 8 verdict）、§37（独立性强制）、§38（机器报告+flaky quarantine）、§40（可复现构建）、§41（风险/可逆性/canary/观察/Outcome）、§42（事故）
- 验收：证据字段完整性校验、canary HOLD 条件测试、不可逆 migration 拒绝假回滚

**第 6 批 — 数据、组织、UI 与验收**
- 包：`db`（改造）、`squads`（改造）、`project-io`（改造）、`apps/desktop`、`apps/server`
- 章：§48（约束+Outbox+迁移）、§8（Authority 仲裁）、§9（9 边类型）、§43（scope 先过滤）、§44（Scout 真实 handler）、§45（holdout）、§47（备份/保留）、§50（11 页面核验）、§52（v1 迁移）、§51（基准目标）、§54（AT 套件）
- 验收：§54 AT 全量执行、§55 DoD 逐条签署

## 给分派的关键提醒

1. **v1 包头注释里引用的章节号是 v1 编号**（如 `security/src/sandbox.ts` 引 "spec §76"、`policy` 引 "§43"），与 SPEC_V2 章号**不是一一对应**——开发时以本矩阵的 v2 章号为准，不要按包内旧注释对号入座。
2. **内存态是全仓库系统性现状**：除 `db`（SQLite）、`recovery` 快照（FS）、`git`（真实 CLI）外，几乎所有 store 都是 InMemory；持久化改造应随第 2/3/5 批按域落地，不要单开"全改 SQLite"一批。
3. **§23.1 是语义级 breaking change**：upper-wins 改限制交集会影响所有已写 policy 测试，先改语义再补测试。
4. 本矩阵未逐行审计每个包的全部测试断言；NEEDS_REVIEW 项（§8 仲裁、§10 治理细节、§37 独立性、§50 页面）在对应批次开工前需先做 1 小时定向代码审计。
