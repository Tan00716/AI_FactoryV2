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
- **v2 引擎状态已落库（Batch 13）**。`V2TransitionService` 在接线了 `FactoryDatabase.taskV2States` 时，把引擎镜像（core 的 `TaskV2State` 全字段：stage、condition、里程碑及三组历史、releaseState、outcomeGateValid、taskVersion、requirementRef、completionTarget、final_seal、updatedAt）于每次提交变更后逐字落盘到 `task_v2_state` 表；首次访问先查库水合，无落盘行才走 DB 行近似播种（v1 异常状态从未单独记录过 v2 阶段，播种阶段是近似值、异常本身播种为 condition 字段）并随即落盘。重启恢复的是真实 v2 状态，final_seal 跨重启保真（Batch 12 的 F1 残留关闭）。outbox 已落库（Batch 17，`outbox_events` 表 + 引擎 OutboxSink 接缝；drain 为 `dispatched_at` 确认戳记、从不删行；`GET /api/tasks/:id/outbox` 只读拉取面；health 有 `outbox.pending`；append 失败不回滚迁移、写 `OUTBOX_PERSIST_FAILED` 审计）。仍进程内的只剩幂等缓存与 G-21 失败事件日志（均非 TaskV2State 字段，其内容已同步写入持久审计日志）。无 DB 的嵌入场景仍为进程内镜像。水合经引擎 `getMutable()` 写回引擎自产的落盘快照，不重放迁移、不绕门禁。
- **写回有一处有损映射**：v2 的 `OUTCOME_VERIFICATION` 阶段在 v1 状态列里没有对应值，写回为 `PROD_VERIFICATION`，精确阶段保存在落盘镜像中，`GET /v2-state` 跨重启仍可读到精确值（Batch 13）；DB 行的写回映射保持不变，v1 消费方不受影响。`DONE` 只能经引擎 `finalize()`（完成谓词 + final_seal 同事务）到达，服务端经 `POST /api/tasks/:id/v2-complete` 暴露（Batch 12）。
- **门禁输入部分靠调用方声明**：证据与依赖就绪由服务端按 DB 实算；budget/quota/confinement 三项服务端尚无可核验的服务，靠请求显式声明，未声明按 false 处理（fail-closed，拒绝流转而不是放行）；authorization 是调用方提供的快照（本机 API 尚无认证层）。

## 持久化运行状态（§28，G-53/G-59）

- **Step intent 已落 SQLite 并接进服务端（G-59，Batch 9）**。`runAgent` 在默认运行路径创建（或接受注入）`StepIntentStore` 并挂到 harness 上，工具执行前先落 intent、执行后提交结果（G-53 接线）；服务端注入的是 db 包的 `SqliteStepIntentStore`（`step_intents` 表），intents 跨重启保留。无 DB 的嵌入方不注入时仍回退进程内 Map——那只是接线回退，不是持久化。审计链的 reason/result/summary_hash/prev_hash 四列同期落盘（§32），跨重启 `verifyAuditChain` 可验真且链头连续。
- **启动扫描已做，但只报告不处置**。服务端启动时扫描上个进程留下的 PENDING intents，结果写审计 `STARTUP_INTERRUPTED_INTENTS`（含计数）并在 `GET /api/health` 的 `stepIntents` 段可查；扫描绝不把 intent 改写成已执行、绝不重放工具调用，处置（对账/受控恢复）仍留给上层。
- **External ops 已落 SQLite 并接进服务端（G-59，Batch 10）**。runtime 的 `OperationLedger` 经 `OperationStore` 接口读写，db 包提供 `SqliteOperationStore`（`external_operations` 表），服务端以它构造 ledger；跨重启 prepare 同一幂等键返回原记录、不重复建行。启动 reconcile 已做，但只分类不处置：服务端启动时无目标系统（部署/PR）的活句柄可查，target 查询如实无法应答，未终态 operation 据此分为 safe-to-retry（可逆）与 needs-manual-recovery（不可逆），结果写审计 `STARTUP_OPERATION_RECONCILE` 并在 `GET /api/health` 的 `operations` 段可查；分类不采纳、不改状态、不重放，真实对账（拿得到目标 ledger 应答时）与受控恢复仍留给上层。无 DB 的嵌入方不注入 store 时回退进程内 Map——接线回退，非持久化。
- **Checkpoints 已落 SQLite 且已有真实消费方（G-59，Batch 11 落盘 / Batch 13 接线）**。runtime 的 `CheckpointStore` 接缝 + `CheckpointLog`、db 的 `SqliteCheckpointStore` 与 Batch 11 相同（身份 (run_id, step_position)、同位置再捕获即替换、深拷贝）。Batch 13 起服务端运行路径是第一个生产消费方：HTTP run 每执行完一个 loop 步骤，经 AgentLoop 的 onTrace 步界捕获一条 checkpoint（字段全部来自真实事实：BudgetTracker 用量、该 run 已提交的 step intents、任务的待批审批、agent/task 在捕获时点的实时记录；本路径没有的 model session / workspace 快照 / git 信息保持缺失，lease generation 0 表示未持任何租约），`GET /api/runtime/runs/:id/checkpoints[/latest]` 是读取面（恢复入口），`/api/health` 的 `checkpoints.stored` 随真实捕获增长。**恢复流程已接通（Batch 15）**：`POST /api/runtime/runs/:id/resume` 按 §28.4 逐项重校验（任务存在且版本与 checkpoint 一致、agent 仍注册、无未对账 PENDING intents、项目未归档、run 未在本进程存活），全过才创建一个**新的**恢复 run——预算基线承接 checkpoint 的 budgetUsage、步位从 checkpoint.stepPosition 之后继续、linkage 落在新 run 记录的 resume_link 证据与 RESUME_STARTED 审计中。边界如实：这不是把死进程的内存现场热迁移——新 run 的 loop 仍从第一个 phase 开始执行，承接的只是记录在案的状态；不自动 resume（须显式调用）；源 run 若曾以 script 驱动，记录未保留该 script，恢复时缺省用默认脚本，须由调用方重新提供。loop 自身的 base64 checkpoint token 与 CheckpointV2 仍是两套机制，未合并。同批顺带修复：HTTP run 的 step intents 此前全被盖为 'unknown-run'（Harness 的 runId 选项路由从未传），现已盖真实 run id。
- **备份/恢复已实现（Batch 13）**。`POST /api/backup` 把工厂数据库（`DB_PATH` 指向的单个 SQLite 文件）以 `VACUUM INTO` 一致性快照备份为自包含目录（快照 + `manifest.json`：文件 sha256、逐表计数、应用版本），备份目录由 `FACTORY_BACKUP_DIR` 配置（默认库文件旁 `backups/`）；`POST /api/restore` 先逐文件校验哈希并做 `integrity_check`，校验不过拒绝且不触碰现库，校验后先自动备份现库（pre-restore），再把恢复**排队到下一次重启生效**（响应明示 `restartRequired`，运行中不热换库），重启换入时旧库以 `.superseded-<时间戳>` 改名保留。边界：①备份范围只有工厂数据库——项目工作文件与各项目 `.ai/` 配置不在其中，需另行备份；②恢复必须重启服务才生效，无在线热恢复；③无定时/自动备份调度，无保留策略与清理（备份目录只增不减，需运维自行管理）；④备份无加密，文件系统权限即其保护。

## 首次运行走查发现（Batch 11，详见 docs/FIRST_RUN_WALKTHROUGH.md）

- **F1 已修复（Batch 12）**。新增 `POST /api/tasks/:id/v2-complete`：服务端从真实事实组装 §20.1 完成快照（钉住版本的 AC 按其 expectedEvidence 与任务证据核对、里程碑、依赖、审批记录、outcome gate 有效性），调用 `finalize()` 完成谓词校验 + DONE + final_seal=1 一次提交并写回 DB，v2 镜像与 DB 行一致。`v2-transition` 到 DONE 仍返回 422（引擎设计，finalize 是唯一道路）。残留已关闭（Batch 13）：TaskV2State 已整体落库（`task_v2_state` 表），finalSeal 与完整 v2 镜像跨重启保真。
- **F2 已修复（Batch 12）**。需求、版本历史、实体链接、Promotion Hold 与 §16 兼容声明已落 SQLite：requirements 包抽出 `RequirementStore` 接缝（无 store 时仍为进程内默认，语义与原单例一致），db 包提供 `SqliteRequirementStore`（requirements / requirement_versions / requirement_links / promotion_holds / evidence_compatibility / requirement_store_meta 六表，版本行只写一次、永不更新）；服务端启动时以该 store 重构共享单例，`/api/health` 的 `requirements` 段可查实时存量。回归由服务端三 boot HTTP 测试钉住：重启后带 requirement pin 的证据登记不再 400、卡在 STALE 门中间的任务可凭已存兼容声明直接放行、hold 及其释放跨重启保留。
- **F3 已修复（Batch 12）**。服务端已接 `onSealEvidence` → `EvidenceEngine.seal`：v2 迁移提交后，被该 Gate 消费的证据立即封存（SEALED，不可改/删）；被拒绝的迁移不封存。注意谓词检查型证据（如生产审批，由 gate predicate 读取而非作为 requiredEvidence 消费）不在封存之列——封存严格跟踪消费，与 §42 口径一致。
- **F4 已修复（Batch 12）**。run 记录已落 SQLite。`RuntimeRunStore` 接缝 + `SqliteRuntimeRunStore`（`runtime_runs` 表）在 packages/db，服务端启动时把路由注册表安装到 SQLite store（standalone/测试默认仍是内存实现）；记录在创建、每条证据追加、终态与出错时同步落盘，重启后 `GET /api/runtime/runs/:id` 可查且字段保真，`/api/health` 的 `runs` 段可查实时存量。诚实边界：进程被杀时未及终态写的记录会以最后落盘状态留在库中（可能仍是 RUNNING——那是被中断 run 的如实记录，服务端不自动改写或清理，需人工或上层处置）。
- **§21 调度硬约束已落地（Batch 16，G-30…G-36）**。Scheduler 有统一前门禁（九项硬约束结构化判定，checker > attestation > 默认放行，严格模式 fail-closed）、enqueue 权力先行拒绝、多因子确定性排序（规格未给公式，因子方向与权重均为代码注释标明的本地口径）、aging、P0 安全点抢占指令（调度器只发指令，停机由执行层在安全点完成；受保护事务永不被抢占，被抢占者有迁移保护窗）、Monitor/Recovery 预留槽（dev 被拒时给出 reservedCapacity 结构化原因）。Optimizer 在能力/政策硬约束外按估算成本/时间/资源打分，Human Override 不能复活被硬约束剔除的候选（拒绝带逐项解释）；打分权重是本地默认值，不是规格公式。预算新增货币/CPU/RAM 维度与原子 reserve→charge→settle/release，unknown 金额只记次数不进用量；超限经 BudgetExceededError/Event 的 condition 字段映射到任务的 BUDGET_BLOCK/RESOURCE_BLOCK 条件（维度→条件的对应是本地规则，规格只给了成对写法）。边界如实：① 门禁的 attestation 模式下未声明的约束默认放行——只有 requireAllConstraints 或配 checker 时才是全量 fail-closed；② 抢占是协议而非强制：执行层不执行指令时调度器无法代停；③ 优先级包层已统一 P0–P4，服务端 /api/orchestrator/schedule 校验同步对齐（Batch 16 主线收口）。
- **Git Broker 与 Merge Queue（§36，Batch 16）**。packages/git 新增按动作管控的 Broker 门面（read/branch/commit/push/merge/remote 分级，策略未允许的动作一律拒绝并经注入回调进审计；包默认策略全类放行、但 push/merge/remote 必须绑定 task，宿主可收紧允许清单与上下文校验）与 Merge Queue：PR 入队后串行处理，合并前先组装与当前目标分支的**合并候选**并验证（缺省为冲突检测，测试命令验证经注入执行器），候选不过则该 PR 标记 FAILED 出队、队列继续——专治「各自单独过、合在一起失败」。服务端 git 写路由已改经 Broker；队列经 `POST /api/git/merge-queue` 入队与查询。边界如实：候选验证缺省只查冲突，不自动跑项目测试套件（除非注入验证器）；队列状态为进程内（与 PrStore 一致，重启丢失），多实例共享队列未做。
- **§17.2 Human Dispatch 已落地（Batch 17）**。Task 新增独立的 `authorization_status` 轴（DRAFT / WAITING_HUMAN_DISPATCH / AUTHORIZED / REVOKED / EXPIRED，落库），与 workflow 状态互不替代：`POST /api/tasks` 可按 DRAFT / WAITING_HUMAN_DISPATCH 建单（AI 发现的问题走 WAITING 等待人工派发），`POST /api/tasks/:id/{request-dispatch|dispatch|reject-dispatch|revoke-authorization|expire-authorization}` 走派发流，每步写审计（TASK_DISPATCHED 等）；`POST /api/runtime/runs` 对非 AUTHORIZED 任务返回 403 TASK_NOT_AUTHORIZED 且不产生 run。兼容口径如实：规格对存量任务无明文——旧库补列默认 AUTHORIZED、新建默认 AUTHORIZED（§17.2 允许人工新建同时派发），只有显式选择 DRAFT/WAITING 的任务才会被拦。边界：① POLICY 预授权派发已记录 via 与 Rule ID（缺失 400、审计 actor 记 policy 不冒充人工点击），但无独立预授权票登记册（G-09 余项）；② REVOKED/EXPIRED 无恢复路径、EXPIRED 无自动 TTL（规格均未定义）；③ resume 端点与 v2 transition 门禁尚未接 Task 级授权轴（resume 走 §28.4 自有清单，v2 门禁用调用方传入的 actor 授权快照）；④ 子任务授权继承属 G-11，未做。
- **§34 MCP 已补齐（Batch 17）**。握手保存协商：`performHandshake` 与健康检查的 initialize 成功后把 negotiated version 与 extension set 落到注册记录（§34.2 MUST）；握手报告的工具集与注册绑定不一致时只标 stale 进兼容检查，不静默覆写。服务器元数据补齐 Source/Package Hash、Protocol Versions、Prompt schemas、Network targets、Credential refs（只存引用）、Health 与追加式 Install/Activate history。分级健康四级分开报告（启动/协议/工具/真实执行），无探针工具时执行级记 unknown、总评 degraded，不冒充已验；失联链为 classify → bounded retry（只重试 unreachable/timeout，未知副作用不重试）→ 熔断（冷却后半开单探针）→ 同授权替代建议（只建议不自动切换）→ escalate 标记。运行时限制（§34.3）已建模并部分真实强制：stdio 环境过滤函数实际剥离非白名单变量、gate 对 OAuth audience/scope 与声明的 payload 大小做执行前拒绝、redirect 判定钉死凭据不跨未列名 host。**边界如实**：本包不带真实 MCP 传输（真实服务器交互/OAuth 握手属环境项）——TLS 只建模要求与立场（tlsMode/requireTlsForCredentials + 凭据拒走明文 HTTP），实际握手由传输与系统栈完成，本层无法代验；redirect/URL 判定是传输必须调用的决策函数，传输若绕过则不在本层强制范围内；资源大小的流式强制同样依赖传输配合，本层强制点在 gate 的声明值检查。
- **§33 工具分类与内置定义已补齐（Batch 17）**。`packages/tools` 新增一等分类枚举（11 类，名称与顺序逐字按 §33）、注册表按 category 查询与归一化（旧定义按 capability 前缀推断分类、未声明实现状态默认 definition-only）、全字段定义校验器（`validateToolMetadata`），以及覆盖全部 11 类的内置定义目录（16 条）。**已实现（8 条）**：git.commit / git.push / git.pull_request（实现在 @ai-factory/git）、test.run（@ai-factory/qa）、ci.pipeline / deploy.run（@ai-factory/cicd）、runtime.echo / runtime.add（服务端 run 路由纯函数）。**仅定义（8 条）**：fs.read / fs.write / fs.delete / shell.execute（harness 的动作与权限门是真的，但具体实现由宿主注入、本仓不带）、pkg.install、browser.open、db.query、mcp.call。边界如实：① 本批只对齐定义层——tools 包 executor 与 runtime harness 仍是两套执行面，implemented 指「实现存在于工厂代码」，不代表注册表执行器已接线到该表面；② 服务端 `/api/tools` 的注册表仍是运维 POST 注册制，内置目录经 `createBuiltinToolRegistry()` 供嵌入方使用，未自动预置进服务端；③ Browser 隔离 Profile/Host、Database 三环境身份与生产写 Broker、Windows 工具探测仍未做。
- **服务端已有角色权限（RBAC，Batch 15）**。在原单 token 门之上新增三档角色：viewer（只读 GET）、operator（日常写：任务/证据/流转/run/审批）、admin（高危面：backup/restore/备份清单、retention 策略与 legal hold 与 enforce、policy 写、自治等级）。配置 env `FACTORY_API_TOKENS`（逗号分隔 `role:token`；格式错误启动即拒绝且不回显 token）。**向后兼容**：不设该变量时行为与从前一致——单 `FACTORY_API_TOKEN` 即 admin 全权；两者都不设且 loopback 绑定时仍是本地免门模式（有效角色 admin），非 loopback 无凭据仍拒绝启动。角色不足返回 403 并写 `RBAC_DENIED` 审计（记角色不记 token）；`GET /api/auth/whoami` 返回调用方自身角色与认证模式，桌面顶栏据此显示当前角色/本地模式。边界：这是单机共享密钥式的粗粒度角色，不是多用户账号体系（无逐人身份、无令牌轮换/吊销面）；桌面仍用同一个本地 token 槽位，多角色令牌靠运维分发。
- **Run Manifest 已落库（Batch 15）**。每次 HTTP run 生成一份问责清单（`run_manifests` 表）：创建时快照身份（run/agent/task/project）、驱动来源（调用方 script 或路由默认脚本、适配器名、是否带 routeRequest）、FACTORY_RUNTIME_TOOLS 授权清单、预算上限（loop + extended 两层）与上下文清单哈希（与 §28.3 checkpoint 同一装配，可逐一对拍）；终结时补全终局、有效模型及其来源（model-router/adapter）、预算用量、step intents 按状态分桶、证据计数与 checkpoint 步位范围。经 `GET /api/runtime/runs/:id/manifest` 查询，Final Report 含运行记录段并引用 manifest 计数。诚实边界：① 接线前已存在的遗留 run 没有 manifest，查询返回 404，不做回填重构；② 本路径的证据条目是 harness 记录、本身没有 id，manifest 按计数/类型记账，不虚构 evidence id；③ stub 路径下模型记为适配器名并标注 source，不冒充真实模型名；④ 进程中途被杀的 run 其 manifest 停留在创建快照（RUNNING、完成字段为空），不事后补造终结。
- **项目归档生命周期（Batch 14）**：项目有 active ↔ archived 生命周期（`projects.status`/`archived_at` 落库，旧库打开自动补列、旧行默认 active）。归档是状态不是删除：数据一字不删，全部只读面（任务、证据、Final Report、export、stats）照常可用；`GET /api/projects` 默认不返回归档项目（`?includeArchived=1` 或 `?status=archived` 显式取回）；`POST /api/projects/:id/archive|unarchive` 幂等（重复调用 200 + `changed:false`）。归档后新建任务、证据登记、v1 任务迁移/子任务/依赖、项目 import、run 发起、v2-transition/v2-complete、审批（建/决定/失效/取消其绑定任务者）、review、QA run 被拒（409 `PROJECT_ARCHIVED`，共享 guard 同一判定与响应体，Batch 14-5 收口）；审批 evaluate 等纯计算面不守卫。归档守卫已于 Batch 15 补齐 pipelines/git 执行面：`POST /api/pipelines`（带 taskId）、`/:id/run|deploy|approve|rollback`、`POST /api/git/commit`（带 taskId，commit 本身之前拒绝）、`/task-branch`、`/pr`、`/pr/:id/merge` 均接入同一共享判定（409 PROJECT_ARCHIVED，零副作用）；`POST /api/git/branch|checkout|push` 为不绑定 task 的纯仓库操作，明确不守卫。`POST /api/pipelines/:id/approve` 的 resume 已于 Batch 16 修复：parked job 改存模块级共享注册表（`DeploymentService` 可注入 `DeploymentJobRegistry`），跨请求 approve 可真正 resume 并完成部署（e2e 钉住：停车 → 票批准 → 独立请求 approve → SUCCEEDED，证据/审计按既有路径产生，approve 前后 rollback 均可用）。重启边界如实：pipelines/deployments/snapshots/parked jobs 均为进程内存状态，服务重启后 parked 部署不可恢复——approve 返回明确的 404（pipeline not found），不是静默丢失，但该部署需要重新发起。
- **Retention 与 Legal Hold（§47，Batch 14）**。新增 `retention_policies` / `legal_holds` 落库与服务端端点：按类别（runtime_runs / step_intents / checkpoints / backups）配置保留天数，**默认无策略 = 永久保留，任何删除只发生在显式调用 `POST /api/retention/enforce`（需确认字段）时**，`POST /api/retention/evaluate` 为纯 dry-run 报告；删除写 `RETENTION_ENFORCED` 审计（含每类实删计数），策略变更与 hold 设置/解除均写审计。Legal Hold 分 GLOBAL / PROJECT 两级，hold 内数据一律豁免；备份为整库快照，任一 active hold 豁免全部备份，已 staged 待恢复的备份无条件豁免。边界如实：audit_logs（问责根，§32）、evidence（§39 保留期约束 + 封存不可变）、tasks（归项目生命周期）与 notifications（纯内存、无落盘）不在可删之列，每次评估均明示排除原因；RUNNING run 与 PENDING intent 永不入选；项目不可解析的记录按 §47「未知引用阻止清理」永不删除。run 记录被 enforce 删除时，删除路径会先把其 run→project 映射写入 `retention_tombstones`（Batch 15），其残留 intents/checkpoints 后续评估经 tombstone 继续解析到原项目——按该项目策略入选候选、该项目有 active hold 时仍豁免，不再成为永久孤儿；两路皆不可解析的真孤儿仍按 §47 永不删除。tombstone 只存 id 对与删除时间/原因，不存内容，且自身不自动过期。
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
