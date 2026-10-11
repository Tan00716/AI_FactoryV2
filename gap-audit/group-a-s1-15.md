# AI Factory 实现完整度审计报告 — SPEC_V2 §1–§15（Group A）

- 审计日期：2026-10-11
- 规格：`~/workspace/user/files/SPEC_V2.md` v2.0（SHA-256 `45e6c5ca…`，已核验）
- 代码：`~/workspace/ai-factory`（commit `47856d7`），`packages/*/src`（40 包）+ `apps/server/src` + `apps/desktop/src`
- 方法：只读审计（grep 定位符号 + 阅读关键函数体）；未修改任何代码；三条"不符"指控已由审计员独立复验确认
- 状态定义：**缺失**=完全没实现；**部分**=有骨架但缺关键字段/分支/行为；**不符**=实现与规格明文矛盾
- 范围说明：只列实现缺口，不列测试覆盖率；需真实环境才能验证的单列 BLOCKED

## 总览

| 项 | 数 |
|---|---|
| 审计章节 | 15（§1–§15） |
| 确认真缺口 | **81 条**（缺失 42 / 部分 35 / 不符 4） |
| 已验证通过 | 50 项 |
| BLOCKED（环境限制，去重后） | 10 项 |

> 说明：§2/INV-31（多人指令冲突解析）与 §8.1（AUTHORITY_CONFLICT）指向同一缺失机制，已合并计 1 条。

## 缺口清单

### §1 Final Goal（3 条）

[§1.1] Human 创建需求/顶层票、选择 AI Manager、点击 Dispatch、可配置默认 Manager → 状态：缺失 → 证据：全仓库无 dispatch 概念；`POST /api/tasks`（apps/server/src/index.ts:258）不收 managerId/dispatch 字段；无 defaultManager 配置；desktop `CreateTaskModal.tsx` 无 Dispatch/授权动作入口

[§1.2] 主指标 Authorized Outcome Completion Rate 必须被计算 → 状态：缺失 → 证据：`packages/dashboard/src/types.ts` 的 DashboardMetrics 仅 7 项辅助指标；全仓库无 AuthorizedOutcomeCompletionRate 符号

[§1.1] Human 接收可追溯最终报告 → 状态：部分 → 证据：`packages/artifacts/src/schemas.ts:188` 有 FINAL_REPORT schema，但无按 §1.1(6) 组装最终报告（汇总组织/票据/终端/Diff/证据）的专用生成器

### §2 Product Principles（3 条，INV-01–INV-35 中属本组可验证者）

[§2/INV-10] 员工、技能、政策、需求、工作流及重要 Adapter 配置必须版本化，Run 固定版本 → 状态：部分 → 证据：仅 requirements（immutable version）、skills（版本）、agents 表 version 列、审批快照 policy_version 已版本化；缺 policy 本体（`packages/policy/src/types.ts` 无 version）、workflow 定义（workflows 表 definition 为无版本 JSON）、model-router adapter 配置版本；runs 表未 pin 员工/技能/政策版本

[§2/INV-29] 供应商能力不可用时明确报告，不模拟成功 → 状态：部分 → 证据：`packages/model-router/src/router.ts` 的 `satisfiesHardConstraints`（:35-41）与打分均不检查 `availability` 字段；`availability:'offline'` 的模型仍可被选为 primary，且无不可用报告分支

[§2/INV-31＋§8.1] 多人指令冲突由 Authority/Policy/Scheduler 解析（不按最后发言获胜）；两个同等有效且不兼容的指令进入 AUTHORITY_CONFLICT，暂停相关动作并升级 → 状态：缺失 → 证据：全库无 AUTHORITY_CONFLICT 符号；`/api/disputes`（apps/server/src/routes/disputes.ts）仅处理 verdict 分歧；policy 层冲突（`packages/policy/src/types.ts:14`）仅处理政策层级覆盖

### §3 产品范围与自主权（5 条）

[§3.1] 必须支持真实远程项目 → 状态：缺失（远程部分） → 证据：`packages/projects/src` 中 `grep -ri remote` 零命中；§4 方案 B 远程 Host 零实现

[§3.1] IDE 终端 → 状态：部分 → 证据：desktop `TerminalPanel.tsx` 经 `/api/exec` 实现；`apps/server/src/routes/exec.ts:7` 明确声明 "no real PTY — one-shot execution"

[§3.2] 创建顶层票可携带 dispatch=true → 状态：缺失 → 证据：`packages/core/src/types.ts:73-98` Task 接口无 dispatch 字段；全库无 `dispatch=true` 字样

[§3.2] UI 必须显示授权动作 → 状态：缺失 → 证据：dispatch 流程不存在；`CreateTaskModal.tsx` 中 dispatch/授权/authoriz 零命中

[§3.2] 普通缺陷默认创建含 Evidence 的 TODO 且 authorization_status=WAITING_HUMAN_DISPATCH → 状态：缺失 → 证据：Task 类型与 tasks 表（`packages/db/src/schema.ts:39-60`）均无 `authorization_status` 字段；`WAITING_HUMAN_DISPATCH` 仅出现在 `packages/core/src/workflow-v2.ts:102` 的 ActorAuthorization（gate 上下文快照，与任务字段无关）

### §4 架构（4 条）

[§4.1] AI 不能直接改数据库 → 状态：不符 → 证据：`/api/exec`（apps/server/src/routes/exec.ts:35-42）白名单含 `node`/`npx`/`npm`，cwd 被限定为 server 根目录（`WORKSPACE_ROOT = resolve(process.cwd())`），而该目录即含 `./data/factory.db`（index.ts:82 DB_PATH 默认值）；Agent 经 `/api/exec` 用 `node -e`（node:sqlite）可直接读写控制面数据库——已独立复验确认

[§4.1] 控制面存储路径不暴露为 Agent 可写挂载 → 状态：部分 → 证据：`packages/security/src/isolation.ts:189` 有 `forbiddenPrefixes` 机制（注释明示用于 control-plane DB），但 `apps/server/src/routes/isolation.ts:40-42` 要求调用方在请求 body 自行提供，server 未默认接线 DB_PATH；且对 `/api/exec` 路径不生效（cwd 即 server 根）

[§4.2] 执行面接收签名/认证的、带期限及 fencing token 的工作请求 → 状态：部分 → 证据：leases 有 TTL + fencing_token 校验（manager.ts:77），takeover 强制 fencing；但 `packages/runtime/src/runner.ts`/`harness.ts` 的工作请求无签名/HMAC/认证信封

[§4.2] 远程 Host 使用设备/服务身份，不复用 Human 会话 Cookie → 状态：缺失 → 证据：B 方案未实现；全库无 remote host / device identity 代码

### §5 模块边界（2 条）

[§5] 通知内容不泄露秘密 → 状态：部分 → 证据：`packages/notifications/src`（engine/rules/types）及 `apps/server/src/routes/notifications.ts` 中 `grep -ri redact` 零命中；`NotificationEvent.detail?: Record<string, unknown>` 自由格式被模板插值进 body

[§5] AI 不得提高自身/下属权限上限 → 状态：部分 → 证据：`packages/employee-factory/src/governance.ts` 的 `enforcePolicy` 只有绝对上限检查（children/depth/allow-lists/budget），无"请求者相对上限"检查

### §6 Project（10 条）

[§6.1] 项目记录"至少包含"13 个字段 → 状态：部分 → 证据：`packages/db/src/schema.ts` 的 projects 表与 `db.ts` 的 ProjectRow 仅有 id/name/description/path/created_at/updated_at；缺 organization_id、profile_version、repository_refs、workspace_refs、instruction_refs、policy_version、default_manager_id、workflow_version、environment_refs、data_classification、lifecycle_state（11 个字段全库无处定义）

[§6.1] 4 种项目入口须含 Clone Repository → 状态：缺失 → 证据：`apps/server/src/routes/projects.ts` 仅 templates/discover/create/exec 四个端点；`packages/git/src/git.ts` 无 clone 入口函数

[§6.1] 模板"不是全部内置，必须可扩展" → 状态：不符 → 证据：`packages/projects/src/templates.ts` 为硬编码 `Record<ProjectTemplateName, ProjectTemplate>`（5 个模板），无 registerTemplate/插件注册机制，`getTemplate` 对未知模板直接 throw

[§6.2] Project Profile 必须区分"检测到配置"和"已执行且成功" → 状态：缺失 → 证据：`packages/projects/src/types.ts` 的 ProjectProfile 无 detected-vs-verified 区分字段

[§6.2] 多 lockfile/缺依赖/未知命令/无测试须记诊断、不得推测 PASS → 状态：缺失 → 证据：`packages/projects/src/discover.ts` 无 diagnostics 字段与逻辑；`detectPackageManager` 遇多 lockfile 取第一个命中、无警告

[§6.2] 自动发现须含 Build、容器/VM 配置、README、docs、.ai → 状态：部分 → 证据：`discover.ts` 未检测 Dockerfile/容器配置、构建配置、README、docs/、.ai/ 目录

[§6.3] "不得覆盖非空目录" → 状态：缺失 → 证据：`packages/projects/src/create.ts` 的 `createProject()` 对已存在目录直接 `mkdirSync(recursive)` 并 `writeFileSync` 无条件覆盖模板文件，无非空目录检查

[§6.3] 推送远程仓库/发布公开项目须属获准范围 → 状态：缺失 → 证据：全库无 push-remote/publish-public 的授权检查

[§6.4] 9 类项目知识须有结构 → 状态：缺失 → 证据：全库无 ProjectKnowledge 类型；9 类（Product Requirements…Lessons）在 `packages/knowledge` 与 projects 包均无对应结构

[§6.4] 来源文件保留、索引/摘要引用版本与 Hash → 状态：缺失 → 证据：无 project-knowledge 存储实现；无 source_version/source_hash 引用字段

### §7 Workspace 与隔离（9 条）

[§7.1] "不以固定命令白名单代替用户选择的完整 Shell" → 状态：不符 → 证据：`packages/projects/src/executor.ts` 的 `WorkspaceExecutor` 核心机制即 `DEFAULT_ALLOWED_COMMANDS` 首 token 白名单（`command not in whitelist` 拒绝），与规格明文禁止的做法一致——已独立复验确认

[§7.2] 能力须按项目和授权任务限定 → 状态：部分 → 证据：`packages/tools/src/types.ts` 的 `CapabilityGrant` 仅 principalId/actions/resourcePrefixes/expiresAt/revoked，无 projectId/taskId 字段

[§7.3] 路径校验覆盖大小写归一化 → 状态：部分 → 证据：`packages/security/src/isolation.ts` 的 `detectPathThreats` 注释声称 "Case-insensitivity is handled by normalizing comparisons"，函数体内无任何大小写归一化代码

[§7.3] 路径校验覆盖 hardlink → 状态：部分 → 证据：`PathThreatKind` 仅 null-byte/escape/unc/device-path/unicode/symlink-risk/git-common-dir；hardlink 只出现在模块头注释罗列中

[§7.3] 路径校验覆盖 TOCTOU 与替换路径 → 状态：部分 → 证据：`resolveConfinedPathSync` 注释明写 "TOCTOU between this check and later use cannot be closed at this layer"；替换路径（path substitution）无检测

[§7.4] 模型调用须经可信 Runtime Proxy 并使用单独凭证 → 状态：缺失 → 证据：`packages/model-router/src` 无 proxy 概念；`packages/security/src/credentials.ts` 仅做 SecretRef/脱敏，无模型凭证隔离与代理转发

[§7.4] 本地 server 绑定默认 loopback → 状态：不符 → 证据：`apps/server/src/index.ts:415` 为 `server.listen(PORT)` 未指定 host（Node 默认全接口绑定）；日志写 localhost 仅为文案——已独立复验确认

[§7.4] DNS 重绑定/重定向/私网/metadata endpoint/代理绕过须检查 → 状态：缺失 → 证据：全库无 DNS-rebinding、私网地址段、169.254 metadata endpoint、代理绕过相关检查代码

[§7.5] fail-closed gate 须接入真实执行路径 → 状态：部分 → 证据：`assertConfinementForAutonomousShell` 仅定义于 `packages/security/src/isolation.ts`；`packages/projects/src/executor.ts`、`/api/projects/exec`、`/api/exec` 均未调用，Host 无法证明边界时仍可执行 shell

### §8 身份与权限（5 条；AUTHORITY_CONFLICT 已并入 §2/INV-31 条目）

[§8] Custom Roles + RBAC + 8 个建议角色模板 → 状态：缺失 → 证据：`packages/policy/src` 无 Role/RBAC 模型；Owner/Organization Admin/Engineering Manager/Developer/QA/Security Authority/Release Approver/Viewer 八个模板全库无定义

[§8] "每个请求都需认证" → 状态：缺失 → 证据：`apps/server/src/index.ts` 及全部 40+ route 文件无任何 auth 中间件/token 校验；`actor` 由请求体自声明（如 `body['actor'] ?? 'human'`）

[§8.1] Security Authority 的有效 BLOCK 不能被普通 Manager ALLOW 抵消 → 状态：缺失 → 证据：无 Security Authority 角色定义；`packages/approvals/src/manager.ts` 的 `decide()`/`deciderSatisfies` 无安全权威否决优先语义

[§8.2] 撤销须递增 revocation epoch 并在最终执行点拒绝旧能力 → 状态：部分 → 证据：全库无 revocation_epoch 概念；`CapabilityGrant.revoked` 仅布尔标记；`tools/src/executor.ts` 的 `checkGrant` 只查布尔值

[§8.2] 有效权限取所有限制的交集 → 状态：部分 → 证据：`checkGrant` 校验 grant 身份/撤销/过期/动作/资源前缀/工具供给，但未与有效政策、任务范围求交集；交集语义仅见于 policy 层注释

### §9 组织图（3 条）

[§9.1] organization_relationships 边表为权威存储 → 状态：部分 → 证据：`packages/db/src/schema.ts` 无 organization_nodes/organization_relationships 表；`OrgGraphV2`（`packages/squads/src/org-graph.ts`）仅内存 Map 实现，进程重启即失

[§9.3] 默认组织模板 → 状态：部分 → 证据：无 `defaultOrgTemplate`/`seedDefaultOrg` 函数；`packages/db/src/seed.ts` 的 `seedIfEmpty` 仅为 demo 数据且缺 Human Owner、DevOps Lead、DB、UX/UI 等规格角色，QA 挂在 Tech Lead 下而非独立

[§9.4] 历史 Run 须能解析当时的组织版本 → 状态：部分 → 证据：`OrgGraphV2` 的 history 快照为私有、无按版本查询的公开接口；且 Run 未 pin `organization_version`（见 §10.1 条目），历史解析无版本可对

### §10 员工（7 条）

[§10.1] Employee Version "至少包含"22 个字段 → 状态：缺失 → 证据：全库无 `EmployeeVersion` 类型；`packages/db/src/schema.ts` 的 agents 表与 `packages/employee-factory/src/factory.ts` 创建逻辑仅约 12 项字段，无 Executor/Management capabilities、Policy refs、Skill versions、Model strategy、Reasoning preference、Fallback、MCP versions、permission ceiling、Memory/Knowledge scopes、Concurrency/Budget/Timeout、Input/Output schemas、Evaluation profile 的完整结构

[§10.1] Run 固定 employee_version + organization_version + resolved_instruction_manifest + model_profile + policy_version → 状态：缺失 → 证据：全库无 `resolved_instruction_manifest`、`organization_version`、`model_profile` 符号；runs 表无版本 pin 字段

[§10.1] 相同员工多个 Run 不能同时写同一 Workspace → 状态：缺失 → 证据：`packages/orchestrator` 与 `packages/leases` 无"同员工×同 Workspace 写互斥"规则

[§10.2] Executor/Management 两类能力 → 状态：缺失 → 证据：`packages/core/src/types.ts` 的 `Permission` 为扁平字符串联合类型；employee-factory 无两类能力字段

[§10.2] 自己写的代码不能由自己作为唯一 Approver（独立性校验须接入） → 状态：部分 → 证据：`packages/review/src/independence.ts` 的 `assertReviewIndependence` 全库仅其自身文件引用，从未被 review gate、approvals 或 orchestrator 调用（死代码）

[§10.3] 生命周期恰为 DRAFT→VALIDATED→ACTIVE→SUSPENDED→RETIRED→ARCHIVED 六态 → 状态：缺失 → 证据：`packages/employee-factory` 无生命周期状态机；agents 表 status 为自由字符串（默认 'IDLE'）；无 task-scoped 专家任务完成后退休归档逻辑

[§10.4] Autonomy 0–5 每级允许范围表与强制 → 状态：部分 → 证据：`packages/core/src/types.ts` 仅 `AutonomyLevel = 0|1|2|3|4|5` 类型别名；`autonomyLevel` 仅在 `orchestrator/src/selection.ts` 作复杂度评分，无任何门控强制某级只能做某类动作

### §11 指令与 Context（6 条）

[§11.1] Harness 为每次 Run 生成版本化 Manifest（平台不变量、政策限制摘要、获准需求版本、任务范围、员工任务/职责、Manager 委托、项目认可指令、相关 Skill 版本、按范围检索的 Memory、外部资料引用；每项带来源/版本/Hash/信任类别/优先级） → 状态：缺失 → 证据：全库无 Run Manifest 生成代码；`packages/runtime/src/durable.ts:319` 仅有 `contextManifestHash: string` 字段被 checkpoint 引用，无 manifest 对象构建、字段装配或校验逻辑

[§11.2] AGENTS.md/README/`.ai` 须经项目政策认可才成为项目级指导；陌生仓库 AGENTS.md 默认待验证外部内容；深层文件指导只适用于目录内 → 状态：缺失 → 证据：`packages/projects/src/discover.ts:307` 仅 `hasAgentsMd: exists(...)` 布尔检测；无信任分级、无认可流程；深层文件目录作用域限制无代码

[§11.3] Manager 核心指令契约须有强制载体 → 状态：部分（仅文档/注释，无强制载体） → 证据：全库无 Manager 系统提示词/指令模板/契约文件；契约 13 条中"确认目标/预算内拆工/验证引用"等有分散机制包载体，但契约本身无统一强制载体

[§11.4] Executor 核心指令契约须有强制载体 → 状态：部分（仅文档/注释，无强制载体） → 证据：全库无 Executor 系统提示词/指令模板；"不自签独立 QA"有 independence.ts 载体、"保留引用"有 evidence 包载体，但契约本身无强制载体

[§11.5] 为证据及必要代码保留 context headroom → 状态：缺失 → 证据：全库无 "headroom" 预留/预算代码；`packages/runtime/src/limits.ts` 只有 maxSteps/maxContextChars 硬上限

[§11.5] 敏感文本在发送前做数据政策检查和脱敏 → 状态：缺失 → 证据：`packages/comms/src/channel.ts` 的 send/deliver 路径无 redact 或政策检查调用；`redactSecrets`/`redactDeep` 在 comms 发送路径零调用点

### §12 管理运行时（10 条）

[§12.1] 管理循环 12 阶段（Receive→Assess→Plan→Select→Delegate→Monitor→Receive Report→Review→Rework/Reassign/Escalate/Approve→Aggregate→Report Upward） → 状态：缺失 → 证据：`packages/orchestrator/src/orchestrator.ts` 的 `NextAction` 是任务生命周期动作（decompose/assign/run/…/escalate）；全库无该 12 阶段枚举或流程代码

[§12.3] 选人先满足硬约束（Role/Skill/Tool/Permission/Verification Independence）再考虑软因素 → 状态：部分 → 证据：`packages/orchestrator/src/selection.ts` 的 `scoreAgent` 为加权打分（skills 30/tools 20/permissions 15…）；`rankCandidates` 仅过滤 ONLINE/IDLE/WORKING，不淘汰缺 requiredSkills/Tools/Permissions 的候选人——硬约束是权重不是门

[§12.3] Verification Independence 纳入选人硬约束 → 状态：缺失 → 证据：独立性检查只在 `packages/review/src/independence.ts`（Gate 前置）；`selection.ts` 未引用独立性

[§12.3] 深度、员工数、同一任务活跃委托数、报告传播上限 → 状态：缺失 → 证据：仅深度上限 5 存在（`DEFAULT_MAX_DELEGATION_DEPTH`）；无员工数上限、无 per-task 活跃委托数上限、无报告传播上限（comms 仅 `DEFAULT_MAX_PAYLOAD_BYTES` 载荷上限）

[§12.4] APPROVE：接受子任务/Artifact；不等于 QA PASS 或父任务 Done → 状态：缺失 → 证据：`NextAction` 无 approve；无 APPROVE Manager 动作实现（仅 workflow 状态机有被动状态）

[§12.4] REJECT：带理由拒绝提交，保留历史不伪造 → 状态：部分 → 证据：workflow 有 REJECTED 状态；但 Manager REJECT 动作（带理由拒绝的系统操作）无实现

[§12.4] REWORK：创建修复项、指明失败 AC/Evidence、预留预算，失效受影响证据 → 状态：部分 → 证据："失效受影响证据"无代码——`packages/core/src/engine-v2.ts` 的 `invalidateCompletion` 只处理 DONE 后回归/rollback 场景的 outcome gate 失效，无 REWORK 触发的证据失效路径

[§12.4] REASSIGN：回收执行 Lease，安全交接给获准对象 → 状态：部分 → 证据：`packages/leases/src/manager.ts:108` 的 `reassign` 有 generation+fencing_token 安全交接机制；但 orchestrator 无 REASSIGN Manager 动作将其与管理决策衔接（`NextAction` 无 reassign）

[§12.4] ESCALATE：传递结构化问题与最小必要证据，暂停受风险影响的动作 → 状态：部分 → 证据：`NextAction` 有 'escalate'；但"暂停受风险影响的动作"无实现（全库无 escalation 触发的动作暂停/冻结代码）

[§12.5] Manager 心跳丢失时控制面不丢失下属任务，由受授权代理接管监督 → 状态：部分 → 证据：`packages/watchdog` 有心跳跟踪（SUSPECTED_STALL→STALLED）；但 `packages/takeover` 是 human-takeover-of-worker（§31）；`packages/runtime` 与 watchdog/takeover 零衔接代码

### §13 动态员工（5 条）

[§13] create_ai_employee 系统校验来源、任务需要、Mission、权限上限、可用模板/模型/技能、深度、预算 → 状态：部分 → 证据：`employee-factory/src/governance.ts` 的 `enforcePolicy` 校验深度/预算/模型/工具/权限/角色 allow-list；但 `EmployeeSpec`（factory.ts:20-38）与 `CreationRequest` 无来源/任务需要/Mission/技能字段，技能未被校验

[§13] 创建理由、Creator、Manager、Task、Version、Lifecycle 必须入审计 → 状态：缺失 → 证据：`factory.ts:176-177` 的 `createEmployee` 把 `requestedBy` 直接 `void` 掉；`core/types.ts:189-212` 的 `Agent` 无 creator/reason/task/lifecycle 字段；创建时无审计记录写入

[§13] 必须设置 max_children、max_management_depth、max_active_employees、max_task_scoped_employees、max_concurrent_runs、max_runtime、max_budget、allowed_* → 状态：缺失（2 项） → 证据：`FactoryPolicy`（governance.ts:18-40）有 maxChildren/maxDepth/maxConcurrentAgents/maxRuntimeMs/maxBudget/allowedRoles/allowedModels/allowedTools/allowedPermissions；无 max_task_scoped_employees、无 max_concurrent_runs

[§13] Manager 不得创建"Production Administrator"绕过自身没有的生产能力 → 状态：部分 → 证据：guard 只在 `employee-factory/src/proposals.ts:42` 的 `PRIVILEGED_ROLE_FRAGMENTS`（自修改提案路径）；`createEmployee` 工具路径的 `enforcePolicy` 无该检查

[§13] 跨项目复用员工必须使用新的 Task/Memory/Workspace Scope → 状态：部分 → 证据：`memory` 有 `purge(scopeId)` 与 scope ACL（store.ts）；但员工跨项目复用时强制重置三类 Scope 的代码载体未找到

### §14 结构化报告（3 条）

[§14] 同一结果有一个 origin report，汇总引用而不是复制改写 Evidence → 状态：缺失 → 证据：`packages/comms/src/report.ts` 无 origin report 概念（无 origin 字段、无"汇总引用 vs 复制"区分）

[§14] 报告默认给直属上司，可发送 Project/Functional Reporting Targets；横向接收权限受数据范围约束 → 状态：缺失 → 证据：`ManagementReport` 无 reporting_targets 字段（该字段只在 delegation 存在）；`comms/channel.ts` 发送路径无 reporting-target 数据范围约束检查

[§14] 需要调查时可 Drill Down Trace、Terminal、Diff、Commands、Tool Output → 状态：缺失 → 证据：全库无 drill-down 能力代码（evidence/artifact 有存储与 get，但无统一钻取接口）

### §15 升级与争议（6 条）

[§15] 每个 Escalation 包含触发规则、原命令、授权/政策版本、Evidence、影响范围、已停止动作、建议、期限、接收方 → 状态：部分 → 证据：`packages/autonomy/src/escalation.ts:54-63` 的 `EscalationRecord` 仅 id/reason（触发规则）/reasonZh/severity/detail/context/detectedAt；缺原命令、授权/政策版本、Evidence、影响范围、已停止动作、建议、期限、接收方（9 项中仅 1 项）

[§15] Agent 可依 Escalation Policy 跳过直属上司，路径到更高 AI、Security/Quality Authority 或 Human → 状态：部分 → 证据：autonomy 的 `needsHuman` 走人类通道；无 skip-level 路由代码；`EscalationRecord` 无接收方/上级链字段

[§15] 上司不能删除/屏蔽员工的安全升级能力 → 状态：缺失 → 证据：全库无相关 guard（升级通道的可删除性/可屏蔽性无保护代码）

[§15] 升级并不自动扩大访问或允许继续危险动作 → 状态：缺失 → 证据：escalation 路径无"访问权限不变"的强制声明/检查代码

[§15] P0 使用独立通知路径及重复通知限流，避免风暴 → 状态：缺失 → 证据：`packages/notifications` 仅 `in_app` 单通道（types.ts:56）；无限流/去重/风暴抑制代码

[§15] Coder/Reviewer/QA 分歧无法判断时进入 DISPUTED Gate → 状态：缺失 → 证据：`packages/review/src/types.ts:38-42` 的 `ReviewVerdict` 仅 PASS/PASS_WITH_WARNINGS/CHANGES_REQUESTED/BLOCK；`core/workflow-v2.ts` 有 ESCALATED Condition 但无 DISPUTED Gate

---

## 已验证通过（50 项简表）

| 章节 | 通过项 |
|---|---|
| §1 | Manager 建计划/子任务/依赖/Squad（orchestrator+squads+5 个 API）；真实项目修改+工具+Artifact/Evidence；独立 Review/QA 与失败回流（review/independence.ts、qa/loop.ts assignOwner）；政策控制合并/UAT/生产发布（cicd predeploy/canary/reversibility） |
| §2 | INV-22 三停语义区分（factory-control OPERATION_SEMANTICS 矩阵；EMERGENCY_STOP 不下线生产服务）；INV-24 接管 fencing（takeover bump generation + StaleOwnerError）；INV-26 SecretRef/redactSecrets/redactDeep + 审计 redaction hook；§1.2 无消息数/员工数/代码行数类质量指标 |
| §3 | 本地项目/IDE 编辑器/看板/组织图/动态员工/派工/多模型路由/工具-MCP-Skills/Git-PR/Review-QA/CI-CD/环境发布/证据审批审计/Watchdog/Quota/恢复接管/记忆知识评测/角色权限均有对应包与 UI |
| §4 | 控制面拥有身份/组织/任务/需求/工作流/审批/能力/调度/预算/证据（server 路由 + db 表全覆盖）；安全运行域独立（watchdog/incidents） |
| §5 | Renderer 无 Node/Shell（electron main.ts contextIsolation:true，未开 nodeIntegration）；Manager 无法改 Gate 事实（engine-v2 原子提交）；子任务继承范围与预算（delegation.ts SCOPE_VIOLATION/BUDGET_EXCEEDED）；审批绑定+期限（approvals digest+deadline+sweepExpired） |
| §6 | 发现阶段 read-only（discoverProject 仅读文件，跳过 node_modules） |
| §7 | Workspace 10 字段齐全（isolation.ts WorkspaceRecord）；隔离后端抽象可替换（IsolationBackendKind: vm/restricted-os-account/container/local-dev/unverified）；无 Job Object 虚假声称；默认 deny 网络；CONFINEMENT_UNAVAILABLE 错误码与 fail-closed gate 函数存在 |
| §8 | Human/AI/Service 三类 Principal（squads org-graph ActorKind）；政策 Override 有审计且 deny 优先；委托不超过可授予集合（isSubset+SCOPE_VIOLATION）；委托链无循环限深度 5 |
| §9 | 节点 4 类型；边 9 类型；边记录 11 字段齐全；方向约定在代码注释逐条落实；主管理关系无环（constraints.ts+assertAcyclic）；单主管理（MULTIPLE_PRIMARY_MANAGERS）；图变更版本化+tombstone（内存层） |
| §10 | 四个政策预设（assisted/semi/autonomous/full）；Production 权限独立判断（policy 决策规则 deny 优先） |
| §11 | 锁定边界系统独立强制（harness checkPermission 未知工具默认拒绝、assertWithinRoot）；按任务检索 Skills/Memory（select/selectTop、retrieve 先过 ACL+scope） |
| §12 | 委托 18 字段齐全；范围/权限子集校验；预算父任务预留；上司保留监督、仅 handoff 变更 owner；深度上限 5 |
| §13 | Idle 员工计入上限（maxTotalAgents 全注册计数）；Task Squad 归档、临时专家退休（squads retireNode 墓碑） |
| §14 | 报告 schema_version 2.0 全字段；系统字段只读冻结（Object.freeze）；引用存在性/身份/序号校验；旧报告不回退；self_assessed_confidence 不作 Gate 分数 |
| §15 | 分歧按证据裁决、无多数投票（evaluation/disagreement.ts）；ESCALATED Condition 存在（workflow-v2.ts:67） |

---

## BLOCKED 清单（环境限制，不算缺口，去重后 10 项）

1. 真实隔离后端（VM/容器/受限 OS 账户）缺失——§7.3 真实后端、§4.2 Worker 崩溃隔离：需真实隔离 Host/VM
2. Windows 真机路径行为（设备路径、UNC、Junction、大小写不敏感 FS）：本机为 Linux，无法验证
3. 真实 LLM 接入与行为验证：INV-29 供应商降级、§11.5 本地模型数据消费权限、§7.4 Proxy 端到端
4. 真实 MCP 服务接入验证
5. 团队 PostgreSQL / 多机并发语义（组织图权威存储并发、runs 多机）
6. 真人参与：Human Owner 最终治理、真实审批人身份、UAT/生产验收、最高层 Human+Evaluation 控制
7. 真实远程仓库交互（推送远程/发布公开项目）
8. 远程常驻 Monitor（§4.3 单机断电/休眠限制）
9. Manager 心跳丢失的多机故障注入验证
10. 跨项目秘密不泄漏的端到端验证（需真实隔离）

---

## 补强优先级建议（按严重程度）

1. **[§4.1] /api/exec 经 node 可直接读写控制面 DB（不符）**——最高危：与"AI 不能直接改数据库"明文矛盾；修复方向：exec 白名单剔除 node（或 cwd 强制限定到项目工作区并默认接线 forbiddenPrefixes 覆盖 DB_PATH）
2. **[§8] server 全路由无认证（缺失）**——任何调用者可冒充任意 actor；修复方向：最小可用的 token 中间件 + actor 绑定
3. **[§7.1] 白名单代替完整 Shell（不符）+ [§7.5] fail-closed 未接入执行路径**——规格要求"完整 Shell + 真实隔离"，现状是"白名单 + 无隔离 gate"；二者应一并按 §7.3/§7.5 重做
4. **[§7.4] server 全接口绑定（不符）**——改为默认 loopback 监听，一行修复
5. **[§8] RBAC 缺失**——8 个角色模板与 Capability/Scope 绑定是权限体系地基
6. **[§2/INV-31＋§8.1] AUTHORITY_CONFLICT 缺失**——多人/多智能体指令冲突无裁决路径
7. **[§1.1] Dispatch 入口缺失**——核心体验第 1 步无代码载体（含 dispatch=true、默认 Manager、UI 授权动作展示、WAITING_HUMAN_DISPATCH）
8. **[§10] 员工版本 22 字段 + 6 态生命周期 + Run 5 版本 pin 缺失**——员工体系地基缺失，影响 §9.4 历史解析、§11.1 Manifest
9. **[§11.1] Run Manifest 生成器缺失**——Harness 上下文组装无统一载体
10. **[§15] Escalation 记录 8 字段 + DISPUTED Gate + P0 通知限流缺失**——升级链路只有骨架

---

*审计员注：本报告为只读审计，未修改任何代码。三条"不符"（§4.1 exec/DB、§7.1 白名单、§7.4 listen）已由审计员独立复验确认；其余条目证据来自三组审计员的 grep + 函数体阅读记录（原始材料：/tmp/audit-a.md、/tmp/audit-b.md、/tmp/audit-c.md §1–§15 部分）。*
