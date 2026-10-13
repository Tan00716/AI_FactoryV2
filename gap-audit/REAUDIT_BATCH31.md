# Batch 31 独立复核（REAUDIT_BATCH31）

- 复核基线：`f4295d3`（Batch 31 已提交，主工作树干净——除未跟踪的 `.github/` 外）
- 复核日期：2026-10-13
- 方法：沿用 Batch 11/22-2/23-3/24-1/25-1/26-1/27-1/28-1/29-1/30-1/31-1 的独立复核传统——亲跑测试、亲读代码、独立脚本验证。零产品代码改动。

## 结论

**Batch 31 的三项实质声明全部成立，未发现夸大或造假。** 发现 3 处文档级偏差（计数错误、括号说明不准、措辞松散），均不涉及实现虚构——实现本身真实，报告写歪了。

---

## (a) Pipeline 落库：成立

### 亲跑验证数字
- `packages/db/dist/tests/pipelines.test.js`：**5/5**（注：必须按仓库约定跑编译后 dist；直接跑 src 的 `.test.ts` 会因 extensionless value import 报 ERR_MODULE_NOT_FOUND——这是 AGENTS.md 已记录的已知约定，不是实现问题）
- `apps/server/tests/pipeline-persistence.test.ts`：**5/5**（含真 SIGKILL e2e：pipeline killed mid-run → 水合为 INTERRUPTED；`/run` 对重建记录 409 `PIPELINE_NOT_REHYDRATABLE`；从未落盘的 pipeline 仍 404）
- `apps/server/tests/cicd-deployment-persistence.test.ts`：**4/4**（legacy deployment-stub 回归路径在）

### 代码亲读确认
- 写透原子性：`packages/db/src/pipelines.ts:166-225`，`BEGIN IMMEDIATE … COMMIT` 单事务写记录行 + 全删全插 stage 行，失败 `ROLLBACK`。node:sqlite 无 `.transaction()` 的说法成立——代码用的是显式事务。
- INTERRUPTED 降级：`apps/server/src/routes/cicd.ts:469/482`，RUNNING 的 pipeline/stage 在水合时降为 INTERRUPTED；`/run` 保持 409（cicd.ts:710）。
- 归档守卫重校验：水合前查 taskId 归档状态，重启期间被归档 → 409 `PIPELINE_REBUILD_REFUSED`（cicd.ts:458-462）。

### 独立脚本验证（不用他们的测试逻辑，自己写）
1. 写透跨重启：存 12 个 stage 的 RUNNING pipeline → close → 重开 → 记录 status/stage 数/stage 日志**全部完整**。通过。
2. 存储层不抢跑降级：重开后落盘行仍是 RUNNING（降级只发生在服务端水合层，存储层诚实）——与设计一致。
3. 腐坏行注入：直接 UPDATE 一行 `logs_json` 为非数组 → `get()` 抛 `corrupted pipeline_stages row for pipeline p1: logs/artifacts are not arrays`。**大声失败成立，不猜测。**

---

## (b) /api/builds 只读面：成立

- 亲跑 `apps/server/tests/builds-read.test.ts`：**4/4**，含真 server e2e（merge → 真实构建 → 纯 HTTP 轮询观察到 SUCCEEDED），无 build command 时 NOT_EXECUTED + 诚实 null + 过滤/分页。
- RBAC 接线亲读：`apps/server/src/auth.ts:420-425`，`GET /api/builds[/:id]` → viewer；非 GET 在路由层 405 拒绝（`routes/builds.ts:75-80`），"无可写面"成立。
- 序列化是 db store 给出的深拷贝原样输出，null 不编造、note 恒存在——头注释的声明与代码一致。

---

## (c) SPEC 59 章扫荡：7 个新缺口的 grep 证据全部成立；B 节纠偏抽查成立

### A 节（新缺口）grep 证据
| 缺口 | grep 结果 | 结论 |
|---|---|---|
| `AUTHORITY_CONFLICT` 符号 | 全库 0 处 | 成立，未做 |
| `ProjectKnowledge` 类型 | 全库 0 处 | 成立，未做 |
| `registerTemplate` 插件机制 | 全库 0 处 | 成立，未做 |
| Clone Repository 入口 | `packages/projects/src` 无 | 成立，未做 |
| management_reports / delegations / escalations / proposals / organization_relationships / policy_versions / gate_definitions / gate_evaluations 表 | `schema.ts` 0 处 | 成立，未做 |

### B 节（文档滞后纠偏）抽查
- INV-29：`packages/model-router/src/router.ts:141` `if (m.availability === 'offline') return false;`——成立。
- §5 通知脱敏 choke point：`packages/notifications/src/engine.ts:110-111`，title/body 确实都经 `redactSecrets`。成立。

---

## 发现的偏差（3 处，文档级）

### 1. 收敛结论的章节计数错误
扫荡报告正文表格**实际是已落地 27 章、部分 32 章**（59 行逐行数过，互斥且加总 = 59），但"收敛结论"写"已落地 26 章、部分 27 章"（26+27=53，与 59 对不上）。**正确口径：已落地 27、部分 32。**

### 2. §6.1 缺口的括号说明不准确
报告写 projects 表"只有 id/name/description/path/created_at/updated_at + data_classification"。实际 `schema.ts:8` 的 projects 表是 **id / name / description / path / status / archived_at / created_at / updated_at**——status/archived_at（Batch 14 归档）漏写了；`data_classification` 是 `memory_entries` 表的列（schema.ts:178），**不属于 projects**。缺口本身真实（organization_id、profile_version、repository_refs 等 10 个字段确实无处定义），只是"现状"描述写错了表。

### 3. "pipeline stage 落盘"措辞松散
扫荡 §40 行与收敛结论仍把"pipeline stage 落盘"列为剩余大项，但这与本批 headline 功能用词冲突：**stage 记录 + 定义确实落盘了**（KNOWN_LIMITATIONS 第 47 条写得精确）。真正不可落盘的是 stage handler 闭包（宿主闭包，设计使然）与执行恢复。建议后续措辞改为"stage 可执行恢复/可重跑"——否则读者会以为本批做的 pipeline_stages 表不存在。

---

## 最终口径

三项实质声明全部真实，文档边界真实，零夸大。3 处偏差均为报告措辞问题，已如实记录，建议 Batch 32 收口时顺手纠偏（尤其是计数 27/32）。
