# Batch 33 独立复核报告 (33-1)

**结论：Batch 33 的六项实质声明（33-2/33-3/33-4 三批工作）全部成立，未发现夸大或造假。零产品代码改动。**

## 方法

在 `~/workspace/b34-wt` 干净 worktree（detached HEAD @ `008bdde`，与主工作树隔离；node_modules 软链自 `~/workspace/ai-factory/node_modules`）上亲跑构建与测试 + 逐条亲读代码。主工作树当时有 Batch 34 在途改动，所有数字均来自干净基线。worktree 已删除。

## 真实验证数字（干净基线亲跑）

- 根 build：**0 TS 错误**
- (a) 项目记录字段：`packages/db/tests/project-record-fields.test.ts` **5/5**（属于下面 25 的子集）
- (b) 项目知识 + escalations/proposals：`packages/db/dist/tests/` 三个文件合跑 **25/25**（project-record-fields 5 + project-knowledge 6 + escalations-proposals 14），0 fail
- (c) 模板注册：`packages/projects/dist/tests/templates-registry.test.js` **8/8**，0 fail
- (d) 服务端 e2e：`project-records-clone.test.ts` + `project-templates-knowledge.test.ts` + `escalations-proposals-restart.test.ts`（真 SIGKILL）合跑 **12/12**（3 suites），0 fail
- 总计新断言：45（db/包层）+ 12（服务端）= **57/57**，0 fail

## 逐项亲证

### (a) §6.1 项目记录 13 字段（33-2）
- `migrateProjectsTable`（`packages/db/src/db.ts`）：老库按列名逐列 `ALTER TABLE … ADD COLUMN`；`§6.1` 列全 **TEXT nullable、无 default**，注释明写"升级绝不编造组织/政策版本/生命周期状态"——亲读成立。
- `rowToProject`：refs 列 JSON 解析失败大声抛 `corrupted projects row: column … is not valid JSON`，从不猜测——亲读成立（db.ts:753-770）。
- `GET /api/projects/:id` 返回完整记录；错形字段 400；缺席 → null/[]。

### (b) Clone Repository 入口（33-2）
- `POST /api/projects/clone` 经 `execFileSync('git', …)` **真 clone**（argv 形式，不走 shell）；来源以 `-` 开头被拒；只接受 http/https/file/本地路径；branch 做纯分支名校验；失败 502 `CLONE_FAILED` 且不写记录；非空目录 409 `PROJECT_DIR_NOT_EMPTY`（§6.3）。
- e2e 用本地 fixture git 仓库真 clone + 真 SIGKILL 重启后字段不丢（12/12 含此断言）。

### (c) 模板扩展注册（33-3）
- 5 内置模板钉死：`register` 覆盖内置→`TEMPLATE_EXISTS`；`unregister` 对内置名→`TEMPLATE_BUILTIN` 拒绝——亲读成立（templates.ts:585-605）。
- 注册校验：slug 格式、路径拒绝 `..`/绝对路径/反斜杠、文件数与总字节上限；模板是纯数据（name→files），注册不执行任何代码。
- 注册即落库 `project_templates` 表；启动时重载，坏行 `TEMPLATE_RELOAD_SKIPPED` 大声审计并跳过。e2e 验证"注册→经 `/api/projects/create` 真实脚手架→注销"链。

### (d) §6.4 项目知识 9 类（33-3）
- 9 类：product-requirements、architecture、tech-stack、coding-test-security-standards、deployment-rules、known-bugs、constraints、decisions、lessons。计数口径在头注释如实交代（SPEC 原文 8 行："Coding/Test/Security Standards" 一行合并，"Known Bugs/Constraints" 拆为 bugs/constraints 两类——bug 是观测故障，constraint 是长期限制）。没有伪装 9 是规格原文。
- upsert 按 `(project_id, category, title)` 原地更新（entryId/createdAt 稳定，updatedAt 前移）；非法 category → store 层 `ProjectKnowledgeCategoryError`、HTTP 层 400 `UNKNOWN_KNOWLEDGE_CATEGORY`（routes/projects.ts:440/480）；content 是索引摘要，sourcePath/sourceVersion/sourceHash 引用来源——亲读成立。
- 33-3 自报的真 bug（upsert 返回实际 entryId）已修并在 e2e 中钉住。

### (e) escalations + proposals 落库（33-4）
- `escalations.ts`/`proposals.ts`：无任何 `UPDATE`/`DELETE FROM` 语句——append-only / insert-only 成立（grep 确认）。
- escalation 每次 ESCALATED 裁决写透；写透失败审计 `ESCALATION_PERSIST_FAILED` 不回滚响应（升级已经发生）；`GET /api/disputes/escalations` 合并 live coordinator + 落盘行（按 id 去重，live 优先）。
- proposal 每次 POST `/api/workforce/proposals` 决策写透；读面 `/api/workforce/proposals[/:id]`。
- 两者都是终局记录——无在途状态可降级，重启后原样水合（init 时只读加载，坏行 `ESCALATION_ROW_CORRUPT` 审计不遮掩）。
- 与 AUTHORITY_CONFLICT 的交集如实：Batch 32 的 AuthorityConflictRegistry 同级冲突升级要求人工，但**不**实例化 §81 `EscalationRecord`、**不**走 dispute 裁决路径——三者（§81 needsHuman、dispute escalation、authority conflict）是三个独立形状，本批没发明连线。§81 `needsHuman` 无服务端发射点、无存储，如实未覆盖（CHANGELOG/报告均明确）。

## 偏差（0 处）

本批无发现文档级偏差。33-2 自报的两处测试 bug（误 import dist、占位符 auth 字面值）已修，干净基线全绿证实。

## 33-3 worker 中断说明

33-3 原 worker 在交付前 runtime 中断（未送达报告），但在途文件完整落盘；33-3 的收尾验证由新 agent 亲跑亲读完成，结论"在途实现全部成立、无需修复"，本复核在其基础上独立复核——以上数字均为本复核人在干净基线亲自重跑，非引用其报告。
