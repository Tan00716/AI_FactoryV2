# AI Factory 实现完整度审计 — §46–§59（Group D）

- 审计日期：2026-10-11
- 规格基线：`~/workspace/user/files/SPEC_V2.md`（SHA-256 `45e6c5ca…`，v2.0 2026-10-05）
- 被审计代码：`~/workspace/ai-factory`（commit `47856d7`，40 packages + apps/desktop + apps/server）
- 方法：只读审计。逐章提取"必须/MUST/REQUIRED/不得/INV-xx/至少/恰好 N 种"类硬性条款，到源码验证导出符号、类、函数、状态机、路由是否存在且行为一致。忽略纯愿景描述；不列测试覆盖率问题。
- 结论速览：审计 **14 章**；确认**真缺口 21 条**（缺失 9 / 部分 12）；环境 BLOCKED 另计（见末节）。

---

## 逐章验证结论

### §46 Security、Secrets、Prompt Injection 与供应链 → 部分（4 缺口）

| 硬性要求 | 验证结果 |
|---|---|
| 46.1 威胁模型限制（本机管理员/内核攻陷超出沙箱保证）必须写入安全文档，不得以 "Zero Trust" 宣称无条件安全 | **缺口 G-01**：全仓无安全文档（`docs/` 仅 `AT_MAPPING.md`），该限制未书面化 |
| 46.2 Secret Broker：Windows Credential Manager 或 OS-protected store；secret 经引用/安全通道/短期租约提供，不写普通 DB/Prompt/日志/Git | **缺口 G-02**：无 OS keyring 集成。`packages/security/src/credentials.ts` 仅有 `SecretRef` 引用纪律；全仓唯一 "keyring" 是 `isolation.ts:189` 注释 |
| 46.2 Keyring 不可用时不得无声降级明文 | 未找到降级路径代码（无 keyring 可降级）；`SecretRef` 永不存明文 — 通过（以现有设计为准） |
| 46.3 不可信数据源分类；内容不得提升为最高层政策 | 通过：`packages/security/src/injection.ts`（`classifyContent`/`checkElevation`/`sanitizeUntrusted`） |
| 46.4 Electron Renderer：`nodeIntegration=false`、contextIsolation、sandbox、CSP；受控 preload IPC（认证/Schema/路径-动作授权） | **缺口 G-03**：仅 `contextIsolation: true`；`nodeIntegration` 未显式设置、`sandbox` 未启用、无 CSP、无 preload IPC（`apps/desktop/electron/main.ts:33-38` 自认 "Prototype: no preload/IPC bridge yet"） |
| 46.5 供应链：锁定软件/Skill/MCP 版本和 Hash；签名安装包；先验证兼容再激活 | **缺口 G-04**：MCP/Skill 仅版本键控（`name@version`），无 hash 字段、无签名验证；`electron-builder.yml` 无签名（certificate）配置 |

### §47 Snapshot、Backup、Retention 与项目生命周期 → 部分（3 缺口）

| 硬性要求 | 验证结果 |
|---|---|
| 重大变更前按政策 Snapshot；区分 Git Snapshot / Workspace 未提交修改 / DB Backup / 外部 Recovery Point | 部分：`packages/recovery/src/snapshot.ts` 的 `SnapshotStore` 有 take/seal/verify/restore（workspace 级） |
| 备份含一致性 DB snapshot、Artifact Manifest、原始证据、配置版本、恢复指令；Secret 不随普通导出 | **缺口 G-05**：无 DB backup/restore 实现（全仓无 DB 备份代码） |
| Restore 验证完整性、Schema version、引用闭包 | Workspace snapshot 的 `verify()` 有；DB 层无（同 G-05） |
| Retention 分类（任务/Audit/Trace/Evidence/Artifact/Memory/临时 Workspace），可配置期限 + Legal Hold | **缺口 G-06**：无 retention policy 实现、无 legal hold（仅 events bus 的内存 retention） |
| 删除 Worker 临时目录前确认无活动 Lease/Task 引用；未知引用阻止清理 | 未找到对应实现（与 G-06 同类缺口，不另编号） |
| Project Archive 阻止新执行、保留可查询历史；Delete 按 Scope/Owner/Retention 软删或实体清理；不得删除 Human 原始 Repository | **缺口 G-07**：无 project archive/delete 生命周期实现 |

### §48 数据模型与事务边界 → 部分（2 缺口）

| 硬性要求 | 验证结果 |
|---|---|
| 48.1 单机 SQLite + WAL、Foreign Keys、事务、单一控制面 Writer；UUID/ULID；标准字段（version/hash/UTC/actor）；实体含 org_id/project_id，Scope 校验防 IDOR | **缺口 G-08**：`PRAGMA journal_mode = WAL` 有（`schema.ts:6`），但从未执行 `PRAGMA foreign_keys = ON` — schema 有 REFERENCES 声明，外键不强制 |
| 48.2 实体集合（约 100 表/对象，20 领域） | **缺口 G-09**：SQLite 仅 13 张表；其余领域在各包内存 store。`approvals` 在 server 路径确用 `SqliteApprovalStore`（`routes/approvals.ts:50`），但 `leases`（`routes/leases.ts:32` 用 `new LeaseManager()` 内存 Map）、budget 等重启丢失 |
| 48.3 强制约束：requirement (id,version) 唯一、环检查、单 Writer Lease + fencing、Artifact/Evidence hash 校验、budget 原子 reserve/幂等 settlement | 通过：`packages/db/src/constraints.ts`（`RequirementVersionRegistry`、`assertAcyclicOnAdd`、`WriterLeaseGuard`、`verifyArtifactManifest`、`BudgetLedger` 等） |
| 48.4 关键事务：Authorize Task / Assign-Start / Transition / Deploy 脚本 | 通过：`packages/db/src/transactions.ts` 四个 TxScript |

### §49 API、事件与机器可读契约 → 基本齐全（1 缺口）

| 硬性要求 | 验证结果 |
|---|---|
| 49.1 主要操作表（16 项） | 基本通过：39 个路由文件覆盖；`evaluate_gate` 语义由 workflow gate predicates 承担 |
| 49.2 返回状态 ACCEPTED/APPLIED/EXECUTING/CONFIRMED；16 个统一 reason codes | 通过：`packages/api-contracts/src/reason-codes.ts` 含全部 16 码 |
| 49.3 `CommandEnvelope`（schemaVersion "2.0"、requestId、idempotencyKey、org/project scope）；**不得信任客户端提交的 actor**，服务器派生；Zod/JSON Schema 或等价校验（枚举/长度/作用域引用） | 通过：`applyServerActor` 覆盖客户端 actor（`validators.ts:145-153`）；validators 做长度/枚举/Ref 检查 |
| 49.1 submit_report / decide_report | **缺口 G-10**：`packages/comms/src/report.ts` 有 `ReportLog` 领域实现，但 `apps/server/src/routes/` 无 reports 路由（server 未 import comms） |
| 49.4 项目政策示例字段 | 通过：policy 包覆盖（抽查 authorization/workspace/verification 等键存在） |

### §50 UI 与用户操作 → 部分（5 缺口）

| 硬性要求 | 验证结果 |
|---|---|
| 50.1 IDE 结构（顶/左/中/底布局；Monaco；xterm.js + 受控 PTY；Human/AI 独立 session；secret 脱敏） | **缺口 G-11**：终端无真实 PTY（`TerminalPanel.tsx:4-6` 自认 "no real PTY"）；其余布局/Monaco 通过 |
| 50.2 必须的页面（11 项） | Dashboard/Board/TaskDetail/EmployeeDetail/Approvals/CI-CD/Knowledge/Skills/MCP/OrgGraph 通过；**缺口 G-12**：无完整 Settings 页（仅 TopBar "项目设置（导入/导出）"按钮）；**缺口 G-13**：无 Manager Team 视图（无 drill-down）；**缺口 G-14**：无 Agent Observatory per-worker 视图（OpsPanel 仅 factory 三轴状态，无 worker heartbeat/process/pause/take-control UI） |
| 50.4 Final Report 必含字段（Goal/AC、Requirement/Candidate、决策、Artifacts、Review/Test/Security/UAT、生产与 Outcome、恢复状态、团队、耗时/资源、例外、证据链接）；未发布交付标 NOT_APPLICABLE | **缺口 G-15**：`comms/report.ts` 有报告结构，但 desktop 无 Final Report 生成/展示入口（`api.ts` 无 final 相关） |
| 50.5 键盘可操作、离线 read-only 缓存等 | 未逐项静态验证；不列缺口 |

### §51 Non-functional Requirements → 部分（缺口计入 §48/§47）

多数为验收目标（数值型），属环境 BLOCKED。实现型条款：
- "所有已 ACK 持久命令在进程重启后存在；不能丢 Task/Gate/Approval/Lease/Budget" → **缺口 G-09 连带**：`outbox_events` 表存在但全仓无写入者（events bus 纯内存）；leases 内存态
- Disk-full safe mode → 通过（`packages/runtime/src/durable.ts:364-397` `DiskFullError`）
- 审计可追踪（Root Authorization→执行→证据→发布）→ 通过（audit_logs + 事件链）

### §52 Import、Export、文件结构与兼容迁移 → 齐全

| 硬性要求 | 验证结果 |
|---|---|
| 52.1 `.ai/` 结构；可提交物为脱敏配置；私密默认排除 | 通过（`project-io/src/export.ts`） |
| 52.2 导出默认无 Secrets/OAuth/Capabilities/活跃 Lease/私人会话；导出前权限检查 | 通过（`safe-export.ts`：`stripSecretValues` + 排除表） |
| 52.3 导入作不可信数据：Schema/Hash/路径穿越/归档炸弹/Executable/License 校验；Employee/MCP/Skill 先 DRAFT/QUARANTINED；权限重映射不继承 Admin | 通过（`untrusted-import.ts`：`QuarantineStatus`，employee/mcp/skill → QUARANTINED） |
| 52.4 v1 数据迁移规则 | 通过（`migrate-v1.ts` 五函数；调用方见 §58 G-19） |

### §53 技术选型、部署与工程依赖 → 部分（1 缺口）

| 硬性要求 | 验证结果 |
|---|---|
| 53.1 选型表（Electron、React+TS、Monaco、xterm.js、Node.js+TS、SQLite/WAL、Git CLI、MCP Client、electron-builder 等；"或等价"允许替代） | 基本通过：desktop 有 monaco-editor/react/xterm；DB 用 node:sqlite（"或等价"）；**缺口 G-16**：`electron-builder.yml` 有 NSIS 配置但**无签名配置**，且从未执行过打包（§46.5 签名安装包要求亦落在此） |
| 53.3 最小完整证明 | 属验收事项，BLOCKED（需真实模型） |

### §54 Acceptance Suite：端到端验收 → 缺失（1 缺口）

- **缺口 G-17**：无可运行的 e2e/acceptance 实现（`find -iname "*e2e*" -o -iname "*acceptance*"` 无结果）；仅有 `docs/AT_MAPPING.md` 映射文档。规格明言"仅有脚本文件或设计说明不能判 PASS"。

### §55 产品本身的 Definition of Done → 部分（1 缺口，其余 BLOCKED）

| 条款 | 验证结果 |
|---|---|
| 1（§54 场景通过）/ 4（真隔离）/ 6（故障注入证据）/ 7（测试生产演练）/ 9（团队模式验收） | BLOCKED（需真实环境，见末节） |
| 2（真实工程闭环+自动修复）/ 3（自动委托+汇报）/ 5（状态/证据版本绑定）/ 8（自改进闭环） | 代码层部分实现，需真实模型验证 — 列为 BLOCKED（环境），不计缺口 |
| 10（安装包、升级/备份/恢复、Secrets、审计、操作手册、Known Limitations 完整） | **缺口 G-18**：无 Known Limitations 文档、无操作手册（find "*KNOWN*" 无结果）；备份/恢复缺 DB 部分（G-05）；安装包未打过（G-16） |

### §56 Blindspot Register → 齐全（抽查）

抽查的关键盲点均有对应代码：canary 小样本/遥测丢失→HOLD（`cicd/src/canary.ts:9,22,35`）、自改进删测试→holdout 隔离（`evaluation/src/harness.ts:19-21` `HoldoutLeakError`）、Memory 串项目→ACL-first 检索（`memory/src/index.ts:13`）、无限递归员工→深度/数量/预算上限（`employee-factory/src/governance.ts:22,114`）、Review 独立性（`review/src/independence.ts`）、Disk full→`DiskFullError`（`runtime/src/durable.ts`）、路径逃逸→`security/src/sandbox.ts`。未发现无对应代码的盲点。

### §57 决策登记与冲突修正 → 仅记录（不计缺口）

按任务要求只记录：57.1 确认项、57.2 未补造历史答案（Q1–52 缺失的诚实声明）、57.3 冲突解决表均为规格文本，无代码实现要求。

### §58 v1.0 逐章节迁移对照 → 部分（1 缺口）

- `packages/project-io/src/migrate-v1.ts` 实现五项迁移函数：`migrateOrgEdges`（§52.4 parent_agent→Primary Manager 边）、`migratePermissionsToCeilings`（权限→Capability ceilings）、`migrateTaskCompletion`（旧 DONE→`legacy_completion_unverified`）、`migrateMemoryText`（旧文本→UNVERIFIED）、`migrateProductionApproval`（auto 须经 Risk/Reversibility/Observe 检查）
- **缺口 G-19**：迁移函数仅被 `index.ts` re-export，**无生产调用方**（仅 `demo/migration.demo.ts` 演示）；无 `packages/db/migration/` 目录，无 DB 级迁移执行器

### §59 官方集成核对、参考来源与变更治理 → 部分（2 缺口）

| 硬性要求 | 验证结果 |
|---|---|
| 59.1 Codex app-server / Authentication / Quota 读 provider 数据（不给每名 Agent 假额度）/ MCP negotiated version / 不依赖 Agent Builder | **缺口 G-21**（部分）：`packages/model-router/src/profile.ts` 的 `getAccountStatus()` 为 stub，返回占位值（自认 "STUB: connect a real provider"）；quota 包本身正确处理 unknown（`unknown-means-unknown`），但 provider 数据源未接 — 与"无真实模型"环境限制重叠 |
| 59.3 变更治理：每条变更记录来源/原因/影响/兼容/生效时间；实现细节用 ADR 记录；不得"优化 Prompt"偷改权威规格 | **缺口 G-20**：无 ADR 目录、无变更记录机制（`docs/` 仅 `AT_MAPPING.md`） |

---

## 真缺口清单（21 条）

| 编号 | 章节 | 一句话摘要 |
|---|---|---|
| G-01 | §46.1 | 无安全文档，admin/kernel 攻陷超出沙箱保证的限制未书面化 |
| G-02 | §46.2 | 无 OS Secret Broker（Credential Manager/keyring）集成，仅 SecretRef 引用纪律 |
| G-03 | §46.4 | Electron 仅 contextIsolation；无 sandbox/CSP/preload IPC，nodeIntegration 未显式关闭 |
| G-04 | §46.5 | MCP/Skill 无 hash 锁定与签名验证；安装包无签名配置 |
| G-05 | §47 | 无 DB backup/restore 实现（仅 workspace snapshot） |
| G-06 | §47 | 无 Retention 策略与 Legal Hold 实现 |
| G-07 | §47 | 无 Project Archive/Delete 生命周期实现 |
| G-08 | §48.1 | 从未执行 `PRAGMA foreign_keys=ON`，外键声明不强制 |
| G-09 | §48.2/§51 | SQLite 仅 13 表；leases/budget 等内存态重启丢失；outbox_events 表无写入者 |
| G-10 | §49.1 | submit_report/decide_report 有领域逻辑但无 server API 路由 |
| G-11 | §50.1 | 终端无真实 PTY（自认 prototype） |
| G-12 | §50.2 | 无完整 Settings 页（Roles/Policy/Quota/网络边界/预算/备份等） |
| G-13 | §50.2 | 无 Manager Team 视图（下属任务/关键路径/Blockers drill-down） |
| G-14 | §50.2 | 无 Agent Observatory per-worker 视图（heartbeat/process/pause/take-control） |
| G-15 | §50.4 | 无 Final Report 生成/展示 UI 入口 |
| G-16 | §53.1 | electron-builder 无签名配置且从未执行打包 |
| G-17 | §54 | 无可运行的端到端验收套件（仅映射文档） |
| G-18 | §55.10 | 无 Known Limitations 文档与操作手册 |
| G-19 | §58 | v1 迁移函数无生产调用方，仅 demo |
| G-20 | §59.3 | 无 ADR/变更记录机制 |
| G-21 | §59.1 | model-router provider 数据为 stub（与无真实模型环境限制重叠） |

## BLOCKED（环境限制，不计入缺口）

- Windows 真机：§46.2 Credential Manager 真实验证、§53/§55.10 安装包实际打包签名
- 真实隔离 Host：§55.4 Full Shell 真隔离验收、§7 相关 AT
- 真实模型/MCP：§55.2/§55.3/§55.6 真实工程闭环与故障注入、§59.1 provider 数据读取
- 团队 infra（PostgreSQL/远程 Host/多人）：§55.9、§48.1 远程共享控制面
- 测试生产：§55.7 risk-based release/canary 真实演练
- §51 性能数值（p95 <150ms/2s/1s、30s 重启、50+ Run 压力）：需 ENV-B/P benchmark
- §54 64 个 AT 场景执行：需上述真实环境
