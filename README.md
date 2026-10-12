# AI Factory（AI Engineering Factory IDE）

**本地优先的 AI 软件工程工厂：AI 员工负责干活，人负责把关——每一步流转都要过证据门禁、关键动作要人批准、全过程留一条可验真的审计链。**

当前状态：**可运行原型，尚未正式发布**（0.1.0 开发线）。本地优先：React 桌面
UI + Node.js API + SQLite 单机存储，无云、无账号体系。权威规格为 SPEC_V2.md
（v2.0）；仓库外同目录的 `AI_factory.txt` 是 v1.0 历史来源，已被 v2 全面取代。

验证基线（2026-10-12，Batch 12 后，主线亲自复跑）：

- 构建 0 错误；全量测试 **1999/1999 全绿**；46 个 demo 脚本全过（含首次运行走查 `demo:e2e`）
- Linux AppImage 已构建并无头运行验证通过（见「安装包」一节）
- 一次由未参与开发的审计员执行的独立复核：抽查 Batch 1–10 共 21 条已关闭项，
  21 条全部证实、0 假关闭（[gap-audit/REAUDIT_BATCH_1_10.md](gap-audit/REAUDIT_BATCH_1_10.md)）

## 真实能力（已实现并经测试/走查验证）

- **证据门禁工作流**：AI 只能*申请*流转，引擎按每条迁移的证据要求*裁决*；
  拒绝时逐项点名缺什么（422 + missing 清单），DB 状态不变。
- **v2 三态工作流引擎已接线服务端**：`POST /api/tasks/:id/v2-transition`、
  `GET /api/tasks/:id/v2-state`、`POST /api/tasks/:id/v2-complete`（服务端组装
  §20.1 完成快照、调用 `finalize()`，完成谓词校验 + DONE + final_seal=1 一次提交）。
- **证据不可变**：证据 DRAFT → SEALED 后改/删抛错；v2 迁移提交后，被该 Gate
  消费的证据立即封存（谓词检查型证据如生产审批不算消费、不封存）。
- **需求版本治理（§16）**：需求版本只增不可变、任务钉住版本；升版后旧证据走
  STALE 门、须显式兼容声明才放行；完成目标/验收语义变更与 VERIFIED_DELIVERY
  强制 HUMAN 授权；Promotion Hold 可冻结晋升（409 全链路）。需求、版本、链接、
  Hold、兼容声明全部落 SQLite，重启不丢。
- **审批硬约束**：评审独立性在服务端强制（缺评审身份 400、自审 422
  INDEPENDENCE_REQUIRED、拒绝写审计且零证据封存）；Exception Grant 为
  human-only 授予、带理由与 TTL，WAIVED 是独立裁决、类型层面永不冒充 APPROVED；
  BLOCKED 类动作（如 secret.write）不可豁免。
- **审计哈希链**：append-only 审计带 summaryHash/prevHash 链（GENESIS 根），
  `verifyAuditChain` 可检出篡改/调序/删除；审计落 SQLite，跨重启仍可验真。
- **运行时治理**：12 态 run 状态机；StepIntent 在工具执行*前*落盘、被权限
  拒绝的调用留 DENIED 终态 intent（不再无记录）；工具执行走白名单
  （`FACTORY_RUNTIME_TOOLS`，默认全拒）；预算/配额在真实调用点扣减；
  harness 对空工具结果如实标 EMPTY_RESULT，不封存假成功证据。
- **关键状态全部落库（SQLite）**：任务/证据/审批/需求/run 记录/审计/
  step intents/external operations/checkpoints。启动扫描只报告不处置：
  中断 intent 与未终态 operation 写审计并在 `/api/health` 可见，绝不自动
  改写为已执行、绝不重放。
- **Final Report 生成器**：`GET /api/projects/:id/final-report`（`?format=md`
  输出 Markdown），全部段落源自 DB 真实记录，无数据如实标注，WAIVED 单列，
  报告带 sha256 且生成动作本身写审计。
- **API 认证**：设置 `FACTORY_API_TOKEN` 后 `/api/*` 需 Bearer 令牌
  （健康端点豁免）；非 loopback 绑定且无 token 时服务拒绝启动。
- **真实模型接入（一条）**：CodexAdapter 已真实实现——经 JSON-RPC 连接
  Codex app-server（stdio 子进程或 ws://），走完 initialize → thread/start
  → turn/start；账号状态可 live 查询（未登录如实标注）。**真 turn 尚未验通，
  见下方非能力清单。**
- **桌面 IDE 壳**：Electron + React，含任务 Board、组织图、任务/Agent 详情、
  Git/QA/审批/CI-CD/技能/Memory/MCP/知识/评估等面板、Monaco 编辑器、
  xterm 终端、Activity/Run 详情（凭据自动脱敏）。
- **领域包矩阵（40 个包）**：Git 引擎、QA 失败闭环、CI/CD 风险分级与
  canary、技能注册与安装安全门、结构化记忆、模型路由、编排调度、员工工厂、
  事件总线、事件/事故、快照恢复、资源预算、自治分级、协调锁、争议裁决等，
  每个包带单测与 demo（见 `package.json` 的 `demo:*` 脚本）。

## 明确不具备 / 未验通（非能力清单）

完整清单以 [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) 为准，以下为要点：

- **Codex 真 turn 端到端未验通**：适配器已验到认证边界（未登录时真实 401
  原文透传、不伪造成功）；完成验证需在机器上执行 `codex login --device-auth`。
- **除 Codex 外的模型供应商适配器仍是 stub**（脚本回放，不消耗真实额度，
  也不产生真实结果）。
- **MCP Registry 未接入任何真实 MCP 服务**（未知来源默认 BLOCK 的逻辑在，
  未做真实握手验证）。
- **Checkpoint 已落库且运行路径已真实捕获**（Batch 13）：HTTP run 每步
  捕获一条 checkpoint 并可经 API 查询最新恢复点；但**不自动 resume**——
  重启后只提供恢复点，恢复决策留给人工/上层。
- **桌面 Board 仍走 v1 流转端点**，未切 v2（Board 列模型与 v2 三态/版本钉
  的输入不匹配，硬切只会是假接线，故未切）。
- **v2 引擎状态已落库**（Batch 13）：完整镜像与 finalSeal 跨重启保真；
  仅无 DB 的嵌入场景仍为进程内镜像，首次访问无落盘行时仍按 DB 行近似播种。
- **无真实隔离 Host**：本机直跑，`CONFINEMENT_UNAVAILABLE` 的 fail-closed
  路径有单测，真实隔离未验证。
- **单机 SQLite**：无团队数据库、无远程 Host、无并发/稳态/真人 UAT 验证；
  规格测试计划宣称的 275 条正式用例集（`docs/testing/v2/`）不存在，记 NOT_RUN。
- **仅在 Linux 上验证过**；Windows/macOS 安装包未定稿（见下），**三平台均未签名**。

## 运行

环境：Node ≥ 22（使用内置 `node:sqlite`，无原生插件）。

### 从源码运行（开发模式）

```bash
npm install
npm run dev        # 构建全部包，然后启动 API (:3100) + UI (:5173)
```

打开 http://localhost:5173 。首次启动会在 `./data/factory.db` 建库并播种
演示项目、AI 组织与任务。

### 安装包运行（Linux AppImage）

```bash
npm run dist:linux   # 产出 release/AI Factory-<版本>.AppImage（约 124MB）
./release/"AI Factory-0.1.0.AppImage"
```

AppImage 会拉起内置后端（127.0.0.1:3100）与桌面窗口，本机已无头运行验证
通过（后端单进程、API 返回真实数据、数据库真实落盘）。`release/` 为本地
产物目录（已 gitignore）。Windows 安装包需在 Windows 机器上执行
`npm run dist:win` 定稿（配置、图标、载荷均已就绪，本开发机无法完成该步）；
macOS 需在 Mac 上执行 `npm run dist:mac`。打包细节见
[docs/packaging.md](docs/packaging.md)。

### 测试与演示

```bash
npm test             # 全量单测（基线 1844 条，见文首日期）
npm run demo:e2e     # 首次运行全流程走查（真实 server × 多次重启，纯 HTTP）
npm run demo         # 证据链演示：TODO → DONE，中间有一次门禁拒绝
npm run demo:codex   # Codex 适配器演示（假 app-server，不需要登录）
```

首次运行的完整剧本与每步实际结果见
[docs/FIRST_RUN_WALKTHROUGH.md](docs/FIRST_RUN_WALKTHROUGH.md)。

## 关键环境变量

| 变量 | 作用 |
|---|---|
| `FACTORY_API_TOKEN` | 设置后，除健康端点外所有 `/api/*` 请求须带 `Authorization: Bearer <token>`；未授权返回统一 401 并写 AUTH_DENIED 审计。绑定非 loopback 地址且未设置此变量时，服务**拒绝启动**。桌面端把 token 存在 localStorage 并自动注入请求头。 |
| `FACTORY_API_TOKENS` | 可选多角色令牌：`FACTORY_API_TOKENS="viewer:只读令牌,operator:操作令牌,admin:管理令牌"`。viewer 只能 GET；operator 可做任务/证据/流转/run/审批等日常写操作；backup/restore、保留策略与 legal hold 等高危面仅 admin。角色不足返回 403 并记 RBAC_DENIED 审计；`GET /api/auth/whoami` 可查当前令牌的角色。不设此变量时，`FACTORY_API_TOKEN` 即 admin 全权，行为不变。 |
| `FACTORY_RUNTIME_TOOLS` | HTTP 发起 run 时允许执行的工具白名单（逗号分隔，如 `echo,add`）。**未设置 = 全部工具拒绝**（fail-closed）；名单含未注册工具名时启动期 FATAL、请求期 500 并写审计。每次 run 写 RUNTIME_RUN_STARTED 审计（含 grantedTools）。 |

## 架构速览

```text
apps/desktop     React + TypeScript UI（Electron 壳，electron/main.ts 拉起后端）
apps/server      零依赖 node:http JSON API (:3100)，路由按域拆分在 src/routes/
packages/*       40 个领域包：core（工作流/证据/任务/审计）· db（SQLite 落库）·
                 runtime（run 状态机/harness/适配器）· requirements · approvals ·
                 git · qa · cicd · skills · memory · model-router · orchestrator ·
                 security · recovery · resources · quotas/leases/watchdog/takeover …
```

核心原则（证据高于声明）：

```text
AI 申请流转 → 引擎查门禁 → 证据齐全且裁决通过？
   │ 是：封存被消费证据、迁移状态、写审计        │ 否：DENY + 逐项点名所缺
   ▼                                            ▼
```

## 文档索引

- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) — 已知限制（权威口径，不夸大）
- [docs/FIRST_RUN_WALKTHROUGH.md](docs/FIRST_RUN_WALKTHROUGH.md) — 首次运行走查实录
- [docs/packaging.md](docs/packaging.md) — 打包方式与三平台实测状态
- [CHANGELOG.md](CHANGELOG.md) — 变更记录（0.1.0 开发线，尚未正式发布）
- [gap-audit/REAUDIT_BATCH_1_10.md](gap-audit/REAUDIT_BATCH_1_10.md) — 独立复核报告
- [docs/release/RELEASE_CHECKLIST.md](docs/release/RELEASE_CHECKLIST.md) — 发布前剩余事项
