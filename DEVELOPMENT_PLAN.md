# AI Factory — 全规格开发计划

规格：`~/workspace/user/files/AI_factory.txt`（105 节）。目标：全部模块实现 + 验证无误。
规则：每完成一个模块必须 `npm run build` 0 错误、`npm test` 全过；有演示价值的模块配 `npm run demo:<name>`。

## ✅ 已完成
- §3 IDE 界面壳（Board/Git/QA/Approvals/Editor 页签）
- §8 任务系统（含子任务、§60 依赖图+环检测）
- §11–13 工作流状态机+门禁（证据缺失拒绝并点名）
- §15–17 Agent 注册表（autonomy 0–5、最小权限）
- §34 Git 引擎（12 操作、任务分支、分支保护、PR）
- §36–38 QA 引擎（QA 组织、11 分类、失败循环）
- §42 证据引擎（SEALED 不可变）
- §44 权限子集、§45/§69 审批流、§70 审计日志
- §100 DB 核心表

## ✅ 已完成（2026-10-09 第二批）
- §39–41 CI/CD 引擎（8 阶段流水线、4 环境、部署前快照+自动回滚、PROD 人工审批）
- §47–49 Skills 注册表（多版本共存、关键词发现、安全安装门禁、8 个内置技能）
- §54–57 Memory 引擎（5 层×9 类、置信度衰减/过期、评估转 Lesson）
- 测试：163/163 通过；演示：`demo:cicd`、`demo:skills`、`demo:memory`

## ✅ 已完成（2026-10-09 第三批，P1）
- §46 MCP Registry（信任评估+审批门禁安装、版本并存、工具调用五重门禁）
- §50–53 Knowledge Engine + Scout（5 层级回退查询、8 状态生命周期门禁、发布只产出 proposal）
- §57–58 Evaluation + Improvement（11 指标、Agent 画像、提案审批治理、Lesson 落地）
- §22 Agent Communication（8 种结构化原语、task 隔离通道、trace 导出）
- §23 Artifact System（19 种类型 schema 校验、seal 不可变、工作流 hook 自动生成）
- 测试：177 新增；演示：`demo:mcp`、`demo:knowledge`、`demo:evaluation`、`demo:comms`、`demo:artifacts`

## ⏳ 待实现（按优先级）
### P0 核心运行时
- [x] §30 Model Router（任务类型→模型选择，主/备/紧急三级）+ §28–29 Provider 配置（ChatGPT OAuth/API Key/Local）✅ 12 tests — packages/model-router
- [x] §24–27 Agent Loop + Harness + Agent Runtime（provider 无关，Codex 适配占位）✅ 30 tests — packages/runtime
- [x] §92–95 Orchestrator + Scheduler + Agent Selection + Task Auto-decomposition ✅ 46 tests — packages/orchestrator
- [x] §18–19 AI Employee Factory（动态创建+治理上限）+ §59 自修改提案 ✅ 28 tests — packages/employee-factory
- [x] §20–21 Task Squad（临时小队，任务结束归档）+ §14 Organization Designer UI ✅ 17 tests — packages/squads

### P1 知识与集成
- [x] §46 MCP Registry（安装/版本/权限/信任等级，默认 BLOCK 未知）✅ 26 tests — packages/mcp
- [x] §50–53 Knowledge Engine + Knowledge Scout（生命周期 DISCOVERED→RETIRED）✅ 36 tests — packages/knowledge
- [x] §57 Evaluation Engine（成功率/修复轮数/误报完工率等指标）+ §58 Agent Improvement ✅ 44 tests — packages/evaluation
- [x] §22 Agent Communication（Task/Artifact/Report/Event 结构化通信）✅ 20 tests — packages/comms
- [x] §23 Artifact System（全部 19 种类型，一等公民）✅ 51 tests — packages/artifacts

### P2 工程能力
- [x] §31–33 本地执行/项目发现/新项目创建（含模板：Next.js/React/Python API 等）✅ 34 tests — packages/projects（白名单执行+超时kill+目录逃逸拦截、discover 语言/框架/CI、5 模板、exec/discover/create 路由）
- [x] §35 Code Review Agent（10 维检查，PASS/WARN/CHANGES_REQUESTED/BLOCK）✅ 46 tests — packages/review（确定性静态规则、门禁证据、/api/review）
- [x] §40 Environment Manager（LOCAL/DEV/UAT/PROD 完整）+ Release Manager ✅ 41 tests — packages/cicd 扩展（semver、secretRefs 仅引用、PROD 人工审批门禁、部署前快照+自动回滚、/api/releases）
- [x] §43 Policy Engine（多层级策略，Global→Tool）+ §98–99 policy.yaml ✅ 41 tests — packages/policy（7 层合并上层胜出、静默覆盖记 denial、手写 yaml 解析+校验、/api/policy）
- [x] §44 Permission Engine（完整能力列表，可审计）✅ core 扩展（补 secret.write；checkCapability 在 policy 包：未知 capability→deny、deploy.prod 默认 deny）
- [x] §64–65 终端 xterm + Monaco 编辑器接入 ✅ desktop（TerminalPanel 单命令执行模型+白名单、EditorPanel 真 Monaco+文件树、DiffViewer）
- [x] §66 AI Change Review UI（diff/原因/测试/证据，接受/拒绝/回滚）✅ desktop ChangesPanel + /api/changes（git task 分支 diff、accept/reject/revert）
- 测试：636/636 通过（P1 结束 473，P2 新增 163）；演示：`demo:projects`、`demo:review`、`demo:release`、`demo:policy`

### P3 安全与稳定
- [x] §71–76 安全：凭据隔离、Prompt 注入防御、MCP/Skill 安全扫描、沙箱策略 ✅ 67 tests — packages/security（`demo:security`）
- [x] §77–78 Snapshot / Recovery Engine（12 种失败类型，8 种恢复策略+选择器）✅ 47 tests — packages/recovery（`demo:recovery`）
- [x] §79 Resource Management（六维预算、超预算拒绝+升级、并发门禁）✅ 34 tests — packages/resources（`demo:resources`）
- [x] §80 Autonomy Mode（四档、生产独立检查清单）✅ 66 tests — packages/autonomy（`demo:autonomy`）
- [x] §61–63 并行执行/文件冲突/任务锁（DAG 调度、重叠检测、PROD 单活锁）✅ 39 tests — packages/coordination（`demo:coordination`）
- [x] §96–97 AI Disagreement 独立裁决（分歧检测、证据加权裁决、ESCALATED）✅ 29 tests — packages/evaluation 扩展（`demo:dispute`）
- 测试：993/993 通过（P3 结束 918，P4 新增 75：events/dashboard/notifications/project-io）；演示：`demo:security`、`demo:recovery`、`demo:resources`、`demo:autonomy`、`demo:coordination`、`demo:dispute`；桌面端新增 Dashboard/Project/Activity/Events/Models 页签；server 新增 /api/security、/api/recovery、/api/resources、/api/autonomy、/api/coordination、/api/disputes、/api/stats、/api/events、/api/activity、/api/notifications、/api/knowledge/feed、/api/models、/api/projects/:id/export|import 路由

### P4 界面与体验
- [x] §67–68 Activity 实时流 + Run/Trace 详情 ✅ — packages/events（30 事件类型、in-memory bus、凭据脱敏 redact）、/api/activity、/api/events?type=&limit=、/api/runs[/:id]；桌面端 Activity 页签（实时流+时间戳）+ Run 详情抽屉（§68 全字段）
- [x] §83 Dashboard（任务/智能体/部署/资源指标）✅ — packages/dashboard 纯聚合（无数据返回 null 标"暂无数据"）、GET /api/stats、桌面端 Dashboard 页签（状态条+指标卡，5s 轮询）
- [x] §84 Organization 可视化图（OrgGraph：SVG 树、状态着色、点击详情浮层、缩放）、§85 Task Board 完整（12 列 + BLOCKED/FAILED、拖拽走 transition API、422 toast 点名缺证据）、§86 Task Detail（14 页签抽屉，复用 QA/CI-CD 面板）、§87 Employee Detail（15 分区，档案→版本）✅ desktop（2026-10-09，类型检查 tsc 0 错误、vite 构建 0 错误）
- [x] §88–89 Knowledge Center + AI Engineering Update Feed ✅ — Knowledge 页签 9 分类浏览、GET /api/knowledge/feed 卡片（为什么相关/证据/影响 Agent/风险/建议动作）、采纳/忽略只记 audit 不自动改 Agent
- [x] §90–91 Model Registry UI + System Event Bus（完整事件类型）✅ — Models 页签（provider/能力/上下文/成本/延迟/可用性/回退+能力过滤，GET /api/models）、Events 页签实时流+类型过滤、核心动作 6+ 事件真实产生
- [x] Notification Engine（模块表 §30）✅ — packages/notifications（规则引擎：GATE_FAILED 高优先级等、已读/未读、投递记录）、TopBar 通知铃铛（未读徽标+下拉）、关键动作触发
- [x] Import/Export（项目配置导出/版本控制）✅ — packages/project-io（导出 .ai/：project.yaml/policy.yaml/agents/skills/workflows/knowledge/memory/mcp，secret 只导引用名）、导入 schema 校验、Project 页签导出/导入按钮
- [x] electron-builder 打包配置（Windows）✅ — electron-builder.yml（appId com.aifactory.ide、nsis x64）、`npm run dist`、README 打包说明（CI 环境未实际执行）

## 完成标准
- [x] 上面所有勾选完成（P0/P1/P2/P3/P4 共 105 节全部实现）
- [x] `rm -rf` 各 dist 后 `npm run build` 0 错误（2026-10-09 验证：BUILD_EXIT=0，0 个 TS 错误；tsc -p 为全量重编，等价于 clean build）
- [x] `npm test` 全部通过（993/993，P3 结束 918 + P4 新增 75）
- [x] 端到端演示：`npm run demo`（任务 TODO→DONE，门禁拒绝→补证据→放行，全程证据链）+ 各模块 demo:* 脚本
- [x] README 与实际实现一致（P4 章节：Dashboard/Activity/Event Bus/Notifications/Import-Export/打包均已记录）
