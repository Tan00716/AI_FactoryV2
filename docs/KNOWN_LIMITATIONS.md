# 已知限制（Known Limitations）

> 对应 SPEC_V2 §55.10：未实现能力明确标记，版本发布说明不把最终产品目标当当前能力。
> 本文档基于 2026-10-11 v2 轮全面测试的真实审计情况编写，不夸大、不隐瞒。

## 运行环境

- **当前仅在 Linux 上验证过**。规格要求的目标环境是 Windows（ENV-L），本机是 Linux，未在 Windows 真机上跑过。
- **没有打过安装包**。electron-builder 配置存在，但从未执行过，没有 `.exe` / `.dmg` 可分发安装包，只能从源码 `npm run dev` / `npm run electron` 启动。
- **Electron 桌面壳从未在真机上点开过**。测试环境无显示器，只验证了 Vite 构建成功，界面交互未做真机冒烟。

## AI 能力

- **模型适配器是 stub**。未接入任何真实 LLM（Anthropic / OpenAI 等），"AI 员工"不会真的干活，所有 AI 行为都是占位。
- **MCP Registry 有实现，但未接入真实 MCP 服务**。Unknown MCP 默认 BLOCK 的逻辑在，但没有连过真实服务器做握手验证。

## 隔离与安全

- **无真实隔离 Host**。在 Linux 本机直跑，非合规隔离后端；`CONFINEMENT_UNAVAILABLE` 的 fail-closed 路径有单测，但真实 Host 隔离未验证。
- Windows 工具探测（PowerShell / .NET 等）未在 Windows 上验证。

## 工作流引擎接线（§18.2，G-18）

- **v2 引擎已接线到服务端，但 Board 仍走 v1**。新增端点 `POST /api/tasks/:id/v2-transition` 与 `GET /api/tasks/:id/v2-state` 真实调用 `WorkflowEngineV2`（三态/里程碑/证据失效门禁），成功后写回 DB，门禁拒绝返回 422 且 DB 不变（有路由测试覆盖）。桌面 Board 的拖拽仍调用 v1 端点：Board 的列是 v1 状态（含 BLOCKED 等异常列），v2 是三态分离、且流转要求需求版本钉住（requirement pin），Board 目前不提供这些输入，硬切只会变成"永远回退 v1"的假接线，所以本批未切换 UI。
- **v2 引擎状态是内存镜像**。服务端以 taskId 为键在内存中维护 v2 状态，首次 v2 访问时从 DB 行的当前状态播种；服务重启后重新播种。v1 异常状态（BLOCKED、QA_FAILED 等）从未单独记录过 v2 阶段，首次播种的阶段是近似值（异常本身会播种为 v2 的 condition 字段）。
- **写回有一处有损映射**：v2 的 `OUTCOME_VERIFICATION` 阶段在 v1 状态列里没有对应值，写回为 `PROD_VERIFICATION`，精确阶段只能从 `GET /v2-state` 读到；`DONE` 只能经引擎 `finalize()`（完成谓词 + final_seal 同事务）到达，本批端点不暴露 finalize。
- **门禁输入部分靠调用方声明**：证据与依赖就绪由服务端按 DB 实算；budget/quota/confinement 三项服务端尚无可核验的服务，靠请求显式声明，未声明按 false 处理（fail-closed，拒绝流转而不是放行）；authorization 是调用方提供的快照（本机 API 尚无认证层）。

## 数据与团队

- **单机 SQLite**，无团队 PostgreSQL、无远程 Host、无 50+ 并发 Run 验证。
- 无测试生产环境：canary 发布、灰度、故障注入、24h 稳态均未跑过。
- **无真人 UAT / Outcome 验收**：AT-001–AT-064 没有一条达到端到端验收。

## 测试资产

- 计划宣称的 275 条正式用例集（`docs/testing/v2/`）不存在，记为 NOT_RUN，不是"通过"。
- 发现的 DEF-002 / DEF-003（API 空 body 校验）已在 `47856d7` 修复并推送；DEF-001 已关闭。

## 结论

当前是**可运行的原型**（构建 0 错误、1470/1470 单测、44/44 demo），不是可交付产品。上面每一条都是正式验收前必须补的。
