# AI Factory 测试执行报告

- 报告日期：2026-10-10（Asia/Kuala_Lumpur）
- 测试对象：`~/workspace/ai-factory/`（本地提交 `a2a603d`）
- 测试依据：`~/workspace/user/files/TEST_PLAN_V2.md` 的方法与判定规则
- 执行方式：实现方执行（三路并行：构建+单元+demo / API+静态 / P0安全对抗），**不替代计划要求的独立验证**

## 1. 准入检查（计划 §12）

| 检查项 | 结果 |
|---|---|
| 基线 SPEC_V2.md（计划声明 SHA-256 `45e6c5ca…00ded2b8`）| **缺失**：工作区内不存在，无法校验基线 |
| 详细用例 `docs/testing/v2/cases.md`（211 领域用例）| **缺失** |
| 追踪矩阵 `docs/testing/v2/traceability.md` / `cases.json` / `traceability.json` | **缺失** |
| 计划校验脚本 `docs/testing/v2/verify-test-plan.mjs` | **缺失** |

结论：正式 275 用例 campaign 按计划 §12 准入失败，记 **BLOCKED**（基线不可追、用例不可得）。
本轮实际执行的是仓库内可执行层（构建 / 单元 / demo / API / 静态 / 安全探针），全部为本轮真实运行结果。

## 2. 执行结果

| # | 项目 |  verdict | 证据 |
|---|---|---|---|
| 1 | 干净构建（删全部 dist 后 `npm run build`） | **PASS** | exit 0，TS 错误 0；唯一告警为 monaco chunk-size（已知）— `build.log` |
| 2 | 全量单元测试 `npm test` | **PASS** | **993/993**，197 suites，0 fail，0 skipped — `test.log` |
| 3 | Demo 脚本 23/23 | **PASS** | 全部 exit 0（证据链/qa/cicd/skills/memory/runtime/orchestrator/factory/mcp/knowledge/evaluation/comms/artifacts/projects/review/release/policy/security/recovery/resources/autonomy/coordination/dispute）— `demo-*.log`、`SUMMARY.md` |
| 4 | API 冒烟 26 路由组 | **PASS** | **54/54**：每组 ≥1 正向 2xx + ≥1 负向 4xx 且 reason 明确 — `api-smoke.log`、`api-smoke.json` |
| 5 | 静态检查 | **PASS** | tsc strict（base + desktop check）0 错误；密钥扫描 3 命中全为占位符/测试固件，无真实硬编码密钥；README 的 `npm run` 命令全部在 package.json 真实存在 — `static-checks.log` |
| 6 | P0 安全探针（单元/API 层） | **5/6 PASS，1 FAIL** | 见 §3 — `security-probes.log` |

负向测试行为抽查（实际观察）：非法工作流跳转 → 422 门禁拒绝；缺参 → 400+明确 reason；
审批 decision body 非法 → 400；未知来源 skill 扫描 → 200 `verdict: BLOCK`；
SEALED 证据 update/delete → 抛 `EvidenceSealedError` 且 sha256 不变。

## 3. 缺陷

### DEF-001（严重）：审批管理器未强制执行策略 —— FAIL

- **现象**：`policy.ts` 把 `secret.write` 标为 `BLOCKED`，注释声称 "manager will never grant an approval for them"；
  但 `ApprovalManager.request()` 不校验策略，`decide()` 直接批准了 `secret.write`。
  同时 `decide()` 不校验 `decidedBy` vs `requiredApprover`：
  `requiredApprover='human'` 的请求可被 `decidedBy='rogue-agent'` 批准。
  HTTP 层 `POST /api/approvals/:id/decision` 直接调用 manager，无额外检查。
- **位置**：`packages/approvals/src/manager.ts`（`request()` / `decide()`）；
  `packages/approvals/src/policy.ts`（`evaluateAction()` 注释与实现脱节）
- **核实**：已人工阅读代码确认（`request()` 无策略检查；`decide()` 只检查状态/过期，不检查 `decidedBy`）。
- **影响**：恶意 agent 可为自己创建并批准高敏操作（含政策 BLOCKED 项），审批门禁可被绕过。
  有审计记录（事后可发现），但无事前阻止。
- **建议修复**：`request()` 对 `evaluateAction()==BLOCKED` 的动作直接拒绝；
  `decide()` 校验 `decidedBy` 满足 `requiredApprover`（至少 human 审批须由 human 身份执行）。

### DEF-002（轻微）：新 checkout 后必须先完整构建

- `dist/` 被 gitignore，多数包缺构建产物时 server 无法启动；需先跑全量 `npm run build`（约 7 分钟）。
- 建议：README 明确标注"先 build 后 start"的顺序。

## 4. 未执行项（BLOCKED / NOT_RUN，非实现问题）

- 计划 275 条用例（211 领域 + 64 AT）：用例文件不存在 → **BLOCKED**
- SPEC_V2 基线验收：基线文件不存在 → **BLOCKED**
- 真实 Electron 启动、Windows ENV-L、团队模式（PostgreSQL/多 Host/50+ Run）、性能基准（p95）、
  故障注入/混沌、真实模型与 MCP 接入、Windows 打包安装 → **BLOCKED**（环境不具备；本机为 Linux）
- 独立验证人复核：本轮为实现方自测 → 按计划 §3 不可视为强制独立验证

## 5. 证据索引

`~/workspace/ai-factory/test-evidence/`：
`build.log`、`test.log`、`demo-*.log`（23 个）、`demo-summary.txt`、`SUMMARY.md`、
`api-smoke.log`、`api-smoke.json`、`static-checks.log`、`security-probes.log`、本报告。

## 6. 结论

- **可执行层：全部通过**（构建 / 993 测试 / 23 demo / 54 API / 静态 / 5 项安全探针）。
- **正式验收：不可宣称通过** —— 275 用例 campaign 因基线与用例缺失而 BLOCKED，
  且存在 1 个严重安全缺陷（DEF-001）待修复。
- 按计划 §13 口径：目标模式产品退出标准**未达成**。
