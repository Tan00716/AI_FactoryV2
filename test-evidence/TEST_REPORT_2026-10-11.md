# AI Factory 测试执行报告 — v2 轮（2026-10-11）

报告 ID：`TEST-2026-10-11-v2`
执行日期：2026-10-11，Asia/Kuala_Lumpur
执行者：实现方执行（Muse）。**非独立验证**——按 TEST_PLAN_V2 §3，强制独立验证不可由实现者独自提供，本轮结果不替代独立验证。

## 基线与被测对象

- 测试计划：`~/workspace/user/files/TEST_PLAN_V2.md`（2026-10-10）
- 规格基线：`SPEC_V2.md` v2.0（2026-10-05）
- 基线 SHA-256：`45e6c5ca32226f6863afd6b38a3adce4aa84cb5bb8aaefafb02ad43900ded2b8` —— **已核验一致**（sha256sum 实测）
- 被测应用 SHA：`55a9613c9a7efdb5f1d948291068414d1e7babc0`（GitHub `Tan00716/AI_FactoryV2` main，2026-10-11 已推送；工作树干净，仅本轮测试证据目录未跟踪）
- Harness：`node:test` + 自研脚本（`test-evidence/v2-round/smoke-v2.mjs`、`probes-v2.cjs`，非产品代码）

## 环境（诚实声明）

- 模式：个人本地（Linux）。**不是计划要求的 Windows ENV-L**，本机即为 Linux。
- OS：Linux htch-runtime 7.0.0-39-generic；工具链：node v24.20.0、npm 10.9.4、tsc。
- 隔离资格：无真实隔离 Host（本机直跑，非合规隔离后端）；`CONFINEMENT_UNAVAILABLE` 路径按 fail-closed 实现（有单测），真实 Host 验证缺失。
- 模型：stub（未接真实 LLM）；MCP：registry 存在，未接真实服务。
- 团队控制面 / PostgreSQL / 远程 Host / 测试生产 / 真人 UAT：**全部缺失**。

## 执行结果汇总

| # | 层级 | 结论 | 证据 |
|---|---|---|---|
| 1 | 基线核验 | **PASS** | SPEC_V2.md SHA-256 与计划声明一致 |
| 2 | 计划交付物检查 | **FAIL（计划资产缺失）** | `docs/testing/v2/` 不存在：275 用例、追踪矩阵、cases.json、verify-test-plan.mjs 均未创建（见下） |
| 3 | 干净构建 | **PASS** | 40 packages + desktop Vite，0 TypeScript 错误 |
| 4 | 全量单元测试 | **PASS** | **1470/1470，322 suites，0 fail，0 skipped** |
| 5 | Demo 脚本 | **PASS** | **44/44** exit 0 |
| 6 | API 冒烟 | **71/73**，2 缺陷 | 正向 2xx / 负向 4xx；DEF-002、DEF-003 |
| 7 | 静态检查 | **PASS** | tsc；secret 扫描 1 误报（`<redacted>` 占位符）；TODO 均为工作流状态名/注释 |
| 8 | P0 安全探针 | **6/6 PASS** | 含 DEF-001 回归探针（已关闭） |
| 9 | AT-001–AT-064 | **0 端到端通过** | 逻辑层 21 covered / 27 partial / 16 blocked（`docs/AT_MAPPING.md` 本轮复核） |

## 用例状态统计（按计划 §6 判定口径）

- 计划 275 条用例（211 领域 + 64 AT）：**NOT_RUN**——用例文件不存在，无法执行（不是"未安排"，是测试资产缺失）。
- 可执行层自验：**PASS**（构建 / 单元 / demo / API / 静态 / 探针）。
- **FAIL**：2（DEF-002、DEF-003，API 输入校验）。
- **BLOCKED**：全部真实环境项——Windows ENV-L、真实隔离 Host、真实模型/MCP、团队 infra（PostgreSQL/远程 Host/50+ Run）、测试生产（canary/发布/恢复）、真人 UAT/Outcome、性能与故障注入（ENV-B/P）。
- **N/A**：无（未做任何豁免）。

## 缺陷记录

**DEF-002**（新增，低/P2）：`POST /api/watchdog/workers` 空 body 返回 201，应 400。
- 复现：`curl -X POST /api/watchdog/workers -H 'Content-Type: application/json' -d '{}'` → `201 {"ok":true}`，注册了 `worker_id` 为 undefined 的 worker。
- 期望：400（`worker_id` 必填；同文件 heartbeat 路径有校验，注册路径漏了）。
- 影响：内存态测试 DB 产生脏记录；无越权、无破坏。对比 `POST /api/leases/acquire` 的正确实现。

**DEF-003**（新增，低/P2）：`POST /api/takeovers` 空 body 返回 201，应 400。
- 复现：`curl -X POST /api/takeovers -H 'Content-Type: application/json' -d '{}'` → `201`，创建了 `runId`/`resourceId` 为 undefined 的 takeover。
- 期望：400（`runId`、`resourceId` 必填）。
- 影响：同上，内存态脏记录。

**DEF-001**（历史，v1 轮 FAIL）：审批绕过（`decide()` 不校验 `decidedBy`、`request()` 放行 BLOCKED 动作）。**本轮关闭**：P3 探针确认 `request(secret.write)` 抛 `ApprovalBlockedError`、`decide` by rogue-agent 抛 `ApprovalDeciderNotAuthorizedError`；1470 单元测试中回归用例全部通过。

## 对测试计划本身的发现（非产品缺陷）

计划宣称"测试设计完成：275 条用例"，但以下交付物在仓库中**不存在**（`docs/testing/` 目录整个缺失）：
- `docs/testing/v2/cases.md`（211 领域用例 + AT-001–AT-064）
- `docs/testing/v2/traceability.md`（59 章 / 35 INV / 64 AT / 10 Done / 135 v1 迁移）
- `docs/testing/v2/cases.json`、`traceability.json`
- `docs/testing/v2/verify-test-plan.mjs`

因此 275 条正式用例记 **NOT_RUN**。这是测试资产缺口，不是产品缺陷；补齐用例集是计划作者侧的工作。

## AT 与不变量（本轮复核）

- AT-001–AT-064（`docs/AT_MAPPING.md`，本轮逐项复核）：
  - 21 条：逻辑层断言被本轮真实跑过的单元测试覆盖（39 个引用测试文件全部存在、有编译产物、在本轮 1470 中执行；抽查 DEF-001、INVALIDATED、symlink、34% 等特征用例名确认在输出中）。
  - 27 条：逻辑层部分覆盖 + 仍需真实环境（端到端）。
  - 16 条：完全受阻（需真实执行/生产/真人）。
  - **没有一条达到端到端验收**——"有代码/有单测"不等于验收通过。
- INV-01–INV-35：逻辑层由 1470 单元测试覆盖对应断言；真实系统验证 BLOCKED。
- 产品 Done（§55 十条）：**不可验收**（缺真实环境）。

## 性能 / 发布 / 恢复

未执行（无 ENV-B/ENV-P）。计划 §10 的采样安排（3 次正式运行、p95 口径、24h 稳态等）未跑。不编造数字。

## 证据索引（`test-evidence/v2-round/`）

- `unit-batch1.log`（1360 tests / 291 suites）、`unit-batch2.log`（110 / 31）——完整 TAP 明细
- `demo-*.log` ×44、`demo-summary.txt`（44/44）
- `api-smoke.log`、`api-smoke.json`（71/73 明细）、`smoke-v2.mjs`
- `static-checks.log`
- `security-probes.log`、`security-probes.json`（6/6）、`probes-v2.cjs`
- 本报告 `TEST_REPORT_2026-10-11.md`

## 结论

1. **可执行层全部通过**：干净构建 0 错误、全量单元测试 1470/1470（322 suites）、44/44 demo、API 冒烟 71/73、静态检查干净、6/6 P0 安全探针。
2. **发现 2 个低严重性缺陷**（DEF-002、DEF-003，API 输入校验）；**DEF-001 确认修复并关闭**。
3. **计划的 275 条正式用例因用例集缺失而 NOT_RUN**；AT-001–AT-064 无端到端通过（21 逻辑层覆盖 / 27 部分 / 16 受阻）。
4. **目标模式产品验收：不可验收**——缺 Windows ENV-L、真实隔离 Host、真实模型/MCP、团队 infra、测试生产、真人 UAT/Outcome。与 v1 轮结论一致，诚实边界不变：代码实现完成 ≠ 产品正式验收通过。
