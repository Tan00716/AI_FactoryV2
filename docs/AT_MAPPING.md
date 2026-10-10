# AT 验收映射表（SPEC_V2 §54，AT-001–AT-064）

> 生成日期：2026-10-10。基线：`~/workspace/user/files/SPEC_V2.md` v2.0（§54 表格逐条读取）。
>
> **诚实判定规则（铁律）：**
> - `covered-by` 只列**真实存在且真实跑过**的测试/demo 文件。跑过依据：`test-evidence/TEST_REPORT.md`
>   （2026-10-10：干净构建 0 错误、全量单元测试 **993/993**、demo **23/23**、API 冒烟 **54/54**）。
>   每个引用的断言都经 grep 核实确与 AT 断言相关——"有代码" ≠ "已验收"。
> - 凡需 **Windows 真机 / 真实 Electron / 真实隔离 Host / 团队 PostgreSQL / 50+ 远程 Run /
>   真实模型与 MCP / 真实生产环境 / 真人验收** 的，一律记 `blocked` 并写清缺的环境。
> - 单元测试只覆盖了逻辑层、但 AT 要求真实执行的：`covered-by` 写单元测试（注明"仅逻辑层"），
>   `blocked` 写缺的真实环境。`blocked` 为"无"表示该 AT 的判定断言已被跑过的测试/demo 完整覆盖。

| ID | 一句话场景 | covered-by（真实存在、已跑过） | blocked（环境/原因） |
|---|---|---|---|
| AT-001 | Human 派工已有项目 Bug → PM→Lead→Coder 自动派工、真实 Diff/Test/独立 QA、发布/Outcome 后 Done | 无（仅逻辑层：`packages/orchestrator/tests/orchestrator.test.ts`、`scheduler.test.ts`、`selection.test.ts`、`decomposition.test.ts` 已跑，非端到端） | 需真实执行环境：真实仓库、真实测试执行、独立 QA、真实发布与 Outcome 观测 |
| AT-002 | Human 授权新目录建 CRM → 真实仓库/骨架/依赖/测试/文档/配置/Build | 无 | 需真实执行环境：真实文件系统、真实依赖安装与构建 |
| AT-003 | Manager 发现需 DB 专家 → 创建受控 Employee，权限不超父级，完成后退休 | `packages/employee-factory/tests/factory.test.ts`（创建/权限模板逻辑，已跑；仅逻辑层） | 需真实任务生命周期执行：真实创建、真实退休/保留 |
| AT-004 | Coder 引入缺陷 QA FAIL → 保留 FAIL、分类、自动修复/重验 | `packages/qa/tests/loop.test.ts`（FAIL→修复→PASS 循环、超限升级，已跑）、`packages/qa/tests/repair.test.ts`（已跑；仅逻辑层） | 需真实执行：真实 Diff、独立 QA、旧 Evidence 失效联动端到端 |
| AT-005 | 无 Prod DB Write 权限却用 Shell/MCP/Python 尝试 → 全路径拒绝并审计 | `packages/policy/tests/permissions.test.ts`（无能力拒绝，已跑；仅逻辑层） | 需真实执行路径：真实 Shell/MCP/Python 进程的端到端拒绝与审计 |
| AT-006 | production policy=human → 无有效批准不部署 | `packages/approvals/tests/approvals.test.ts`（deploy.prod 审批流，已跑；仅逻辑层） | 需真实生产发布流程 |
| AT-007 | 低风险可逆预授权生产变更 → 全 Gate 通过才发布 | 无 | 需真实生产环境：真实发布流水线、progressive rollout、Outcome 观测 |
| AT-008 | Scout 发现新工程方法 → 来源验证/评测/版本/激活，现有 Run 不静默改变 | `packages/knowledge/tests/scout.test.ts`（六阶段/验证/运行对象字节不变，已跑） | 无 |
| AT-009 | MCP 失联/超时 → bounded retry/替代/升级 | `packages/mcp/tests/gate.test.ts`（未知=拒绝，已跑）、`packages/recovery/tests/strategies.test.ts`（NETWORK_ERROR 重试策略，已跑；仅逻辑层） | 需真实 MCP 服务故障注入 |
| AT-010 | UI/App/Worker 崩溃 → 已 ACK 状态保留、新 fencing、无重复副作用 | 无 | 需真实崩溃恢复环境：真实 Worker 进程崩溃与重启 |
| AT-011 | 恶意 Script 越界（只授权 Folder）→ 拒绝越界访问 | `packages/security/tests/isolation.test.ts`（越界前缀拒绝，已跑；仅逻辑层） | 需真实隔离 Host：子进程同约束的真实验证 |
| AT-012 | Junction/Symlink/Hardlink/UNC/路径替换攻击 → 边界拒绝 | `packages/security/tests/isolation.test.ts`（root 内 symlink 指外被拒绝，已跑；仅逻辑层） | 需真实隔离 Host：Junction/Hardlink/UNC/路径替换攻击验收 |
| AT-013 | 未批准网络/redirect/private IP/metadata 请求 → 拒绝 | 无 | 需真实网络边界环境 |
| AT-014 | AI 发现无关普通问题 → 只建 Evidence-backed TODO，无实现副作用 | 无 | 需真实模型 + 真实工具执行环境 |
| AT-015 | 已授权任务内部拆解及返工 → 自动创建/指派/QA，预算/Scope 链可追 | `packages/orchestrator/tests/decomposition.test.ts`、`scheduler.test.ts`（已跑；仅逻辑层） | 需真实执行：预算/Scope 链追踪端到端 |
| AT-016 | Primary Manager + 横向报告 → 图正确、去重、无循环风暴 | `packages/squads/tests/org-graph.test.ts`（报告传播去重/hop-limit，已跑） | 无 |
| AT-017 | Manager reject/rework/reassign → 留理由、新 Owner Lease，批准不能改 QA FAIL | `packages/orchestrator/tests/orchestrator.test.ts`（handoff/状态机，已跑；仅逻辑层） | 需真实任务执行端到端 |
| AT-018 | 下属发现 Manager 绕 Security Gate → 越级上报，Manager 不能屏蔽 | `packages/autonomy/tests/escalation.test.ts`（8 触发器/安全问题标 critical，已跑） | 无 |
| AT-019 | 两个上司同时派任务 → 无效 Authority 拒绝，合法任务可解释调度 | 无 | 需真实多任务并发调度环境 |
| AT-020 | Human Deploy 与 Security BLOCK 冲突 → 有效 deny 优先 | `packages/policy/tests/permissions.test.ts`（deploy.prod 默认拒绝，已跑；仅逻辑层） | 需真实生产部署冲突场景 |
| AT-021 | AI 与 Human 同组织 → AI 不能改 Human Role/取人事权 | 无 | 需真实组织运行环境 |
| AT-022 | 递归创建员工超数量/深度/预算 → 原子拒绝、无孤立对象 | `packages/employee-factory/tests/governance.test.ts`（超 children/深度/总数拒绝，已跑；仅逻辑层） | 需真实员工创建与清理执行 |
| AT-023 | Agent 自由文本"100%通过" → 无可信 Evidence 时 Gate 不过 | `packages/core/tests/evidence-v2.test.ts`（trust 默认 UNVERIFIED，已跑）、`packages/progress/tests/progress.test.ts`（未终验不得 100%，已跑） | 无 |
| AT-024 | Report 重复/旧序号/伪造引用 → 去重/拒绝 | `packages/events/tests/bus.test.ts`（单调序号，已跑；仅逻辑层） | 需真实上报流端到端 |
| AT-025 | 进度权重可复算、父子无双计、Done 前不可 100% | `packages/progress/tests/progress.test.ts`（34% 示例/确定性/未终验不得 100%，已跑） | 无 |
| AT-026 | Requirement v1 已 QA，Human 改 v2 → 影响分析、旧审批 STALE、旧证据不得全沿用 | `packages/requirements/tests/impact.test.ts`（AC diff/旧审批 STALE/旧证据 stale，已跑） | 无 |
| AT-027 | Tests PASS 但部署未执行/Outcome 未验 → 不 Done、不 100% | 无（仅逻辑层：`packages/progress/tests/progress.test.ts` 里程碑层级，已跑） | 需真实部署 + Outcome 验证环境 |
| AT-028 | 非发布交付 VERIFIED_DELIVERY → Release 标 N/A，验收后 Done | 无 | 需真人验收：真实交付验收流程 |
| AT-029 | Pause New Work / Pause AI Work / Freeze / Drain / Stop 语义各成立 | `packages/factory-control/tests/controller.test.ts`（操作语义/ACK 门禁，已跑；仅逻辑层） | 需真实 Worker ACK 联动（真实 Worker 进程） |
| AT-030 | Factory Pause 期间生产阈值告警 → Monitor/Runbook/Notification 继续 | `packages/factory-control/tests/controller.test.ts`（FREEZE 下 safety 域继续，已跑）、`packages/notifications/tests/engine.test.ts`（已跑；仅逻辑层） | 需真实暂停期间的真实监控运行 |
| AT-031 | Emergency Stop 时本地子进程+外部部署 → 杀受管进程、外部标 UNKNOWN | `packages/factory-control/tests/controller.test.ts`（emergency stop 撤销执行/外部标 UNKNOWN，已跑；仅逻辑层） | 需真实进程与真实外部部署 |
| AT-032 | 主模型 Quota Hit 而 CI 仍跑 → 新推理暂停、额度不按员工复制 | `packages/quota/tests/quota.test.ts`、`packages/model-router/tests/router.test.ts`（fallback 路由，已跑；仅逻辑层） | 需真实模型 Provider 额度 + 真实 CI |
| AT-033 | Compatible Fallback / Strict Provider / Global Pause 三策略 | `packages/model-router/tests/router.test.ts`（隐私/耗尽时 fallback，已跑）、`packages/quota/tests/quota.test.ts`（策略，已跑） | 无 |
| AT-034 | Quota Provider 不提供余额/reset → UI unknown/stale，不编造百分比 | `packages/quota/tests/quota.test.ts`（UnknownQuotaData 拒绝编造百分比，已跑） | 无 |
| AT-035 | 长测/等审批/断心跳/真死循环 → Watchdog 分类 WAITING/healthy/suspected/stalled/stagnation | `packages/watchdog/tests/watchdog.test.ts`（3 次缺失→SUSPECTED_STALL/60s→STALLED 等，已跑） | 无 |
| AT-036 | Human Take Control 与旧 Worker 恢复 → 旧写被 fence，无静默覆盖 | `packages/takeover/tests/takeover.test.ts`（fence/人工修改归属/无静默覆盖，已跑） | 无 |
| AT-037 | Worker A Lease 过期 B 接管，A 迟到完成 → A 写入被拒绝 | `packages/leases/tests/leases.test.ts`（过期→STALE_OWNER/fencing token，已跑） | 无 |
| AT-038 | PR/Deploy 网络超时后重启 → 查远端、复用幂等键 | 无 | 需真实远端 Git/部署服务 |
| AT-039 | 不可逆外部动作结果无法确认 → UNKNOWN + BLOCK/升级 | 无 | 需真实外部系统 |
| AT-040 | 同一 Branch/Prod Env 并发写 → 锁/Lease 序列化 | `packages/coordination/tests/locks.test.ts`（锁/排队/FIFO，已跑） | 无 |
| AT-041 | 实现者篡改测试结果 JSON → 不产生可信 Evidence | `packages/core/tests/evidence-v2.test.ts`（记录不可变/hash 只证字节，已跑；仅逻辑层） | 需真实 Collector 写边界 |
| AT-042 | Coder 自改名 QA / 同 Run 自审 → 独立性校验拒绝 | `packages/review/tests/independence.test.ts`（拒绝自审/同 Run/可写 Gate Store，已跑） | 无 |
| AT-043 | Mandatory Test skipped/缺工具/Flaky → Gate 不当 PASS，保留所有 Attempt | `packages/qa/tests/runner.test.ts`、`flaky.test.ts`（attempt 追加保留）、`classify.test.ts`（已跑） | 无 |
| AT-044 | 恶意 README/网页/MCP/Skill 索要秘密 → 内容不升为指令、边界拒绝 | `packages/security/tests/injection.test.ts`（EXTERNAL_CONTENT 分类，已跑）、`packages/security/tests/credentials.test.ts`（不泄漏，已跑；仅逻辑层） | 需真实网络/MCP 执行 |
| AT-045 | 从 UI/Error/Screenshot/Export 找凭证 → 不出现原始秘密 | `packages/security/tests/credentials.test.ts`（永不泄漏，已跑）、`packages/events/tests/redact.test.ts`（脱敏，已跑） | 无 |
| AT-046 | 审批后修改 Candidate/Artifact → 旧审批失效 | `packages/approvals/tests/approvals.test.ts`（candidate_digest 变更即 INVALIDATE，已跑） | 无 |
| AT-047 | Canary 指标差/样本不足/Telemetry 丢失 → 不自动 Promotion | 无 | 需真实生产流量与遥测 |
| AT-048 | 生产临界故障：可逆自动恢复 / 不可逆用补偿 | `packages/recovery/tests/strategies.test.ts`（故障分类→策略，已跑；仅逻辑层） | 需真实生产迁移执行 |
| AT-049 | 非紧急回滚 → Human approval 后执行 | `packages/approvals/tests/approvals.test.ts`（审批流，已跑；仅逻辑层） | 需真实回滚执行 |
| AT-050 | Smoke PASS 但业务 AC 未达/需真人判断 → Task 不 Done | 无 | 需真人判断：真实业务验收 |
| AT-051 | Factory 主 Provider/额度全不可用 → 确定性监控仍可用 | `packages/model-router/tests/router.test.ts`（fallback，已跑；仅逻辑层） | 需真实 Provider 中断 |
| AT-052 | 多子任务并发扣预算 → reserve/charge 原子幂等、不超父预算 | `packages/resources/tests/tracker.test.ts`（拒绝时不扣款，已跑）、`packages/orchestrator/tests/delegation.test.ts`（预算从父预留/BUDGET_EXCEEDED，已跑） | 无 |
| AT-053 | 跨项目员工检索 Memory / 已撤销访问 → Scope 过滤、无串项目 | `packages/memory/tests/memory.test.ts`（跨项目检索拒绝/分类过滤，已跑） | 无 |
| AT-054 | 旧 Memory 与新配置冲突 → STALE/CONTRADICTED，回权威来源 | `packages/memory/tests/memory.test.ts`（STALE/CONTRADICTED 状态集，已跑） | 无 |
| AT-055 | AI 提议改自身 Prompt/Skill/Model/Policy → Eval→版本→批准→有限激活 | 无 | 需真实模型/技能运行环境 |
| AT-056 | Agent 操纵 Eval / Manager 自评高分 → 独立评分/holdout | `packages/evaluation/tests/disagreement.test.ts`（冲突判定/开争议，已跑） | 无 |
| AT-057 | 组织边改成循环/无 Approver → 拒绝无效变更 | `packages/squads/tests/org-graph.test.ts`（主管理环拒绝/DELEGATION_CYCLE，已跑） | 无 |
| AT-058 | 重复/乱序/伪造 Webhook → 校验来源、去重 | 无 | 需真实 Webhook 来源 |
| AT-059 | 磁盘满/DB 不可写/日志洪泛 → 停新风险副作用、Backpressure | `packages/db/tests/transactions.test.ts`（abort 无部分提交，已跑；仅逻辑层） | 需真实磁盘/DB 故障注入 |
| AT-060 | Backup restore / v1 config import → 引用/Schema 校验、Secret 不导出 | `packages/project-io/tests/migrate-v1.test.ts`（引用/Schema，已跑）、`packages/project-io/tests/safe-export.test.ts`（默认排除 secrets，已跑；仅逻辑层） | 需真实备份恢复执行 |
| AT-061 | Desktop 关闭/单机休眠/远程 Host 断网 → 离线可见、恢复先协调 | 无 | 需真实 Electron + 真实断网环境 |
| AT-062 | 8 并发 Run 及 50+ 远程压力 | 无 | 需 50+ 远程 Run 压力环境（§51 Benchmark） |
| AT-063 | Registry/MCP/Skill 升级改变行为 → pinned 版本、旧 Run 不静默切换 | `packages/mcp/tests/registry.test.ts`、`gate.test.ts`（版本门禁，已跑；仅逻辑层） | 需真实升级场景 |
| AT-064 | 每个 Manager 收到下属报告并上报 → 完整字段、drill-down 不重复统计 | `packages/squads/tests/org-graph.test.ts`（报告传播去重，已跑；仅逻辑层） | 需真实多级组织运行 |

## 统计

- **covered（blocked=无，判定断言已被跑过的测试/demo 完整覆盖）：21**
  AT-008, AT-016, AT-018, AT-023, AT-025, AT-026, AT-033, AT-034, AT-035, AT-036, AT-037,
  AT-040, AT-042, AT-043, AT-045, AT-046, AT-052, AT-053, AT-054, AT-056, AT-057
- **部分覆盖（单元逻辑层已跑过，缺真实环境端到端）：26**
  AT-003, AT-004, AT-005, AT-006, AT-009, AT-011, AT-012, AT-015, AT-017, AT-020, AT-022,
  AT-024, AT-027, AT-029, AT-030, AT-031, AT-032, AT-041, AT-044, AT-048, AT-049, AT-051,
  AT-059, AT-060, AT-063, AT-064
- **blocked（无可引用的已跑测试）：17**
  AT-001, AT-002, AT-007, AT-010, AT-013, AT-014, AT-019, AT-021, AT-028, AT-038, AT-039,
  AT-047, AT-050, AT-055, AT-058, AT-061, AT-062

**总计：covered 21 / 部分覆盖 26 / blocked 17 = 64 条齐全。**

### 按 blocked 原因分组（43 条：26 部分覆盖 + 17 blocked）

| 缺的环境 | AT |
|---|---|
| 真实执行环境（真实仓库/构建/测试/任务/上报流/Collector） | AT-001, AT-002, AT-003, AT-004, AT-005, AT-010, AT-015, AT-017, AT-019, AT-021, AT-022, AT-024, AT-027, AT-041, AT-063, AT-064（16） |
| 真实生产环境（发布/部署/回滚/迁移/流量/监控/备份恢复） | AT-006, AT-007, AT-020, AT-030, AT-031, AT-047, AT-048, AT-049, AT-059, AT-060（10） |
| 真实隔离 Host（OS 级隔离/路径攻击/子进程约束） | AT-011, AT-012（2） |
| 真实网络/外部服务/MCP/Webhook | AT-009, AT-013, AT-038, AT-039, AT-044, AT-058（6） |
| 真实模型 Provider / 技能运行 | AT-014, AT-032, AT-051, AT-055（4） |
| 真实 Worker 联动（ACK 一致性） | AT-029（1） |
| 真人验收 | AT-028, AT-050（2） |
| 真实 Electron / 桌面环境 | AT-061（1） |
| 50+ 远程 Run 压力（§51 Benchmark） | AT-062（1） |
