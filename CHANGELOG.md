# Changelog

## [未发布] Batch 22 — F6 CI 冒烟 / Batch 21 独立复核 / §40→§36 审计 / F7 收口

- **F6 的 CI 冒烟补救**：Batch 21 走查真实踩中——部分包单独构建导致 dist 跨包不一致，真 server 启动直接崩溃 exit 1，而根 `npm test` 不跑 server 套件、门禁抓不住。新增 `scripts/boot-smoke.mjs`（启动编译产物 `apps/server/dist/index.js`、轮询 `GET /api/health` 到 200；hermetic 临时 DB + 临时 `FACTORY_SECRETS_DIR`；dist 不存在直接报错），根 script `smoke:boot`，新建 `.github/workflows/ci.yml`（push/PR 到 main 跑 `npm ci` → `npm run build` → `npm run smoke:boot`）。本地验证：通路 exit 0（~2.4s）；注入崩溃模拟 F6 → 打印崩溃栈 + 大声 exit 1（dist 已恢复干净）。CI 尚未在 GitHub 上跑过一次（下次推送即触发）。`docs/release/RELEASE_CHECKLIST.md` C 组新增冒烟条目（该文件此前被 gitignore 忽略，本批强制入库）。
- **Batch 21 独立复核（沿袭 Batch 11 传统）**：四项实质声明全部成立，未发现夸大或造假（`gap-audit/REAUDIT_BATCH21.md`）。关键断言独立重验：tools-execute 11/11、implementation-gate 7/7、mcp-registry-persistence 3/3、durability+db 7/7、git evidence 5/5、走查纯净基线 1/1 + 主树 1/1。唯一修正：可达性矩阵口径 7/3/6 而非 8/3/5（shell.execute 在目录中标 definition-only 但被服务端接线因而通过门禁）——测试注释、KNOWN_LIMITATIONS、CHANGELOG 已同步修正。复核中再次证明：子批次自测数字只有稳定树复验才算数（兄弟批次在途重编 dist 曾两次让走查 404）。
- **§40 → §36 审计结论（不接线）**：产品中不存在真实可绑定的构建产物——`lockBuild()` 纯函数生产零调用、无 builds 表、合并从不触发构建、`merge_queue_entries.artifact_digest` 永远 null。`artifactDigest` 保持 null + `'no artifact'` 注记是唯一诚实状态；硬调 `lockBuild` 填 digest 等于编造，故零代码改动，仅审计报告（`gap-audit/AUDIT_BUILD_DIGEST_40_TO_36.md`）。后续路线：Batch 23+ 立项"构建记录最小闭环"（真实构建执行 → builds 表 → 绑定）。
- **F7 收口**：`GET /api/tasks/:id/outbox` HTTP 形状与 DB 列 `event_type` 词汇未对齐——审计发现该列纯写（`append` 用 `eventTypeOf(intent)` 写入，`rowToStored` 不读回，无产品代码读它）。最小诚实修复：`eventTypeOf` 导出为列写入规则单源，`outboxView` 加 `eventType: eventTypeOf(e)`（确定性投影非第二事实）；core 接口未动。测试：db 121/121（+1）、server 234/234（+1）；11 步 transition + finalize 后 HTTP 返回 11 个 `WORKFLOW_TRANSITIONED` + 1 个 `WORKFLOW_FINALIZED`，与 DB 列逐字一致。顺带补了三处路由头注释文档缺口（`/api/mcp/launch` 端点行、`/api/backups` 的 `backupId` 字段名、SSE 终端 base64 帧格式）。
- KNOWN_LIMITATIONS 新增四条。测试基线：包套件 2164 → 2165（+1），服务端全套 233 → 234（+1）。

## [未发布] Batch 21 — 工具执行面统一 / MCP 注册表落库 / §36 证据五字段 / 走查重跑

- **工具执行面契约统一（§33）**：结论是刻意保持分层而非二合一——`@ai-factory/tools` 的 ToolExecutor 是 §33「审计直调」面（capability grant、审批门、输入 schema、幂等、退出码真相记录），`@ai-factory/runtime` 的 Harness 是 §26「智能体执行」面（name→Permission、step intent、预算、重试、trace/证据）；两套调用模型互不兼容（record-on-deny vs throw-on-deny），规格分属两章。统一的是门禁与审计接缝：`/api/tools/execute` 的原型 runner（对所有工具回 exitCode 0 的静默假成功）已替换为真 runner——runtime.echo/add 真执行，shell.execute 走与 `/api/exec` 完全相同的命令策略（deny patterns + 二进制白名单 + 控制面目录 + workspace 限制）；`ToolExecutor` 新增可选 `implementationGate` 接缝，definition-only 工具执行前被 DENIED（UNSUPPORTED_CAPABILITY）永不假成功；runner 抛 `ToolDeniedError` 转 DENIED 记录（不再是 TIMED_OUT）；DENIED/FAILED 除进 executor attempts 日志外还转发服务端审计（TOOL_EXEC_DENIED/FAILED）。16 条内置定义的可达性矩阵测试钉死（目录中 8 条 definition-only：7 条被门禁拒绝，shell.execute 虽标 definition-only 但被服务端接线因而通过门禁；3 条服务端实装全通；其余 6 条响亮失败——Batch 22-2 独立复核修正了 8/3/5 口径）。边界：shell.execute 的目录策略是 HUMAN_APPROVAL、本服务端未接 approval checker，故经此面调用仍 fail-closed DENIED（§23.4 规定行为）；git.*/test.run/ci.pipeline/deploy.run 标 implemented 但实现在各包内部、无服务端上下文无关 runner 形态——经此面调用响亮 FAILED（stderr 点名缺口）。
- **MCP 注册表 + 信任状态落库（§34/§46）**：新表 `mcp_servers`（注册全字段 + 信任等级/策略 + 评估 JSON）与 `mcp_installs` 写透；注册/握手协商/健康检查/历史追加/评估/安装/卸载全部经持久化接缝（包层保持 storage-agnostic：`McpRegistrySink` + manager 观察者 + `hydrateInstall()`/`hydrateAssessment()`，水合不产生新历史/审计事件）；服务端启动时水合，已批准服务器重启后保持信任（真 SIGKILL e2e：注册→approve→kill→重开→launch 201）。健康是时点数据：水合标 stale 且不装入 live 注册表；launches 仍进程内（Batch 19 口径）。机密防护：`credentialRefs` 只存引用名，`runtimePolicy.stdioEnvFixed` 的值落库前剥离（哨兵值全字节扫描钉住）。边界：多进程同时写同一 DB 的并发语义未做（单实例假设，与 merge queue 同口径）；腐坏行跳过并打日志不阻断启动。
- **§36 git evidence 五字段补齐（独立复核）**：复核结论——`GitRepo.merge()`/`log()` 与 MergeQueue 落库条目的五字段早就是真值，但落到 task 的 merge 证据记录在最后一公里被两条合并路由丢弃（参数显式下划线弃用）。已接通：`mergeEvidencePayload(pr, fields?)`，直接合并与队列合并的证据记录均含真值五字段（测试钉住 40/64-hex 格式与独立 `git rev-parse`/`git diff` 重算逐字一致）。边界：artifactDigest 对合并/commit 恒为 null（§40 构建 Digest 未与 git 证据面接线，记录缺失非占位）；外部工具执行的合并走无字段路径（null）；旧证据不回填；code_change 证据的 targetSha 是读取时刻 HEAD（已在代码注释写明快照语义差异）。
- **首次运行走查重跑（Batch 11 走查的第二版）**：新走查 `apps/server/tests/first-run-walkthrough-b21.test.ts`（`npm run demo:e2e-new` 可重复跑），真 server + 临时 DB、两 boot 中间一次 SIGKILL：12 步新链路（派发轴/outbox/run checkpoints/Secret Broker/交互式 PTY/备份计划/worktree/MCP 注册→信任审批→launch/PROD 部署 park→杀进程→重启→approve 真 SUCCEEDED）全绿 3/3；跨重启派发状态/outbox/备份/计划/worktree/MCP 信任/部署全保真，launch 表诚实为空；审计哈希链跨两 boot 验证通过。新发现 F6（中，基建）：部分包单独构建会导致 dist 跨包不一致——server 的 dist 调 mcp 的 dist 不存在的函数时真 server 启动直接崩溃；根 `npm test` 不跑 server 套件，门禁抓不住"编译产物能启动"的问题，建议 CI 加编译后启动冒烟。F7（低）：`GET /api/tasks/:id/outbox` 的 HTTP 形状与 DB 词汇（WORKFLOW_TRANSITIONED/FINALIZED）未对齐，暂无害。
- 主线收口修复 3 个真接缝问题：① 21-1 的 `tool-runner.ts` 无扩展名 value import 在 type-stripping 下 ERR_MODULE_NOT_FOUND；② 20-3 的 `backup-scheduler.ts` 同类问题；③ 走查测试继承开发者本地 git-ignored 的 `data/secrets/` 旧 vault 被 fail-closed 拒绝——走查现用 `FACTORY_SECRETS_DIR` 指向临时目录。教训已记入仓库级 AGENTS.md（tsc 与 type-stripping 双模式 import 规则；子批次自测数字不算数，主线必须在稳定树重跑 server 全套）。
- KNOWN_LIMITATIONS 更新三条（工具执行面、MCP 注册表落库、§36 五字段）+ 一条收口教训条目。测试基线 2146 → 2164（包套件），服务端全套 **233/233**。

## [未发布] Batch 19 — 部署持久化 / MCP 机密注入 / Worktree / 交互式 PTY 会话

- **部署持久化（§41/§77）**：deploy 经 `fdb.deployments` 写透（记录 + 可重建规格；DeploymentSpec 类型无机密值字段，值在构造上无法落盘）；重启后 `/approve` 先查注册表再按 pipelineId 重建 parked job（REHYDRATED），重建前重校验归档守卫（被归档 → 409 + `DEPLOYMENT_REBUILD_REFUSED`）与 §77 回滚能力（丢失 → 410 `DEPLOYMENT_UNRECOVERABLE`，不静默）。旧的「重启即 404」升级为重建或明确不可重建并说明原因。边界：pipeline 记录与 stage 定义仍进程内存，stub `/run` 明确 409（跑空 stage 会是假成功）。
- **MCP stdio 启动机密注入（§46.2 第二消费点）**：`POST /api/mcp/launch` 启动 stdio 服务器，`secretEnv {VAR: ref}` 的引用须先在 `credentialRefs` 中声明（未声明 403），再经 Secret Broker 短期租约解析注入子进程 env；值只在启动瞬间存在于进程内存；stdout/stderr 捕获即脱敏；缺失 ref → 403 且不启动。租约语义：rotation 只撤销 launcher 侧租约，运行中子进程保留旧值（`secretLeaseState` 标注透出）。未动 packages/mcp 内部。边界：新注册服务器默认 BLOCKED 且无信任审批 HTTP 端点，launch 对其 fail-closed 403（§46 信任流 HTTP 化为后续项）。
- **Worktree 分配器（§22.1 / G-37）**：新包 `@ai-factory/worktrees`，每个写入任务分配独立 git worktree（分支 `task/<shortid>-<slug>` 确定性命名，task id 嵌入）；记录落库（同一 (repo,task) 只允许一个 ACTIVE，partial unique index；路径全局唯一；release 只归档）；创建走 Git Broker 新增 `worktree` 动作门（task 绑定，拒绝零副作用）；release 校验记录路径（根目录内 + 命名模式）再删。非 Git 源如实降级 `dir-copy`；git 缺失而源是 git 仓库 → fail-closed。服务端 `/api/worktrees`（读 viewer/写 operator），`FACTORY_WORKTREE_ROOT` 配置。验证中抓到并修复 3 个真 bug（并发竞态/SQLite 错误分类/路由 404 口径）。边界：worktree 共享 common dir/hooks/refs，是任务级文件隔离不是 OS 安全隔离。
- **交互式 PTY 会话（§50.1）**：`@ai-factory/runtime` 新增 `PtySession`/`PtySessionManager`，内嵌 python3 监督进程持有真 PTY，控制管道（fd 3 JSON 行）实现真 resize（TIOCSWINSZ + SIGWINCH，补上 Batch 18 缺的通道）；服务端 `/api/terminal/*`（创建/列表/SSE 流/SSE 心跳/stdin/redo/resize/关闭）；Human/AI 独立 principal，AI 会话输入逐行过门（被拒行丢弃 + 审计 `AI_LINE_DENIED`，逐行近似不是防恶意模型的安全边界）；桌面 TerminalPanel 从仿真模式重接为真会话。控制端猝死时监督进程见 stdin EOF 即整树 SIGKILL 自杀（测试钉住）。
- KNOWN_LIMITATIONS 新增四条、§34 条目补 credentialRefs 消费句。测试基线 2091 → 2132。并行批次在途碰撞的主线收口：修 worktrees.test.ts 的 type-stripping 不兼容泛型写法（一行）。

## [未发布] Batch 18 — 授权轴收口 / Secret Broker / 真实 PTY / Dispatch UI

- **G-09 预授权票登记册**：`authorization_tickets` 落库 + `/api/authorization-tickets`（签发/列表/撤销）；POLICY 派发可引用票据，消费时校验状态/有效期/范围并留消费记录；票面类别维度以优先级表达（Task 无 task_type，G-06）。
- **G-11 子任务继承 + Scope Checker**（core `scope.ts`）：子任务继承 root 授权/需求版本/AC/政策上限/预算且不宽于 root；run 发起前范围校验。
- **resume 与 v2 门禁接授权轴**：§28.4 清单加 taskAuthorized；v2 transition 门禁从 Task 授权轴读真值。
- **§46.2 Secret Broker**（新包 `@ai-factory/secrets`）：引用式机密存取，env/file-vault（AES-256-GCM 机器绑定）/OS keychain（探测式）/memory 四后端，租约 + 撤销失效 + 输出脱敏；服务端仅元数据面，值永不经 HTTP 返回；`/api/exec` 新增 `secretEnv` 注入为真实消费点。验证中修复配置变量与机密前缀撞名的真 bug。
- **真实 PTY**（runtime `pty.ts`，G-11 部分）：内嵌 python3 监督进程分配真 PTY（尺寸预设、信号整树击杀），pipe/PTY 双模式对拍测试钉住 isatty/颜色/尺寸差异；`/api/exec` opt-in `pty: true` 且共用密钥脱敏，非旁路。无运行时 resize，仅 POSIX。
- **Dispatch 桌面页签**：待派发队列（POLICY 派发前端先拦缺 Rule ID）、草稿提交、授权撤销/过期二次确认、预授权票只读面；409 如实提示并刷新。
- KNOWN_LIMITATIONS 新增 Secret Broker 与 PTY 两条、§17.2 条目更新收口状态。测试基线 1999 → 2091。

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录
AI Factory 的变更，内容与 git 提交历史逐项对应（提交哈希附在各节标题后）。

**当前状态：尚未正式发布。** 全部条目属于 0.1.0 开发线（根 `package.json`
版本 0.1.0），版本号与分段只反映开发里程碑，不构成发布承诺。已知限制见
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)；发布前剩余事项见
[docs/release/RELEASE_CHECKLIST.md](docs/release/RELEASE_CHECKLIST.md)。

## [Unreleased] — 0.1.0 开发线

### 2026-10-12 · Batch 17 — Human Dispatch / Outbox 落库 / MCP 补齐 / 工具分类

- Added：§17.2 Human Dispatch——Task 独立的 authorization_status 轴
  （DRAFT/WAITING_HUMAN_DISPATCH/AUTHORIZED/REVOKED/EXPIRED，落库），
  五个派发端点全程审计；run 发起面对非 AUTHORIZED 任务 403 且零记录。
  存量与新建默认 AUTHORIZED（兼容决定，文档在案）；POLICY 预授权记录
  via 与 Rule ID、不冒充人工。
- Added：Outbox 落库（§18.2）——outbox_events 表自始存在却无写入者，
  现经引擎 OutboxSink 接缝写入；drain 是 dispatched_at 确认戳记、
  从不删行；GET /api/tasks/:id/outbox 拉取面 + health pending 计数。
- Added：§34 MCP 补齐——真实握手保存协商版本/扩展集（工具集漂移只标
  stale 不覆写）、元数据全字段 + 追加式安装/激活历史、四级健康（执行级
  无探针如实 unknown）、熔断 + bounded retry（未知副作用不重试）+ 同
  授权替代建议、运行时策略（stdio 环境过滤真实执行、gate 执行前拒绝）。
- Added：§33 工具分类——11 类一等枚举 + 注册表分类归一化/查询 + 全字段
  校验器 + 16 条内置定义（8 已实现 / 8 仅定义，逐条在案）。
- 主线复验：构建 0 错误，测试 1999/1999，全部 demo 通过。

### 2026-10-12 · Batch 16 — 审批 resume 修复 / Git Broker+合并队列 / §21 调度 / Observatory

- Fixed：pipelines approve 的 resume 此前永远找不到 parked 部署
  （DeploymentService 每请求新建）——parked job 改存可注入的共享注册表，
  跨请求 approve 真正完成部署；重启后 parked 不可恢复但失败明确（404），
  已写入 KNOWN_LIMITATIONS。
- Added：Git Broker（§36）按动作分级管控（策略未允许即拒绝、决策进
  审计、push/merge/remote 默认必须绑定 task），服务端 git 写路由改经
  Broker；Merge Queue 串行处理 PR、合并前组装候选并验证（缺省冲突
  检测），失败出队不阻塞队列。队列状态进程内，与 PrStore 一致。
- Added：§21 调度硬约束（G-30…G-36 全数落地）：九项前门禁结构化判定、
  enqueue 权力拒绝、多因子确定性排序（本地口径已标注）、aging、P0
  安全点抢占指令与迁移保护、预留槽、策略优化器 + 带解释的人工 override
  拒绝、预算货币/CPU/RAM 维度与原子 reserve→charge→settle/release、
  超限映射 BUDGET_BLOCK/RESOURCE_BLOCK 任务条件。服务端优先级校验
  同步对齐 P0–P4。
- Added：Observatory 桌面页签——全局 run 列表（服务端 join manifest
  摘要与 live 标记，中断遗留如实标注）、全量 manifest 展开、检查点
  查看复用、从检查点恢复入口（逐项 checks 结果如实呈现）。
- 主线复验：构建 0 错误，测试 1931/1931，全部 demo 通过。

### 2026-10-12 · Batch 15 — 守卫补齐 / RBAC / Checkpoint 恢复 / Run Manifest

- Fixed+Added：归档守卫补齐 pipelines/git 执行面（commit 在发生之前拒绝、
  纯仓库操作明确不守卫）；retention tombstone 映射使被删 run 的残留
  intents/checkpoints 继续按原项目解析，不再成永久孤儿。顺带记录既有
  缺陷：pipelines approve 的 resume 因服务实例-per-请求而不可达
  （KNOWN_LIMITATIONS 在案，待修）。
- Added：服务端 RBAC——viewer/operator/admin 三档（FACTORY_API_TOKENS），
  高危面（backup/restore/retention/policy/自治等级）仅 admin；不配置时
  单 token 即 admin、行为与从前逐字一致。whoami 端点 + 桌面顶栏角色徽标。
- Added：Checkpoint 恢复流程——POST /api/runtime/runs/:id/resume 按 §28.4
  逐项重校验，全过才生成新的恢复 run（预算基线与步位承接 checkpoint，
  linkage 落证据与审计）；明确不是内存现场热迁移。
- Added：Run Manifest——每次 run 的问责清单落库（身份/驱动/授权/预算/
  上下文哈希创建快照 + 终局/模型来源/用量/intent 分桶/证据计数补全），
  GET 查询面与 Final Report 运行记录段；遗留 run 无 manifest 返回 404，
  不回填编造。
- 主线复验：构建 0 错误，测试 1853/1853，全部 demo 通过。

### 2026-10-12 · Batch 14 — 桌面呈现 / 项目归档 / Adapter 契约 / Retention

- Added：桌面 UI 呈现已有服务端能力——Final Report 页签（Report）、备份/恢复
  面板（Ops，恢复为两段确认并明示 restartRequired）、run 详情的
  checkpoints 查看。空状态一律呈现服务端原文，不补数。
- Added：项目归档生命周期——active ↔ archived 落库（旧库自动补列），归档
  不删数据、只读面全开、列表默认过滤；全部产生新事实的写路径（任务/证据/
  流转/导入/run/v2/审批/review/QA）经共享 guard 拒绝（409 PROJECT_ARCHIVED）。
  已知未守卫：pipelines/git 执行面，见 KNOWN_LIMITATIONS。
- Added：§26.2 Adapter 十方法契约（adapter-contract.ts）——Stub 与 Codex
  两实现全量落地，同一契约测试电池双跑；不支持以 UNSUPPORTED 抛出、
  答不出以 source:'none' 表达，无假成功。顺带修复服务端 router 路径四个
  能力维度从未解析、quota checker 隐私口径与 router 相悖两处。
- Added：Retention + Legal Hold（§47）——按类别配置保留期，默认永久保留；
  evaluate 纯 dry-run，enforce 需显式确认字段且执行时重新评估；audit 与
  evidence 等类别明示排除并给出条款依据；孤儿记录 fail-safe 豁免并留
  tombstone 待办。
- 主线复验：构建 0 错误，测试 1844/1844，全部 demo 通过。

### 2026-10-12 · Batch 13 — v2 状态落库 / Checkpoint 真实消费 / 备份恢复 / 发布备料

- Added：TaskV2State 整体落库（`task_v2_state` 表）——v2 引擎镜像全字段在
  每次提交变更后落盘，重启水合恢复，finalSeal 跨重启保真（Batch 12 的 F1
  残留关闭）；DB 行对 v1 的有损写回映射不变。
- Added：Checkpoint 第一个生产消费方——HTTP run 经 AgentLoop 的 onTrace
  步界逐步捕获 checkpoint（字段全部来自真实事实），
  `GET /api/runtime/runs/:id/checkpoints[/latest]` 为恢复点读取面；
  不自动 resume。顺带修复：HTTP run 的 step intents 此前全盖 'unknown-run'，
  现盖真实 run id。
- Added：备份/恢复——`POST /api/backup`（VACUUM INTO 一致性快照 +
  manifest 哈希与逐表计数）、`GET /api/backups`、`POST /api/restore`
  （校验 → 自动 pre-restore 备份 → 排队至下次重启生效，旧库改名保留）。
  范围仅工厂数据库，边界见 KNOWN_LIMITATIONS。
- Added：发布备料——本 CHANGELOG、README 按现状改写、
  `docs/release/LICENSING_OPTIONS.md`（三条许可证路线对比，待 Tan 拍板）、
  `docs/release/RELEASE_CHECKLIST.md`。
- 主线复验：构建 0 错误，测试 1826/1826，全部 demo 通过。

### 2026-10-12 · Batch 12 — 走查发现 F1–F4 修复 + intent 先于权限门（`fc894da`）

- Added：`POST /api/tasks/:id/v2-complete`——服务端从真实事实组装 §20.1 完成
  快照并调用 `finalize()`，v2 生命周期经纯 HTTP 可达 DONE，final_seal=1 落盘
  且镜像与 DB 一致（F1）。
- Added：需求落库——requirements 包抽出 `RequirementStore` 接缝，db 包提供
  `SqliteRequirementStore`（版本行只写一次、永不更新）；服务端三 boot 回归
  钉住：重启后带 pin 证据登记不再 400、STALE 门中间的任务凭已存兼容声明
  直接放行（F2）。
- Changed：v2 迁移提交后封存被消费证据（`onSealEvidence` 接线）；谓词检查型
  证据（生产审批）不封存（F3）。
- Added：run 记录落库（`RuntimeRunStore` + `runtime_runs` 表），每次变更同步
  落盘；被杀进程的 RUNNING 记录原样保留、不自动改写（F4）。
- Changed：StepIntent 改为权限检查*之前*落盘，被拒调用留 DENIED 终态 intent
  （复核观察 1）；SQLite store 的 DENIED 标签与内存实现对齐。
- 主线复验：构建 0 错误，测试 1819/1819，全部 demo 通过。

### 2026-10-12 · Batch 11 — 首次运行走查 / Checkpoint 落库 / 打包收尾 / 独立复核（`53f04c5`）

- Added：首次运行全流程走查（真实 server × 3 次启动、同一临时库、纯 HTTP），
  八步全通并存档为常驻测试 `demo:e2e` 与 docs/FIRST_RUN_WALKTHROUGH.md；
  走查发现 F1–F4（见 Batch 12 修复）。
- Added：Checkpoint 落 SQLite（`CheckpointStore` 接缝 + `CheckpointLog` +
  `SqliteCheckpointStore`，`/api/health` 可查存量）。**诚实边界：尚无生产
  消费方，检查点级恢复未生效。**
- Added：应用图标（零依赖脚本生成 SVG 源 + PNG）、根 package.json 补
  author/desktopName；Linux AppImage 带图标重建（约 124MB）并无头运行验证。
- Added：独立复核报告 gap-audit/REAUDIT_BATCH_1_10.md——未参与开发的审计员
  抽查 Batch 1–10 共 21 条已关闭项，21 条全部证实、0 假关闭，附 4 条观察。
- Known issue：Windows 安装包未能在本机定稿——Ubuntu 包源不可达导致 wine
  无法安装；配置与载荷已就绪，需在 Windows 机器执行 `npm run dist:win`。

### 2026-10-12 · Batch 10 — 干净构建顺序 / HTTP run 工具白名单 / OperationLedger 落库 / 桌面 token（`e47c797`）

- Fixed：根 build/test 脚本改为经审计的拓扑序（查出 4 处顺序违规 +
  incidents 包从未被根 build 构建）；从全 dist 清空状态实测可一次构建成功。
- Added：`FACTORY_RUNTIME_TOOLS` 工具白名单——HTTP run 放行工具的唯一路径，
  未知工具名启动 FATAL / 请求 500 并写审计，默认不设 = 全拒。
- Added：OperationLedger 经 `OperationStore` 接口落 SQLite；服务端启动
  reconcile 只分类（safe-to-retry / needs-manual-recovery）写审计，不采纳不改状态。
- Changed：桌面端全部 22 文件 / 24 个 fetch 点统一注入认证头（无 token 时
  请求与改前逐字一致）。

### 2026-10-12 · Batch 9 — 可售性：DB 持久化 / API 认证 / Final Report / 桌面打包（`4dcce5b`）

- Added：审计哈希四列落 SQLite（链跨重启可验，旧行不伪造哈希）；
  `SqliteStepIntentStore` 接进服务端 run 路径；启动扫描写
  STARTUP_INTERRUPTED_INTENTS 审计并在 `/api/health` 可见（只报告不处置）。
- Added：服务端 API 认证 `FACTORY_API_TOKEN`（Bearer 门、统一 401 +
  AUTH_DENIED 审计、非 loopback 无 token 拒绝启动）。
- Added：Final Report 生成器 `GET /api/projects/:id/final-report`（含
  `?format=md`），全部段落源自 DB 真实记录，WAIVED 单列，带 sha256。
- Added：electron-builder 按真实主进程契约重写并打通 Linux AppImage
  构建 + 无头运行验证；修复后端自拉起死循环等两个真实 bug。

### 2026-10-12 · Batch 8 — 证据版本追踪转正 / 审计哈希链 / Exception Grant / 模型能力补齐（`987754a`）

- Added：证据版本追踪——登记证据校验 requirementId+version（假版本 400），
  evidence 表加 requirement_version 列；Batch 7 的兼容白名单经真实 HTTP 全链生效。
- Added：core 审计 hash chain（summaryHash 含 prevHash、GENESIS 根、
  verifyAuditChain 检篡改/调序/删除）。
- Added：§23.4 Exception Grant（human-only、理由必填、TTL 默认 24h/上限 7d、
  BLOCKED 动作不可豁免、WAIVED 单列且永不冒充 APPROVED）。
- Added：§26.1 ModelCapabilities 补齐 7 字段（目录值标注「声明值未经实测」，
  未声明 = 不具备，路由 reason 点名排除）。

### 2026-10-12 · Batch 7 — 完整性：空结果诚实化 / 证据兼容白名单 / 策略守卫 / 租约真等待（`8938108`）

- Changed：runtime harness 对空工具结果诚实化（0/false 是真结果；证据标
  empty:true、intent 的 resultHash 独立承诺）。
- Added：GateContext.compatibleEvidenceIds 只豁免版本不一致这一处 STALE
  判定（当时 server 侧为潜伏能力，Batch 8 转正）。
- Added：PolicyStore.set() 守卫——改/删/解锁已有 locked 规则须 caller 权威
  ≥ 该层，同层 peer 隔离，原子拒绝并留痕。
- Added：leases 真实超时等待（deadline 内重试、LockTimeoutError 带 waitedMs；
  timeout 0 保持旧单次语义）。

### 2026-10-12 · Batch 6 — 接线：v1 迁移 / git 证据五字段 / EMPTY_RESULT / 通知治理（`3498c9f`）

- Added：§58 v1→v2 迁移接进生产导入路径（migrate → validate → write；
  v1 任务完成只记 legacy_completion_unverified，禁集体 VERIFIED；迁移报告
  落 `.ai/migration-report.json`）。
- Added：§36 git 证据五字段（base/candidate/target SHA、diff sha256、
  artifactDigest；无产物如实 null + artifactNote）。
- Added：§33 工具 EMPTY_RESULT 结局（退出 0 + stdout 空 + 无产物，不算错误
  也不 seal 成功证据）。
- Added：§32 通知去重合并（滑窗 5 分钟）与限流（30/60s，超限汇总不静默）。

### 2026-10-12 · Batch 5 — 接线：评审独立性强制 / StepIntent 默认接线 / fallback 兼容性（`4ec1db6`）

- Added：server review 路由强制评审独立性（缺身份 400、自审 422、拒绝写
  审计、零证据封存）。
- Added：StepIntent 默认接线进 runAgent（当时为内存 store，落库见 Batch 9）。
- Added：G-57 fallback 兼容性注入路由决策（不兼容的 fallback 跳过并在
  reason 中点名）。

### 2026-10-12 · Batch 4 — 完整性硬约束（`b3e42bf`）

- Added：§16 需求数据层门禁——newVersion 不得绕过 HUMAN 授权改完成目标或
  AC 语义（diff 判定）；VERIFIED_DELIVERY 创建强制 HUMAN 授权 + 允许的
  项目类别。
- Added：§20 进度硬约束——无证据的正完成度被拒；无 seal 的计划封顶
  99.99% 并标注 blocker；ProgressReport.currentGate。
- Added：§18 引擎租约门谓词（STALE_OWNER，fail-closed）、成功迁移 Outbox、
  FailureEvent 记录。
- Added：§6 项目 discover 诊断（detected 与 verified 分离，绝不推断 PASS）；
  createProject 拒绝非空目录（force 可覆盖）。

### 2026-10-12 · Batch 3 — 接线收口（`6b55110`）

- Added：`POST /api/requirements/:id/links`（promotion-check 409 在完整
  HTTP 链验通）。
- Changed：看板 `/api/stats` 的 AOCR 改由真实数据喂给（口径明示：authorized
  := 有 APPROVED 审批，completed := DONE；无数据时如实 null/暂无数据）。
- Added：`GET /api/router/account` 改为 live 优先——经 CodexAdapter 查询
  真实账号状态并标注来源，失败才回退 stub（标注 STUB）；demo:codex 加入
  demo 套件（第 45 个）。

### 2026-10-12 · 真实模型接入（路线 B）：Codex app-server 适配器（`18fce3c`）

- Added：CodexAdapter 真实实现——JSON-RPC over `codex app-server --stdio`
  子进程或 ws://，initialize → thread/start → turn/start 全流程；动作映射
  为 observed actions（toolCalls 恒空，避免工厂 harness 重复执行）；线程
  默认只读沙箱 + approvalPolicy never，fail-closed；`getAccountStatus()`
  真实查询账号状态。
- Verified：假 app-server 夹具测试通过；真机验到认证边界（未登录 turn 被
  真实 401 拒绝、错误原文透传）。**真 turn 待 `codex login` 后验证，未完成。**

### 2026-10-12 · Batch 2 — 缺口修复（`96ade1c`）

- Added：PromotionHold 门禁强制、进度计划锁定 + 团队聚合、AOCR 主指标、
  runtime 预算在真实调用点强制、v2 工作流引擎服务端接线（v2-transition /
  v2-state 路由）。

### 2026-10-11 · 规格审计缺口修复批（`07efce4`）与 DEF 修复（`47856d7`、`ee355f2`）

- Fixed：59 章规格审计发现的 199 条缺口中先行关闭 24 条（安全、fail-closed
  审批/工作流、注册表完整性类优先）。
- Fixed：DEF-002/DEF-003——`POST /api/watchdog/workers` 与
  `POST /api/takeovers` 缺必填字段时返回 400（此前空 body 可穿透）；
  DEF-001（审批加固）已随 v2 实现关闭。

### 2026-10-10 · SPEC v2.0 实现（`55a9613`）

- Added：以 SPEC_V2.md（59 章、35 条不变量 INV-01–35、64 个 AT 场景）为
  权威规格，在 v1 代码上就地演进（非重写）：治理（审批 §23.3 加固、策略
  限制性交集、api-contracts）、状态真相（requirements §16、工作流三态 §18
  + 五里程碑 §19、progress §20）、执行面（隔离后端 fail-closed、tools §33、
  leases §22、factory-control §24）、验证（评审独立性 §37、qa §38、cicd
  风险/canary §40–41、incidents §42）、运行时（12 态 §25、durable ops §28、
  quota §27、watchdog §30、takeover §31）、证据契约 §39、数据与组织
  （db §48、组织图 §9、v1→v2 迁移 §52）、学习闭环（memory §43、knowledge
  §44、evaluation §45）、委派与报告（§12.2/§14）、桌面 OpsPanel。
- 当时验证：40 个包构建 0 错误，1470/1470 测试，桌面 Vite 构建通过；
  AT 映射 21 covered / 26 partial / 17 blocked（blocked 均为环境性）。

### 2026-10-10 · v1 规格全量同步（`1678960` 及此前 15 个同步提交）

- v1 原型全量代码同步至 GitHub（16 个提交）；其间补回本地已有但远端缺失的
  cicd、memory、skills 包源码与 package-lock.json，远端与本地树对齐。

### 2026-10-09 · v1 原型四批（`5b8d673`、`f0929e6`、`e9878c9`、`dc14b15`、`3dccf20`）

- Added：初始提交与四批原型——核心领域层与 Electron+React IDE 壳；Git/QA/
  审批面板与引擎；安全、快照/恢复、资源预算、自治分级、并行冲突串行化、
  争议裁决；Activity 流、Dashboard、组织图、任务详情、知识中心、模型注册
  表、通知、导入/导出、打包配置。此阶段为 v1.0 规格（`AI_factory.txt`）的
  原型实现，后由 SPEC_V2 取代为权威规格（见 2026-10-10 条目）。
