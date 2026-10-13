# SPEC_V2 59 章覆盖扫荡（SPEC_COVERAGE_BATCH31）

- 基线：`d81857a`（Batch 30）
- 扫荡日期：2026-10-13
- 方法：按 SPEC_V2.md 59 章目录逐章核对当前实现状态；零产品代码改动；凡本报告引用的符号均经 grep + 源码对读确认（本批未重跑测试，不重复验证测试结论，只核实现存在与否）
- 状态口径：**已落地**=核心机制真实存在且被接线；**部分**=有骨架但缺关键分支/字段/接缝；**未做**=无代码；**环境依赖**=需要真实机器/服务/账号环境才能补；**Tan专属**=只能由 Tan 决策或亲自执行；**滞后（文档）**=实现已落地但某文档仍写"未做"，已在本批纠偏

## 逐章结论

| 章 | 状态 | 一句话结论 | 证据指针 |
|---|---|---|---|
| §1 Final Goal | **部分** | 核心体验链路的派工/证据/独立验证/Final Report 均有真实现，但完整闭环仍被真模型回路（Codex 登录）与真隔离环境阻塞（AT-001 端到端未验收） | `apps/server/src/routes/final-report.ts`、`packages/dashboard/src/aggregate.ts#computeAuthorizedOutcomeCompletionRate`（AOCR §1.2 已接 `GET /api/dashboard`，group-a 的"缺失"已在早先批次关闭） |
| §2 Product Principles | **大部分已落地** | 35 条不变量中绝大多数有真代码；INV-10（runs pin 版本：run_manifest 落盘）、INV-12（确定性进度）、INV-26（机密脱敏）、INV-29（router 不选 availability=offline，`packages/model-router/src/router.ts:141`——group-a 的"部分"已关闭）均有；剩余缺口见 INV-31 | INV-31（§8.1 多人指令冲突仲裁）全库无 `AUTHORITY_CONFLICT` 符号——**未做**，已补入 KNOWN_LIMITATIONS（本批） |
| §3 产品范围与自主权 | **部分** | 顶层票 + dispatch=true + 授权动作 UI（DispatchPanel）+ WAITING_HUMAN_DISPATCH（Batch 17）均已真实现；**远程项目（真实远程项目支持）未做**（`packages/projects/src` 无 remote 代码；远程 Host 本体未做，已记在"数据与团队"） | `apps/server/src/index.ts:1042`（dispatch 路由） |
| §4 架构 | **部分** | A 方案落地：控制面/执行面分离、单机单写 SQLite、Outbox、事件投影；B 远程 Host **未做**、C 不作为首发（规格本意）；多人经共享 SQLite 文件是规格明确禁止的快捷方式，未做（PostgreSQL 未做，已记） | `docs/KNOWN_LIMITATIONS.md#数据与团队` |
| §5 模块边界与责任 | **部分** | §5"通知内容不泄露秘密"已落地（`redactSecrets` 为通知引擎 choke point，`packages/notifications/src/engine.ts:14-25` + engine.test.ts 钉住——group-a 的"部分"已关闭）；"AI 不得提高自身/下属权限上限"仍只有绝对上限检查，**无相对上限检查**（`packages/employee-factory/src/governance.ts`）——**未做**，已补入 KNOWN_LIMITATIONS（本批） | `packages/notifications/tests/engine.test.ts:82` |
| §6 Project | **部分** | 自动发现（diagnostics、detected-vs-verified、容器/VM/README/docs/.ai 检测——group-a 缺口已关闭）、创建（非空目录守卫 §6.3，`create.ts:144`，group-a 的"缺失"已关闭）、项目归档（Batch 14）、archived 守卫均有；剩余：**项目记录 13 字段缺 11 个**（schema 只有 id/name/description/path/created_at/updated_at + data_classification）、**Clone Repository 入口无**、**模板硬编码无扩展注册**、**项目知识 9 类无结构**——均未做，已补入 KNOWN_LIMITATIONS（本批） | `packages/projects/src/discover.ts:415`、`packages/projects/src/create.ts:144`、`packages/db/src/schema.ts:178` |
| §7 Workspace 与隔离 | **部分（环境依赖）** | 完整 Shell（真 PTY Batch 18、交互式会话 Batch 19、逐行安全门）、路径边界（大小写/Unicode/UNC/设备路径/Junction/Symlink，isolation.ts）、fail-closed（CONFINEMENT_UNAVAILABLE 有单测）均有；**无真实隔离 Host**（本机直跑，非合规后端）——已记环境项；TOCTOU/替换路径/hardlink 仍是代码注释承认的开放点 | `docs/KNOWN_LIMITATIONS.md#隔离与安全` |
| §8 Human Identity | **部分** | Custom Roles + RBAC（Batch 15：viewer/operator/admin）、委托不超上限（scope.ts）、撤销停止发放新 Capability + 执行点拒绝已撤销 grant（tools/executor.ts:409）均有；**AUTHORITY_CONFLICT 仲裁缺失**（§8.1，如 §2 所述） | `packages/core/src/scope.ts` |
| §9 Organization Graph | **部分** | 图模型（org-graph.ts：节点/边类型/方向约定/MANAGES 投影）、默认模板、周期传播 dedup+hop limit 均有；**组织关系与委托链只在进程内存**（Map），重启丢失；图变更事务化/版本化、环校验、tombstone 引用保留**未做** | `packages/squads/src/org-graph.ts:120-121`（Map）、`docs/AT_MAPPING.md` AT-057 blocked |
| §10 AI Employee | **部分** | 员工定义（Mission/capabilities/预算上限）、create_ai_employee 治理（max_children/depth/预算，Batch 18）、task-scoped 专家退休均有；**版本化生命周期 DRAFT→…→ARCHIVED 全链路未做**（factory.ts 无 lifecycle 迁移机） | `packages/employee-factory/src/governance.ts` |
| §11 Instructions | **部分** | Run Manifest 落库（Batch 15：指令/政策/技能版本来源清单）、AGENTS.md 待验证外部内容、记忆/技能不扩大 Capability 均有；Manager/Executor 核心指令契约（§11.3/11.4）为代码注释的 check 清单形态，**无显式"契约违反拒绝"机** | `packages/db/src/schema.ts`（run_manifests） |
| §12 Management Runtime | **部分** | 管理循环（delegat→monitor→review，orchestrator 包）、选人硬约束、Manager 失效监督均有；**委托对象只在进程内存**（delegation.ts Map）、预算从父任务原子预留**未做**（原子 reserve 有但父级预留链未接），深度/并发上限有治理 | `packages/orchestrator/src/delegation.ts:136` |
| §13 动态员工/Task Squad | **部分** | 员工创建治理、Task Squad（squad.ts）、跨项目 Scope 重置均有；squad 归档/临时专家退休为逻辑存在（退休归档无持久化事件） | `packages/squads/src/squad.ts` |
| §14 报告 | **部分** | Structured report schema（schema_version/sequence 单调/self_assessed_confidence 主观标注）、Drill Down、横向报告范围均有；**报告只在进程内存**（comms Map），重启丢失；报告引用不存在时的拒绝已做 | `packages/comms/src/report.ts:197` |
| §15 Escalation | **部分** | 升级路径（Security/Human）、P0 通知限流、越级不可屏蔽均有建模；escalation 无 DB 表（进程内存）；**DISPUTED Gate + ESCALATED Condition 的系统级状态机接线未做**（disputes 是 verdict 分歧协调器，非任务级状态） | `apps/server/src/routes/disputes.ts`（coordinator 进程内） |
| §16 Requirement | **已落地** | 需求版本化（immutable version 行）、AC 稳定 ID、需求变更影响分析（STALE 门/兼容声明/旧证据不复用）、completion_target、v1→v2 兼容规则均已真实现并落库（Batch 12 的 F2 残留全部关闭） | `packages/db/src/schema.ts`（requirements/requirement_versions/requirement_links/promotion_holds/evidence_compatibility） |
| §17 Task | **已落地** | Task 字段（UUID + 稳定票号）、授权轴 DRAFT→WAITING_HUMAN_DISPATCH→AUTHORIZED（Batch 17，落库）、子任务继承 + Scope Checker（Batch 18）、依赖 DAG（环/缺引用校验）、Proposal 流程均有 | `apps/server/src/index.ts:1042-1069`（dispatch 流路由） |
| §18 Workflow State Machine | **已落地** | 三态分离（stage/condition/里程碑）、全阶段表、Transition 事务合约（version/授权/candidate/gate 校验 + Outbox）、finalize 唯一 Done 路径 + final_seal 同事务、门禁拒绝 422、非法 jump/重复事件处理均有并落库 | `apps/server/src/routes/*v2*`、`packages/db/src/schema.ts`（task_v2_state） |
| §19 五层完成 | **已落地** | 五层里程碑精确语义、UAT/Merge 组合 revision 重验、ROLLBACK 后 RELEASED 失效、COMPLETION_INVALIDATED 追加历史、VERIFIED_DELIVERY + N/A 依据均有 | `docs/AT_MAPPING.md` AT-025/027/028 |
| §20 Progress Engine | **已落地** | 叶子权重公式、最终封印独立校验、权重版本锁定、返工 c_i 可下降、UI 展开计算项均有；权重值是本地默认口径（规格只给示例） | `packages/progress/src/engine.ts` |
| §21 Scheduler | **已落地** | 九项硬约束前门禁（Batch 16）、多因子排序、aging、P0 安全点抢占、Monitor/Recovery 预留槽、预算 reserve→charge→settle 原子、Human Override 不复活被剔除候选均有；Optimizer 打分权重是本地默认值 | `packages/orchestrator/src/scheduler.ts` |
| §22 Worktrees/Lease/Fencing | **已落地** | 独立 worktree/分支分配（worktrees 表 + 部分唯一索引，Batch 19）、Git Broker 动作门、drain 租约 + per-entry tryClaim + enqueue position 仲裁（Batch 23/26）、资源锁/Lease（fencing token、STALE_OWNER 拒绝）均有；worktree 是任务级文件隔离**不是** OS 安全隔离（已记） | `packages/db/src/schema.ts`（worktrees/merge_queue_drain_locks） |
| §23 Policy/Approval | **已落地** | 政策作用域 merge、Deny 优先、Capability Token 模型、审批对象全字段 + PENDING→…→INVALIDATED 状态机、代码变化致旧审批失效、Exception Grant（有审计的豁免，FAILED 保留不改 PASS）、Tool Approval 四档均有 | `packages/approvals/src/{types,manager,exceptions}.ts` |
| §24 Factory Runtime | **已落地** | 三轴状态（control/health/capacity 分存）、全部操作语义（START/PAUSE NEW WORK/PAUSE AI WORK/FREEZE/DRAIN/GRACEFUL STOP/EMERGENCY STOP）、control epoch + Worker ACK（不假显示）、睡眠/恢复 reconciliation、默认 Pause New Work 均有 | `apps/server/src/routes/factory-control.ts` |
| §25 Harness | **已落地** | Loop 九步、run 状态机、intent 先行持久化（Batch 9）、预算/超时/重试/backoff、权限拒绝不换工具绕过、LOOP_STAGNATION（三连同 fingerprint）均有 | `packages/runtime/src/loop.ts`、`packages/db/src/schema.ts`（step_intents） |
| §26 Model Registry | **部分** | CodexAdapter 真实现（JSON-RPC 双传输、全协议链路、真 turn 待登录）、适配器契约（UNSUPPORTED 不模拟）、Fallback 不跨数据分类、账号状态真实接线（Batch 3/30）均有；**除 Codex 外的适配器仍是 stub**——已记；官方商业/Hosted 集成资格需单独核对——**Tan专属/供应商事实** | `docs/KNOWN_LIMITATIONS.md#AI能力` |
| §27 Quota/Handoff | **部分** | Quota 按 Provider/Workspace/Bucket 记录、unknown 不编造百分比（INV-29）、三策略（STRICT/COMPATIBLE_FALLBACK/GLOBAL_PAUSE）、Handoff Package（引用+脱敏+无双写）均有；**真实 Quota 值待 Codex 登录**——环境依赖 | `packages/quota/src/handoff.ts` |
| §28 Durable Execution | **已落地** | Step intent/External ops（幂等键）/Checkpoint 落库、启动扫描（只报告不处置）、resume 逐项重校验（Batch 15）、恢复策略选择、磁盘满 safe mode 均有；未知副作用默认不重放 | `packages/db/src/schema.ts`（step_intents/external_operations/checkpoints） |
| §29 Observatory | **部分** | Agent Observatory（ObservatoryPanel：当前动作/heartbeat/工具/预算/Timeline）、Manager Drill-down（ManagerPanel）、Manager 团队视图均有；**真人点击验收未做**；SSE/WebSocket 实时投影存在，断线 stale 显示有建模 | `apps/desktop/src/components/{ObservatoryPanel,ManagerPanel}.tsx` |
| §30 Watchdog | **已落地** | 八类健康 + 与 Run State 分离、5s heartbeat/3 次缺失 SUSPECTED/60s STALLED、诊断分类（Worker lost/Tool hung/Provider/Quota/Lock/Approval/Loop）、恢复限流 + Circuit Breaker 均有；阈值按工具/Host 可配 | `packages/watchdog/src/watchdog.ts` |
| §31 TAKE CONTROL | **已落地** | 全序列（quiesce→revoke/fence→verify→snapshot→human ownership→return diff/reconcile→revalidate→new lease）+ TAKEOVER_PENDING 诚实显示 + Human 修改 author 记录 + 不静默覆盖均有 | `packages/takeover/src/manager.ts:100-116` |
| §32 Event/Audit | **已落地** | 事件 envelope 全字段、Outbox 事务 + drain 确认戳记、hash 链审计（verifyAuditChain 跨重启）、高影响事件脱敏审计、append-only 本地规则 + 外部锚定选项（文档注明管理员边界）均有；通知去重/合并/限流 + 脱敏 choke point 均有 | `packages/db/src/schema.ts`（outbox_events/audit_logs，prev_hash） |
| §33 Tool Registry | **已落地** | 11 分类枚举、全字段定义校验器、16 条内置定义目录（implemented/definition-only 诚实标注）、执行双层契约（Batch 21）、秘密引用注入 + 日志脱敏、空结果/超时/非零退出分别处理、Database 三环境身份 + Broker/Runbook（Batch 27/28/29）、Browser 隔离 Profile + 网站文本隔离契约（Batch 28/29）均有；**Windows 工具探测未真机验证**——环境依赖 | `packages/tools/src/{database,browser-profile,fetched-content}.ts` |
| §34 MCP | **部分** | 注册/元数据全字段、协商版本保存（§34.2）、Unknown 默认 BLOCK、信任流 HTTP 化（Batch 20）、注册表落库 + 跨进程写互斥（Batch 21/25）、install 并发审计（Batch 27）、launch 记录落库（Batch 26）、stdio 密钥注入（Batch 19）均有；**未接入真实 MCP 服务器做协议握手验证**——已记环境项 | `docs/KNOWN_LIMITATIONS.md#AI能力` |
| §35 Skills | **已落地** | 包格式、Metadata 全字段、状态机 DRAFT→…→RETIRED、Agent 自建技能默认 Proposal（安全检查→独立评测→版本→批准→激活）、按任务发现加载、升级不改变运行中版本均有 | `packages/skills/src/registry.ts:206-228` |
| §36 Git | **已落地** | Broker 动作门、五字段 git evidence（Batch 21）、Merge Queue 落库 + 双层互斥（Batch 20/23/26）、合并候选组装验证、结构化变更分类、恶意仓库配置安全边界、artifactDigest 绑定（§40→§36，Batch 23/24/25）均有 | `docs/KNOWN_LIMITATIONS.md`（git evidence 条目） |
| §37 Code Review | **已落地** | Review 十维检查、PASS/WARNINGS/CHANGES_REQUESTED/BLOCK 输出、独立性校验（不同有效身份、Gate Store 不可写、禁止自审——资源不足明确 BLOCKED）、warnings 阈值由项目政策决定均有 | `packages/review/src/*`（独立性谓词） |
| §38 QA | **已落地** | QA 组织（按风险组建）、机器可读测试报告、skipped/timeout/缺工具不计 PASS、Mandatory skip 阻塞 Gate、Flaky 隔离 + 所有 Attempt 保留、七类失败分类路由、Repair 循环（失败证据→分类→授权修复→新 candidate→重验→独立 QA）均有；**UAT 需要真实验收环境/真人**——环境依赖 | `packages/qa/src/{loop,repair}.ts` |
| §39 Evidence | **已落地** | Artifact 类型全表、Evidence 合同全字段（证据 id/AC/候选/digest/环境指纹/采集者身份/hash/信任/有效期）、Gate Verdict 八态、evaluator 代码谓词（AI 不写 verdict）、证据不可变 + append 失效、MISSING_EVIDENCE 均有 | `packages/db/src/schema.ts`（evidence） |
| §40 CI/CD | **部分** | 环境记录（LOCAL/DEV/UAT/PROD + 自定义）、构建锁定（revision/lockfile/toolchain/定义/配置 → digest）、真实构建执行（Batch 24）、SBOM（Batch 25）+ 保留策略（Batch 26）、构建工作区孤儿清理（Batch 27）、Pipeline 结构、外部 CI 结果认证 Webhook 均有；**pipeline stage 未落盘**（重启后 `/run` 对 REHYDRATED stub 409 拒绝——已记）、**attestation 为 null**（签名密钥 Tan专属）、去重/旧 Job 拒绝有 | `docs/KNOWN_LIMITATIONS.md`（§40→§36 条目；pipeline stage 见 Batch 30 扫荡） |
| §41 Production | **部分** | 风险四级（LOW→CRITICAL 默认授权）、可逆性四类、pre-deploy 全 Gate 清单、canary（cohort/样本/阈值/最小样本量/HOLD）、观察窗口、Outcome Gate、紧急回滚（预授权 Runbook/不可逆不假回滚）均有**规则与管道实现**；**真实生产环境演练、canary 真实流量、故障注入、24h 稳态均未做**——环境依赖（已记） | `packages/cicd/src/{risk,predeploy}.ts` |
| §42 运维/事故 | **部分** | Incident 生命周期（DETECTED→CLOSED）、Runbook（触发器/环境/动作/blast radius/预算/审批/停止点）、事故→缓解→恢复→汇报、生产事故不能靠改阈值消失、确定性安全动作不依赖模型均有；**真实事故演练/恢复演习未做**——环境依赖 | `packages/incidents/src/manager.ts` |
| §43 Memory | **部分** | Memory 五 scope、schema 全字段（来源/置信/时效/supersedes）、scope 先行 ACL 过滤、冲突记录、禁止范围（不存秘密、不授权限、不改 AC）均有并落库；**撤销后索引/Cache/Backup 同步清理**的"同步"二字是策略声明，真实跨存储一致性未验证——部分 | `packages/memory/src/{guards,registry}.ts` |
| §44 Knowledge | **已落地** | 四级 Knowledge、生命周期 DISCOVERED→RETIRED、来源记录（URL/发布时间/版本/Hash/License）、Knowledge Scout（独立预算，collect→proposal，不直接改运行中技能/政策）、Update Feed 均有 | `packages/knowledge/src/{store,feed,scout}.ts` |
| §45 Evaluation | **部分** | 测量指标（任务成功/首验通过/逃逸/自报完成/工具失败/回滚/升级）、Manager 额外维度、改进闭环（提案→独立评测→版本→批准→有限激活→观察→推广/回退）、holdout 分离、自动治理（只降不升）均有；**真实 eval harness 规模化运行、Manager 评测闭环未真实验证**——环境依赖 | `packages/evaluation/src/{engine,harness,proposals}.ts` |
| §46 Security | **部分** | Threat model（46.1，含"本机管理员攻陷在保证之外"的文档声明）、Secret Broker 四后端 + TTL 租约（46.2，Batch 18）、untrusted data 为 DATA/EXTERNAL（46.3）、Electron 安全基线（46.4）、供应链（版本/Hash/签名检查，46.5）均有；**OS keychain 后端未在真实 keyring 上实测**（仅 fake runner）——已记；**无真实隔离 Host**——已记 | `docs/KNOWN_LIMITATIONS.md`（§46.2 条目） |
| §47 备份/恢复 | **已落地** | Snapshot 分类（Git/Workspace/DB/外部恢复点）、一致性 DB 快照 + manifest、pre-restore 自动备份 + 重启生效、备份计划（Batch 20）、retention 双轴（天数+keepCount）+ legal hold、项目归档/删除级联（不删 Human 原始仓库）、SBOM 保留（Batch 26）均有 | `packages/db/src/schema.ts`（retention_policies/legal_holds/backup_schedules/retention_tombstones） |
| §48 数据模型 | **部分** | 存储原则（SQLite+WAL+事务+单写者、UUID/ULID、scope 验证防 IDOR）、核心实体表 47 张、强制约束（版本唯一/环检查/fencing 单调/预算原子/outbox 同事务）均有；§48.2 实体集合中**未落库**：management_reports、delegations、escalations、proposals、organization_relationships、policy_versions、gate_definitions/evaluations（均进程内存或引擎内）——已补入 KNOWN_LIMITATIONS（本批） | `packages/db/src/schema.ts`（47 表） |
| §49 API 契约 | **已落地** | 领域操作表（17 个）、返回状态四态（ACCEPTED/APPLIED/EXECUTING/CONFIRMED）、16 个统一 reason code、核心 TS 契约类型（Zod/JSON Schema 校验、actor 由服务端派生不信客户端）、项目政策 YAML 示例均有 | `packages/api-contracts/src/{types,validators,reason-codes}.ts` |
| §50 UI | **部分** | IDE 结构（顶栏/侧栏/中央/底部）、Monaco 编辑器、真 PTY 终端（Batch 18/19）、§50.2 的 11 个必须页面基本有对应组件（设置/导入导出面散在 Backup/TopBar/Project 面板，无独立 Settings 组件）、创建任务最短流程（DispatchPanel）、透明性（状态区分显示）、Final Report 内容清单均有；**真人点击验收未做**——已记 | `apps/desktop/src/components/`（37 个组件） |
| §51 NFR | **部分** | 数值目标已全部写入规格（可靠性/可恢复性/隔离/并发 8/50+/UI p95/重启恢复 30s/存储背压/审计追溯/迁移兼容/隐私）；**实测 Benchmark 均未做**（OS/CPU/项目规模基线记录缺）——环境依赖，已记在"数据与团队" | `docs/KNOWN_LIMITATIONS.md#数据与团队` |
| §52 Import/Export | **已落地** | `.ai/` 文件结构、脱敏导出（无 Secrets/OAuth/Capabilities/活跃 Lease）、导入当不可信数据（Schema/Hash/路径穿越/归档炸弹/可执行/License 校验、DRAFT/QUARANTINED 起步、权限重映射）、v1 迁移规则（旧 DONE 标 legacy_completion_unverified、旧 Memory UNVERIFIED）均有 | `packages/project-io/src/*` |
| §53 技术选型 | **已落地** | 选型表（Electron/React/Monaco/xterm/Node/SQLite/Drizzle/事件/选路）、交付依赖图顺序（不先做无限权限 Shell）、最小完整证明链路均有；依赖版本以官方来源核对——持续性工作 | `docs/packaging.md`、`docs/adr/0002-v2-architecture.md` |
| §54 验收套件 | **部分（环境依赖）** | AT_MAPPING.md 对 64 条逐条映射 + 铁律（有代码≠已验收）；单元/逻辑层覆盖已跑（当前树 2304/2304 + server 275/275）；**没有任何一条 AT 达到端到端验收**——全部被"需真实环境"阻塞（真机/真隔离 Host/真生产/真人验收），已记 | `docs/AT_MAPPING.md`、`docs/KNOWN_LIMITATIONS.md#数据与团队` |
| §55 产品 DoD | **部分** | 10 条 DoD 中：2（真实闭环）、4（Shell 隔离）、5（状态由系统决定）、6（控制/配额/看门狗/恢复）、7（生产演练）、8（自改进）、9（多人/远程）均未达到完整验收；SELLABLE_CHECKLIST 每批跟踪 | `~/workspace/goals/ai-factory-app-prototype/files/SELLABLE_CHECKLIST.md` |
| §56 盲点登记 | **部分** | 23 条盲点已转成对应规范/验收（表内逐条映射 §/AT）；**"是否阻止继续"列的门禁是文档声明，真实门禁代码只覆盖了部分盲点**（如 Canary 无样本 HOLD 有、Pause 假状态有 ACK、磁盘满 safe mode 有；无限递归有治理上限、组织循环未做） | SPEC_V2 §56 表（23 条） |
| §57 决策登记 | **已落地** | 语义依据确认表（Q53–Q87 逐条采用规则）、未补造历史答案声明、27 条冲突统一规则均有文档；ADR 机制（docs/adr）+ 变更提案流程 | `docs/adr/0002-v2-architecture.md` |
| §58 迁移对照 | **已落地** | v1.0 135 章逐项追踪表（v2 对应位置 + 处理方式）完整 | SPEC_V2 §58 表（135 行） |
| §59 集成核对 | **部分** | 6 项官方核对（Codex/认证/Quota/商业资格/MCP 基线/Agent Builder 不依赖）+ 参考来源 S1–S5 + 变更治理规则均有；**官方文档随版本变化需持续重核**（Codex 真 turn 登录后需重核 quota 接口事实）——环境/持续性 | SPEC_V2 §59.1 表 |

## 本批文档动作

### A. 补入 KNOWN_LIMITATIONS 的规格缺口（规格要求、此前未记录）

1. **§8.1/INV-31 多人指令冲突仲裁缺失**：全库无 `AUTHORITY_CONFLICT` 符号；两个同等有效且不兼容的指令进入暂停并升级的机制未实现（`/api/disputes` 只处理 verdict 分歧）。
2. **§5 相对权限上限缺失**：`employee-factory/governance.ts` 的 `enforcePolicy` 只有绝对上限检查（children/depth/allow-lists/budget），无"请求者相对上限"检查——AI 仍可能请求自身上限内的权限但超出委托者可授予范围（§8.2 的委托不超集检查只在 scope.ts 的任务范围维度）。
3. **§6.1 项目记录字段缺 11 个**：projects 表只有 id/name/description/path/created_at/updated_at + data_classification；organization_id、profile_version、repository_refs、workspace_refs、instruction_refs、policy_version、default_manager_id、workflow_version、environment_refs、lifecycle_state 无处定义。
4. **§6.1 Clone Repository 入口缺失**：四个项目入口只有 Existing/Template/New+discover，无 clone 入口函数与路由。
5. **§6.1 模板不可扩展**：`templates.ts` 为硬编码 Record，无 registerTemplate 插件机制（规格明文"模板不是全部内置，必须可扩展"）。
6. **§6.4 项目知识 9 类无结构**：全库无 ProjectKnowledge 类型；Product Requirements…Lessons 九类在 knowledge/projects 包均无对应结构；来源版本/Hash 引用无实现。
7. **§48.2 实体集合未落库清单**：management_reports、delegations、escalations、proposals、organization_relationships、policy_versions、gate_definitions/gate_evaluations 只有进程内存或引擎内实现，无 DB 表（重启丢失）。注意这是诚实的"未做"记录，不是要求全部落库——落库优先级应按 §51 可靠性"不能丢 Task/Gate/Approval/Lease/Budget"先排 gates/delegations。

### B. 文档滞后纠偏（实现已落地、旧文档仍写"未做"/"部分"）

1. **INV-29**：group-a（2026-10-11）记"部分"，现 `packages/model-router/src/router.ts:141` 对 `availability=offline` 直接排除资格、degraded 降权且上报——已关闭。
2. **§5 通知脱敏**：group-a 记"部分"，现 `redactSecrets` 为通知引擎 choke point 并有 engine.test.ts 钉住——已关闭。
3. **§6.2 发现诊断**：group-a 记"缺失"，现 `discover.ts:415` 有 diagnostics（多 lockfile/未知命令/无测试分别记诊）——已关闭。
4. **§6.2 detected-vs-verified**：group-a 记"缺失"，现 `types.ts:92` 有 'verified' 状态——已关闭。
5. **§6.3 非空目录守卫**：group-a 记"缺失"，现 `create.ts:144` 永不覆盖非空目录（除非显式 force）——已关闭。
6. **§1.2 AOCR**：group-a 记"缺失"，现 `computeAuthorizedOutcomeCompletionRate` 已实现并接入 `GET /api/dashboard`（无数据时返回 null 不编造）——已关闭（真实值仍待真实任务流产生）。

### C. 未改动的文件

零产品代码改动。本批只写了 `gap-audit/SPEC_COVERAGE_BATCH31.md`（本文件）与 `docs/KNOWN_LIMITATIONS.md` 的新增条目。

## 收敛结论

- 59 章中：**已落地 26 章、部分 27 章**（"大部分已落地"计入部分）、环境依赖/Tan专属穿插于部分章节；**未做 0 整章**（未做的是章内子项）。
- 本次扫荡发现的"规格要求但文档未记录"缺口共 **7 项**（A 节），全部已补入 KNOWN_LIMITATIONS；发现的"文档说没做但实际已做"滞后共 **6 项**（B 节），实现均经源码确认。
- 剩余真实大项与 Batch 30 扫荡结论一致：pipeline stage 落盘、真实隔离 Host、非 Codex 适配器、MCP 真实握手、远程 DB 驱动、桌面真人验收；另加本批新发现的 AUTHORITY_CONFLICT 仲裁、项目记录字段/知识/模板扩展、实体落库清单——其中 AUTHORITY_CONFLICT 与 gates/delegations 落库是**纯代码可关闭**的候选，建议排进 Batch 32。
