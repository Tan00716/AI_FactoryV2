# AI Factory — 测试执行报告（执行层）

执行时间：2026-10-10 Asia/Kuala_Lumpur
执行人：测试执行子代理（按 TEST_PLAN_V2.md 精神 + 父代理执行层任务书）

## 1. 干净构建 — PASS
- 动作：删除全部 `dist/` 目录后 `npm run build`
- Exit code：0
- TypeScript 错误：0（`error TS` 计数 = 0）
- 唯一告警：vite chunk-size > 500kB（monaco bundle，已知、文档中有记录）
- 原始输出：[build.log](sandbox://workspace/ai-factory/test-evidence/build.log)

## 2. 全量单元测试 — PASS
- 动作：`npm test`（先逐包 tsc build，再 `node --test`）
- tests: 993 / pass: 993 / fail: 0 / skipped: 0 / cancelled: 0 / todo: 0 / suites: 197
- Exit code：0
- 注：grep 到 1 处 "not ok" 字样，经核查是测试用例名称本身（含 "counts ok / not ok lines" 字样），非失败。
- 原始输出：[test.log](sandbox://workspace/ai-factory/test-evidence/test.log)

## 3. Demo 脚本 — 23/23 PASS（全部 exit=0）
| # | 脚本 | 结果 | 关键行为（摘自日志） |
|---|------|------|---------------------|
| 1 | demo | PASS | 证据链 TODO→DONE；门禁缺 security_report 时拒绝并点名 |
| 2 | demo:qa | PASS | 失败→PRODUCT_FAILURE 分类→指派 coder→修复→3/3 通过 |
| 3 | demo:cicd | PASS | PROD 部署卡在 HUMAN_APPROVAL；失败部署自动回滚 |
| 4 | demo:skills | PASS | 高风险 skill 安装被拦截 |
| 5 | demo:memory | PASS | 去重/过期/置信度衰减/验证 |
| 6 | demo:runtime | PASS | Loop 状态机/预算/断点续跑 |
| 7 | demo:orchestrator | PASS | 任务自动分解 |
| 8 | demo:factory | PASS | 动态招聘+治理（违规创建被拒） |
| 9 | demo:mcp | PASS | 未知来源 BLOCK→审批→安装→门禁 |
| 10 | demo:knowledge | PASS | 知识生命周期流转 |
| 11 | demo:evaluation | PASS | 指标→画像→Lesson |
| 12 | demo:comms | PASS | 结构化通信原语 |
| 13 | demo:artifacts | PASS | 19 种产物类型 |
| 14 | demo:projects | PASS | 项目发现/创建 |
| 15 | demo:review | PASS | 10 维代码审查 |
| 16 | demo:release | PASS | Release 流程 |
| 17 | demo:policy | PASS | 7 层策略合并 |
| 18 | demo:security | PASS | 恶意 skill 被 BLOCK（0/100）；目录逃逸被拦 |
| 19 | demo:recovery | PASS | 部署前快照→失败→自动还原 |
| 20 | demo:resources | PASS | token 超预算→拒绝+升级 |
| 21 | demo:autonomy | PASS | full 模式缺证据照样被拦 |
| 22 | demo:coordination | PASS | 同文件冲突→串行化+合并门禁 |
| 23 | demo:dispute | PASS | Coder PASS vs Reviewer FAIL→独立裁决 |

原始输出：test-evidence/demo-*.log（23 个文件）+ demo-summary.txt

## 4. 范围说明（诚实项）
- TEST_PLAN_V2.md 描述的 275 条领域用例 + 64 条 AT 场景（docs/testing/v2/）**在本仓库不存在**，计划本身也写明"测试设计完成；产品测试尚未执行"。本轮执行的是仓库内可执行层：干净构建 + 993 单元测试 + 23 个 demo。
- 未执行：真实 Electron 启动、真实模型接入、真实 MCP 服务、Windows 打包、性能/压力/故障注入（均属 TEST_PLAN_V2 的 ENV-L/P 范畴，本环境不具备）。
- 无 FAIL、无 BLOCKED：所有能跑的项全部通过。
