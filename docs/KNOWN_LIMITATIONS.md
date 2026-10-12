# 已知限制（Known Limitations）

> 对应 SPEC_V2 §55.10：未实现能力明确标记，版本发布说明不把最终产品目标当当前能力。
> 本文档基于 2026-10-11 v2 轮全面测试的真实审计情况编写，不夸大、不隐瞒。

## 运行环境

- **当前仅在 Linux 上验证过**。规格要求的目标环境是 Windows（ENV-L），本机是 Linux，未在 Windows 真机上跑过。
- **没有打过安装包**。electron-builder 配置存在，但从未执行过，没有 `.exe` / `.dmg` 可分发安装包，只能从源码 `npm run dev` / `npm run electron` 启动。
- **Electron 桌面壳从未在真机上点开过**。测试环境无显示器，只验证了 Vite 构建成功，界面交互未做真机冒烟。

## AI 能力

- **除 Codex 外的模型适配器仍是 stub**。CodexAdapter 已真实实现（见下一节），其余供应商（Anthropic 等）未接入，"AI 员工"目前只能经 Codex 这一条真回路干活，且真 turn 尚待登录验证。
- **MCP Registry 有实现，但未接入真实 MCP 服务**。Unknown MCP 默认 BLOCK 的逻辑在，但没有连过真实服务器做握手验证。

## 真实模型接入（Codex app-server）

- **CodexAdapter 已真实现**（2026-10-12，提交 `18fce3c`，SPEC §27/§28 的 B 路线）：一个 JSON-RPC 客户端连接 Codex app-server，双传输——spawn `codex app-server --stdio` 子进程，或连接已用 `--listen ws://` 启动的服务器；走完 initialize → thread/start → turn/start 全流程。线程默认为只读沙箱（sandbox: read-only）+ approvalPolicy `never`，fail-closed 取向，需要写操作时须显式放宽 config。
- **动作映射为 observed actions，toolCalls 恒空**：Codex 在它自己的沙箱里执行命令/改文件/调工具，这些在工厂侧只记为已发生的观测记录（AdapterOutput 新增的 `actions` 字段）；`AdapterOutput.toolCalls` 对 Codex 恒为 `[]`——因为工厂 harness 会把 toolCalls 当待执行指令再跑一遍，塞进去会造成重复执行。反过来，工厂原生工具经 Codex 调用的桥接（如 MCP 转发）尚未实现。
- **真 turn 端到端验证尚未完成**：需先在本开发机完成 `codex login`（device-auth，ChatGPT 授权），当前仍未登录。已实测到认证边界：协议链路对真实 app-server 跑通，`getAccountStatus()` 真实返回 reachable / requiresOpenaiAuth，未登录时 turn 被服务器以真实 401 拒绝，错误原文透传，适配器不回退 StubAdapter、不伪造成功。无登录路径由假服务器 demo（`npm run demo:codex`）与适配器单测覆盖；真机 demo `codex-live.demo.ts` 需要登录，不在 demo 套件内。
- **账号状态（profile）默认仍是 stub**：model-router 的 profile 账号状态默认返回 stub 形状；`getAccountStatus()` 已能经 app-server 真实查询，profile 也已备好 live 注入点（可注入真实结果并标注来源），但 server 侧把真实账号状态接进 API 路由的工作由另一组进行中，尚未完成——接线完成前，API/UI 看到的账号状态仍可能是 stub。
- **StubAdapter 仍是测试与 demo 的默认**：全部单测和 demo 套件（假服务器 Codex demo 除外）都跑在 StubAdapter 的脚本回放上，不消耗真实模型额度。

## 隔离与安全

- **无真实隔离 Host**。在 Linux 本机直跑，非合规隔离后端；`CONFINEMENT_UNAVAILABLE` 的 fail-closed 路径有单测，但真实 Host 隔离未验证。
- Windows 工具探测（PowerShell / .NET 等）未在 Windows 上验证。

## 工作流引擎接线（§18.2，G-18）

- **v2 引擎已接线到服务端，但 Board 仍走 v1**。新增端点 `POST /api/tasks/:id/v2-transition` 与 `GET /api/tasks/:id/v2-state` 真实调用 `WorkflowEngineV2`（三态/里程碑/证据失效门禁），成功后写回 DB，门禁拒绝返回 422 且 DB 不变（有路由测试覆盖）。桌面 Board 的拖拽仍调用 v1 端点：Board 的列是 v1 状态（含 BLOCKED 等异常列），v2 是三态分离、且流转要求需求版本钉住（requirement pin），Board 目前不提供这些输入，硬切只会变成"永远回退 v1"的假接线，所以本批未切换 UI。
- **v2 引擎状态已落库（Batch 13）**。`V2TransitionService` 在接线了 `FactoryDatabase.taskV2States` 时，把引擎镜像（core 的 `TaskV2State` 全字段：stage、condition、里程碑及三组历史、releaseState、outcomeGateValid、taskVersion、requirementRef、completionTarget、final_seal、updatedAt）于每次提交变更后逐字落盘到 `task_v2_state` 表；首次访问先查库水合，无落盘行才走 DB 行近似播种（v1 异常状态从未单独记录过 v2 阶段，播种阶段是近似值、异常本身播种为 condition 字段）并随即落盘。重启恢复的是真实 v2 状态，final_seal 跨重启保真（Batch 12 的 F1 残留关闭）。未落盘的只是引擎的附属进程状态（幂等缓存、G-17 outbox 队列、G-21 失败事件日志——均非 TaskV2State 字段，其内容已同步写入持久审计日志）。无 DB 的嵌入场景仍为进程内镜像。水合经引擎 `getMutable()` 写回引擎自产的落盘快照，不重放迁移、不绕门禁。
- **写回有一处有损映射**：v2 的 `OUTCOME_VERIFICATION` 阶段在 v1 状态列里没有对应值，写回为 `PROD_VERIFICATION`，精确阶段保存在落盘镜像中，`GET /v2-state` 跨重启仍可读到精确值（Batch 13）；DB 行的写回映射保持不变，v1 消费方不受影响。`DONE` 只能经引擎 `finalize()`（完成谓词 + final_seal 同事务）到达，服务端经 `POST /api/tasks/:id/v2-complete` 暴露（Batch 12）。
- **门禁输入部分靠调用方声明**：证据与依赖就绪由服务端按 DB 实算；budget/quota/confinement 三项服务端尚无可核验的服务，靠请求显式声明，未声明按 false 处理（fail-closed，拒绝流转而不是放行）；authorization 是调用方提供的快照（本机 API 尚无认证层）。

## 持久化运行状态（§28，G-53/G-59）

- **Step intent 已落 SQLite 并接进服务端（G-59，Batch 9）**。`runAgent` 在默认运行路径创建（或接受注入）`StepIntentStore` 并挂到 harness 上，工具执行前先落 intent、执行后提交结果（G-53 接线）；服务端注入的是 db 包的 `SqliteStepIntentStore`（`step_intents` 表），intents 跨重启保留。无 DB 的嵌入方不注入时仍回退进程内 Map——那只是接线回退，不是持久化。审计链的 reason/result/summary_hash/prev_hash 四列同期落盘（§32），跨重启 `verifyAuditChain` 可验真且链头连续。
- **启动扫描已做，但只报告不处置**。服务端启动时扫描上个进程留下的 PENDING intents，结果写审计 `STARTUP_INTERRUPTED_INTENTS`（含计数）并在 `GET /api/health` 的 `stepIntents` 段可查；扫描绝不把 intent 改写成已执行、绝不重放工具调用，处置（对账/受控恢复）仍留给上层。
- **External ops 已落 SQLite 并接进服务端（G-59，Batch 10）**。runtime 的 `OperationLedger` 经 `OperationStore` 接口读写，db 包提供 `SqliteOperationStore`（`external_operations` 表），服务端以它构造 ledger；跨重启 prepare 同一幂等键返回原记录、不重复建行。启动 reconcile 已做，但只分类不处置：服务端启动时无目标系统（部署/PR）的活句柄可查，target 查询如实无法应答，未终态 operation 据此分为 safe-to-retry（可逆）与 needs-manual-recovery（不可逆），结果写审计 `STARTUP_OPERATION_RECONCILE` 并在 `GET /api/health` 的 `operations` 段可查；分类不采纳、不改状态、不重放，真实对账（拿得到目标 ledger 应答时）与受控恢复仍留给上层。无 DB 的嵌入方不注入 store 时回退进程内 Map——接线回退，非持久化。
- **Checkpoints 已落 SQLite 且已有真实消费方（G-59，Batch 11 落盘 / Batch 13 接线）**。runtime 的 `CheckpointStore` 接缝 + `CheckpointLog`、db 的 `SqliteCheckpointStore` 与 Batch 11 相同（身份 (run_id, step_position)、同位置再捕获即替换、深拷贝）。Batch 13 起服务端运行路径是第一个生产消费方：HTTP run 每执行完一个 loop 步骤，经 AgentLoop 的 onTrace 步界捕获一条 checkpoint（字段全部来自真实事实：BudgetTracker 用量、该 run 已提交的 step intents、任务的待批审批、agent/task 在捕获时点的实时记录；本路径没有的 model session / workspace 快照 / git 信息保持缺失，lease generation 0 表示未持任何租约），`GET /api/runtime/runs/:id/checkpoints[/latest]` 是读取面（恢复入口），`/api/health` 的 `checkpoints.stored` 随真实捕获增长。**仍未做**：不自动 resume——重启只把被中断 run 的最新 checkpoint 作为恢复点提供，恢复决策与 §28.4 的授权/政策/需求重校验留给人工/上层；loop 自身的 base64 checkpoint token 与 CheckpointV2 仍是两套机制，未合并。同批顺带修复：HTTP run 的 step intents 此前全被盖为 'unknown-run'（Harness 的 runId 选项路由从未传），现已盖真实 run id。
- **备份/恢复已实现（Batch 13）**。`POST /api/backup` 把工厂数据库（`DB_PATH` 指向的单个 SQLite 文件）以 `VACUUM INTO` 一致性快照备份为自包含目录（快照 + `manifest.json`：文件 sha256、逐表计数、应用版本），备份目录由 `FACTORY_BACKUP_DIR` 配置（默认库文件旁 `backups/`）；`POST /api/restore` 先逐文件校验哈希并做 `integrity_check`，校验不过拒绝且不触碰现库，校验后先自动备份现库（pre-restore），再把恢复**排队到下一次重启生效**（响应明示 `restartRequired`，运行中不热换库），重启换入时旧库以 `.superseded-<时间戳>` 改名保留。边界：①备份范围只有工厂数据库——项目工作文件与各项目 `.ai/` 配置不在其中，需另行备份；②恢复必须重启服务才生效，无在线热恢复；③无定时/自动备份调度，无保留策略与清理（备份目录只增不减，需运维自行管理）；④备份无加密，文件系统权限即其保护。

## 首次运行走查发现（Batch 11，详见 docs/FIRST_RUN_WALKTHROUGH.md）

- **F1 已修复（Batch 12）**。新增 `POST /api/tasks/:id/v2-complete`：服务端从真实事实组装 §20.1 完成快照（钉住版本的 AC 按其 expectedEvidence 与任务证据核对、里程碑、依赖、审批记录、outcome gate 有效性），调用 `finalize()` 完成谓词校验 + DONE + final_seal=1 一次提交并写回 DB，v2 镜像与 DB 行一致。`v2-transition` 到 DONE 仍返回 422（引擎设计，finalize 是唯一道路）。残留已关闭（Batch 13）：TaskV2State 已整体落库（`task_v2_state` 表），finalSeal 与完整 v2 镜像跨重启保真。
- **F2 已修复（Batch 12）**。需求、版本历史、实体链接、Promotion Hold 与 §16 兼容声明已落 SQLite：requirements 包抽出 `RequirementStore` 接缝（无 store 时仍为进程内默认，语义与原单例一致），db 包提供 `SqliteRequirementStore`（requirements / requirement_versions / requirement_links / promotion_holds / evidence_compatibility / requirement_store_meta 六表，版本行只写一次、永不更新）；服务端启动时以该 store 重构共享单例，`/api/health` 的 `requirements` 段可查实时存量。回归由服务端三 boot HTTP 测试钉住：重启后带 requirement pin 的证据登记不再 400、卡在 STALE 门中间的任务可凭已存兼容声明直接放行、hold 及其释放跨重启保留。
- **F3 已修复（Batch 12）**。服务端已接 `onSealEvidence` → `EvidenceEngine.seal`：v2 迁移提交后，被该 Gate 消费的证据立即封存（SEALED，不可改/删）；被拒绝的迁移不封存。注意谓词检查型证据（如生产审批，由 gate predicate 读取而非作为 requiredEvidence 消费）不在封存之列——封存严格跟踪消费，与 §42 口径一致。
- **F4 已修复（Batch 12）**。run 记录已落 SQLite。`RuntimeRunStore` 接缝 + `SqliteRuntimeRunStore`（`runtime_runs` 表）在 packages/db，服务端启动时把路由注册表安装到 SQLite store（standalone/测试默认仍是内存实现）；记录在创建、每条证据追加、终态与出错时同步落盘，重启后 `GET /api/runtime/runs/:id` 可查且字段保真，`/api/health` 的 `runs` 段可查实时存量。诚实边界：进程被杀时未及终态写的记录会以最后落盘状态留在库中（可能仍是 RUNNING——那是被中断 run 的如实记录，服务端不自动改写或清理，需人工或上层处置）。
- **StepIntent 在权限检查之前落盘（Batch 12，复核观察 1）**：harness 先落 intent 再过权限门；被权限拒绝（含工具白名单外）的调用留下一条状态为 DENIED 的 intent（工具从未执行、resultHash 承诺拒绝载荷），内存与 SQLite 两个 store 标签一致；启动扫描只报 PENDING，不会把已裁决的拒绝误报为中断。

## 数据与团队

- **单机 SQLite**，无团队 PostgreSQL、无远程 Host、无 50+ 并发 Run 验证。
- 无测试生产环境：canary 发布、灰度、故障注入、24h 稳态均未跑过。
- **无真人 UAT / Outcome 验收**：AT-001–AT-064 没有一条达到端到端验收。

## 测试资产

- 计划宣称的 275 条正式用例集（`docs/testing/v2/`）不存在，记为 NOT_RUN，不是"通过"。
- 发现的 DEF-002 / DEF-003（API 空 body 校验）已在 `47856d7` 修复并推送；DEF-001 已关闭。

## 结论

当前是**可运行的原型**（构建 0 错误、1470/1470 单测、44/44 demo），不是可交付产品。上面每一条都是正式验收前必须补的。
