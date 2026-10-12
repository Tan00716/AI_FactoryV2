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
- **v2 引擎状态是内存镜像**。服务端以 taskId 为键在内存中维护 v2 状态，首次 v2 访问时从 DB 行的当前状态播种；服务重启后重新播种。v1 异常状态（BLOCKED、QA_FAILED 等）从未单独记录过 v2 阶段，首次播种的阶段是近似值（异常本身会播种为 v2 的 condition 字段）。
- **写回有一处有损映射**：v2 的 `OUTCOME_VERIFICATION` 阶段在 v1 状态列里没有对应值，写回为 `PROD_VERIFICATION`，精确阶段只能从 `GET /v2-state` 读到；`DONE` 只能经引擎 `finalize()`（完成谓词 + final_seal 同事务）到达，本批端点不暴露 finalize。
- **门禁输入部分靠调用方声明**：证据与依赖就绪由服务端按 DB 实算；budget/quota/confinement 三项服务端尚无可核验的服务，靠请求显式声明，未声明按 false 处理（fail-closed，拒绝流转而不是放行）；authorization 是调用方提供的快照（本机 API 尚无认证层）。

## 持久化运行状态（§28，G-53/G-59）

- **Step intent 已落 SQLite 并接进服务端（G-59，Batch 9）**。`runAgent` 在默认运行路径创建（或接受注入）`StepIntentStore` 并挂到 harness 上，工具执行前先落 intent、执行后提交结果（G-53 接线）；服务端注入的是 db 包的 `SqliteStepIntentStore`（`step_intents` 表），intents 跨重启保留。无 DB 的嵌入方不注入时仍回退进程内 Map——那只是接线回退，不是持久化。审计链的 reason/result/summary_hash/prev_hash 四列同期落盘（§32），跨重启 `verifyAuditChain` 可验真且链头连续。
- **启动扫描已做，但只报告不处置**。服务端启动时扫描上个进程留下的 PENDING intents，结果写审计 `STARTUP_INTERRUPTED_INTENTS`（含计数）并在 `GET /api/health` 的 `stepIntents` 段可查；扫描绝不把 intent 改写成已执行、绝不重放工具调用，处置（对账/受控恢复）仍留给上层。
- **External ops 已落 SQLite 并接进服务端（G-59，Batch 10）**。runtime 的 `OperationLedger` 经 `OperationStore` 接口读写，db 包提供 `SqliteOperationStore`（`external_operations` 表），服务端以它构造 ledger；跨重启 prepare 同一幂等键返回原记录、不重复建行。启动 reconcile 已做，但只分类不处置：服务端启动时无目标系统（部署/PR）的活句柄可查，target 查询如实无法应答，未终态 operation 据此分为 safe-to-retry（可逆）与 needs-manual-recovery（不可逆），结果写审计 `STARTUP_OPERATION_RECONCILE` 并在 `GET /api/health` 的 `operations` 段可查；分类不采纳、不改状态、不重放，真实对账（拿得到目标 ledger 应答时）与受控恢复仍留给上层。无 DB 的嵌入方不注入 store 时回退进程内 Map——接线回退，非持久化。
- **Checkpoints 已落 SQLite（G-59，Batch 11）**。runtime 抽出 `CheckpointStore` 接缝 + `CheckpointLog`（创建/校验/latest 恢复查询，副本为深拷贝），db 包提供 `SqliteCheckpointStore`（`checkpoints` 表，身份为 (run_id, step_position)、同位置再捕获即替换、可选字段 NULL↔读回缺失）；服务端协调层已以 SQLite store 构造 `CheckpointLog`，`/api/health` 的 `checkpoints` 段可查实时存量。**但消费面尚未接通**：尚无任何服务端路由或运行路径真正捕获/读取 checkpoint（`CheckpointV2` 目前只有 runtime 测试在调用），落盘与接线已就绪，检查点级恢复要等第一个捕获方接线后才实际生效。

## 首次运行走查发现（Batch 11，详见 docs/FIRST_RUN_WALKTHROUGH.md）

- **F1（高）：v2 生命周期经纯 HTTP 走不到 DONE**。`finalize()` / REQUEST_COMPLETE 没有 HTTP 路由，v2-transition 到 DONE 返回 422；纯 API 用户只能绕 v1 transition 端点完成最后一步，代价是完成谓词不校验、`final_seal` 恒 0、同进程内 v2 镜像与 DB 状态不一致（重启 re-seed 后自愈）。
- **F2（中）：需求（RequirementManager）不落库**。需求版本与兼容声明是进程内单例状态，服务重启即丢失；重启后带 requirement pin 的证据登记会 400，卡在 STALE 门中间的任务须先在新进程重建需求、版本与兼容声明。
- **F3（中）：v2 迁移不封存被消费证据**。`onSealEvidence` 钩子服务端未接；任务走完 v2 全程后，已过 Gate 的证据大多仍是可改的 DRAFT 状态，与 §42 证据不可变的口径有差距。
- **F4（低）：run 记录是进程内 Map**。服务重启后 `GET /api/runs/:id` 返回 404；run 的副作用（step intents、证据）已落库，丢失的只是 run 记录本身。

## 数据与团队

- **单机 SQLite**，无团队 PostgreSQL、无远程 Host、无 50+ 并发 Run 验证。
- 无测试生产环境：canary 发布、灰度、故障注入、24h 稳态均未跑过。
- **无真人 UAT / Outcome 验收**：AT-001–AT-064 没有一条达到端到端验收。

## 测试资产

- 计划宣称的 275 条正式用例集（`docs/testing/v2/`）不存在，记为 NOT_RUN，不是"通过"。
- 发现的 DEF-002 / DEF-003（API 空 body 校验）已在 `47856d7` 修复并推送；DEF-001 已关闭。

## 结论

当前是**可运行的原型**（构建 0 错误、1470/1470 单测、44/44 demo），不是可交付产品。上面每一条都是正式验收前必须补的。
