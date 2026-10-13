# Batch 34 独立复核报告 (35-1)

**结论：Batch 34 的三项实质声明（34-2/34-3/34-4 三批工作）全部成立，未发现夸大或造假。零产品代码改动。**

## 方法

在 `/tmp/b35-wt` 干净 worktree（detached HEAD @ `8ae723e`，与主工作树隔离；node_modules 软链自主树）上亲跑构建与测试 + 逐条亲读代码。服务端 e2e 测试按 AGENTS.md 双模式约定，用临时 `FACTORY_SECRETS_DIR` 隔离运行，避免继承本地旧 vault。所有数字均来自干净基线。

## 真实验证数字（干净基线亲跑）

- 根 build：**0 TS 错误**
- (a) management_reports：`packages/db/dist/tests/management-reports.test.js` **14/14**（属于下面 36 的子集）
- (b) organization_relationships：`packages/db/dist/tests/organization-relationships.test.js` **7/7**
- (c) policy_versions：`packages/db/dist/tests/policy-versions.test.js` **11/11**
- (d) comms report-loadsnapshot：`packages/comms/dist/tests/report-loadsnapshot.test.js` **4/4**
- 包层合跑：**36/36**，0 fail（14 + 7 + 11 + 4）
- 服务端真 SIGKILL 重启 e2e：`reports-restart.test.ts` + `org-graph-restart.test.ts` + `policy-versions-restart.test.ts` 合跑 **3/3**，0 fail
- 服务端全套回归：**307/307**，0 fail（主线亲验数字一致）

## 逐项亲证

### (a) management_reports 落库（34-2）

- `saveReport` 确是纯 INSERT（insert-only）：重复 report_id 大声失败；in-memory 实现也忠实镜像 SQLite 的 UNIQUE 失败语义（错误信息甚至引用了 AGENTS.md 的"SQLite UNIQUE 报错写列名"教训）——亲读 `management-reports.ts:68-75` 成立。
- `updateReport` 是条件整行替换：`UPDATE … WHERE report_id = ? AND status = 'SUBMITTED_FOR_REVIEW'`，状态投影列与 report JSON 一条语句原子重写，不可能脱钩；行已裁决/缺席返回 false——亲读成立。
- 重启语义如实判定：`initReportsPersistence`（reports.ts:65-94）把落盘行原样水合**不降级**，只重建 `ReportLog.loadSnapshot` 的 per-task lastSequence 守卫；腐坏行 `REPORT_ROW_CORRUPT` 大声跳过、好行照读；读失败是 `REPORT_HYDRATE_FAILED` 诚实审计，不是静默。读回的代码注释明确写了与 delegations（ACTIVE→INTERRUPTED）、pipeline（RUNNING→INTERRUPTED）不同口径的原因——SUBMITTED_FOR_REVIEW 是待裁决记录不是执行态。
- 拷贝契约：所有读走 structuredClone/新鲜对象，无泄漏引用。

### (b) organization_relationships 落库（34-3）

- 落库的决策如实：§9 说边表权威，落盘时**必须带上 nodes**（organization_nodes/organization_relationships 两张表），否则无端点的边跨重启不可解析——亲读 `organization-relationships.ts` 头注释与 saveNode/saveEdge 的 upsert（`ON CONFLICT … DO UPDATE SET`）成立。
- 服务端 `/api/org/*`：每笔写先在**从落盘行重建的 scratch OrgGraphV2** 上跑 §9.2 校验（端点存在/不跨 org/无自边/单 primary/primary 无环），违规则 409 带 domain code（NODE_EXISTS / ENDPOINT_NOT_FOUND / MULTIPLE_PRIMARY_MANAGERS / CYCLE_DETECTED），DB 永不见被拒边——亲读 `org-graph.ts:318-340` 成立。写透失败 503 + `ORG_PERSIST_FAILED` 审计。
- 重启语义如实判定：valid_to = NULL 的边是**进行中的关系**，不是在途进程状态——原样水合不降级，与 delegations 口径不同，注释写明原因；corrupt identity_json 在 boot 与读取时 `ORG_NODE_CORRUPT` 大声跳过（一坏行不遮其余），`listNodeIds()` 永不解析 JSON 供容错降级——亲读成立。
- §9.4 版本快照历史仍在内存——只持久化 CURRENT 图，如实说明。

### (c) policy_versions 落库（34-4）

- `registerPolicyVersion` append-only：单 `BEGIN IMMEDIATE…COMMIT` 事务内取 max+1，`UNIQUE(policy_id, version)` 仲裁并发（有界重试 8 次，Batch 26 模式）；调用方永远不能指定版本号（RegisterPolicyVersionInput 无 version 字段）。
- **published 永不可改**：grep 全文件唯一一处 UPDATE 是注释里的 "no UPDATE ever touches a published version"——没有 update/delete API；"CURRENT 是派生状态"由纯函数 `statusOf` 计算，从不回写旧行。亲证成立。
- contentHash = sha256(精确字节)；腐坏行 `corrupt policy_versions row: …` 大声失败（Batch 31 口径）。
- 4 个 `policy_version` 字符串字段（approvals §23.3、escalations authPolicyVersion、projects §6.1、deployments policySnapshot）**确实未连线**：grep 确认除 schema.ts 建表语句与 db.ts 访问器外，无任何代码把这些字段引用到 policy_versions 表——"四个独立形状，标签不是文档"的声明如实，没有发明连线。
- 服务端 `POST /api/policy/versions`（operator）写 `POLICY_VERSION_REGISTERED` 进哈希链审计；GET 读 viewer，newest-first，派生 status；错形 400。

## 偏差：0 处

三批自报的边界（§9.4 快照历史仍在内存、4 字段不连线、valid_to=null 不降级、decided_by 只在审计链）全部在代码中如实出现，未发现夸大或实现虚构。
