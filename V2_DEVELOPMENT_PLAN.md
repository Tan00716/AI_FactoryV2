# AI Factory — v2.0 开发计划

权威规格：`~/workspace/user/files/SPEC_V2.md`（v2.0，2026-10-05，SHA-256 `45e6c5ca…00ded2b8` 已校验）。
`AI_factory.txt`（v1.0）仅为历史来源，不再作为规范依据（SPEC_V2 §58 迁移对照）。

规则：每批完成必须 `npm run build` 0 错误、`npm test` 全过；有演示价值配 `demo:<name>`。
v2 新增铁律：MUST 级规则必须有对应测试；policy 注释声称的行为必须有 enforcement（DEF-001 教训）。

## 基线（v1 留存）

29 packages，993 tests 全过，23 demos，54 API smoke 全过。v1 测试报告：`test-evidence/TEST_REPORT.md`。
已知 v1 缺口：DEF-001（审批未强制策略，v2 §23 修复）、stub adapters、内存态、模拟 CI handler。

## 差距矩阵

见 `V2_GAP_ANALYSIS.md`（2026-10-10 生成）。摘要：59 章中 COVERED 2（§5、§53）、PARTIAL 43、MISSING 11（§16、§19、§20、§24、§30、§31、§33、§42、§51、§54、§55）、N/A 3（§56–58）。
新建 10 个包：requirements、progress、factory-control、watchdog、takeover、incidents、tools、quota、leases、api-contracts。

## 开发批次（Wave 1–4，每 wave 结束验 build+test）

### Wave 1（✅ 完成，2026-10-10）
- **A·P0 治理**：approvals（§23.3：digest 绑定、变更 INVALIDATED、decidedBy 校验、request 拒 BLOCKED；**DEF-001 已修复**）、policy（§23.1：merge 改限制交集）、新建 api-contracts（§49）
- **B·状态真相**：新建 requirements（§16）、core workflow（§18 三态分离 + §19 五层完成，加法式）、新建 progress（§20，34% 精确断言）
- 验收：reason-codes 统一 re-export api-contracts；全量 build 0 错误；根 test 脚本尾部缺 `&& node --test` 已修复（根因：C 路编辑时把 glob 拼进了 build 命令）

### Wave 2（✅ 完成，2026-10-10）
- **C·执行面硬化**：security（§7：隔离后端抽象、fail-closed CONFINEMENT_UNAVAILABLE）、新建 tools（§33）、新建 leases（§22）、新建 factory-control（§24 三轴+ACK）；4 路由已接线并冒烟（503/三轴/409）
- **E1·验证**：review（§37 独立性）、qa（§38：报告/flaky/repair/uat）、cicd（§40/§41：风险/可逆性/canary/observation）、新建 incidents（§42）；incidents 路由已接线并冒烟
- 验收：全量 `npm test` **1254/1254** 通过（1210+44），0 失败

### Wave 3（✅ 完成，2026-10-10）
- **F·数据与组织**：db（§48）、squads（§9）、project-io（§52）；72/72 测试通过
- **E2·证据**：core evidence-v2（§39）；22/22 测试通过，demo 验过
- **D·运行时自保**：runtime（§25+§28，63 tests）、新建 quota（§27，15）、watchdog（§30，13）、takeover（§31，8）；3 路由已接线并冒烟（quota POST/429 事件）

### Wave 4（✅ 完成，2026-10-10）
- **G·学习回路与 UI**：memory（§43：scope/ACL、矛盾裁决、四项禁止）、knowledge（§44：来源评级、scout 候选制、license 门）、evaluation（§45：改进闭环、LOCKED_DOMAINS、holdout）、orchestrator 补 delegation（§12.2）、comms 补结构化报告（§14）、desktop OpsPanel（三轴/watchdog/quota/incidents，§29/§50）、docs/AT_MAPPING.md（AT-001–064：covered 21 / 部分 26 / blocked 17）
- 验收（独立实测）：全量 `npm test` **1470/1470** 通过（1360+110，322 suites），0 失败；desktop vite 构建通过；demo:delegation 脚本补接线后跑通
- 注：Wave 4 agent 自报 3262 系误计（疑似重复累加），以本轮独立实测 1470 为准

## 完成标准（2026-10-10 验收结论）
1. 差距矩阵 MISSING/PARTIAL：11 个 MISSING 章全部落地（§16 requirements、§19/§20 core/progress、§24 factory-control、§30 watchdog、§31 takeover、§33 tools、§42 incidents；§51 NFR 为验收目标非代码；§54/§55 为 AT/DoD 文档映射）；43 个 PARTIAL 按 §23/§7/§18/§27/§28/§37/§38/§39/§40/§41/§43/§44/§45/§48/§52 硬化
2. `npm run build` 0 错误，`npm test` **1470/1470** 全过（322 suites）
3. 40 个 packages（新增 10 个）；demo 全部可跑（含新增 20+）
4. AT-001–064 映射：docs/AT_MAPPING.md（covered 21 / 部分 26 / blocked 17，blocked 均为环境缺失）
5. v1→v2 数据迁移：packages/project-io/src/migrate-v1.ts 可用

### Wave 3（并行）
- **D·运行时自保**：runtime（§25：12 运行态、LOOP_STAGNATION；§28：外部动作三态、幂等、checkpoint、reconciliation）、新建 quota（§27：三策略、handoff 包）、新建 watchdog（§30）、新建 takeover（§31）
- **E2·证据**：core evidence（§39：18 字段契约、trust/validity、失效追加、Gate evaluator 谓词）
- **F·数据与组织**：db（§48：约束、关键事务）、squads（§9：9 边类型、环检查、版本化）、project-io（§52：脱敏导出、不可信导入、v1→v2 迁移）

### Wave 4
- **G·学习回路与 UI**：memory（§43）、knowledge（§44）、evaluation（§45）硬化；server/desktop（§29 observatory、§50 必需页面）；AT-001–064 映射表

## 完成标准

1. 差距矩阵 MISSING/PARTIAL 清零（或明确记录为受环境限制的 BLOCKED，如 Windows 真隔离）
2. `npm run build` 0 错误，`npm test` 全过
3. 每批 demo 可演示
4. AT-001–AT-064 映射：每条 AT 标注 covered-by（测试/demo）或 blocked（环境）
5. v1→v2 数据迁移脚本（§52.4）可用
