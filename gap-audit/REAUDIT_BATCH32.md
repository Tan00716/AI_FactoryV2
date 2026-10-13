# Batch 32 独立复核（Batch 33-1）

- 基线：`c030265`（Batch 32 提交）
- 方法：在 `~/workspace/b331-wt` 干净 worktree（detached HEAD @ c030265，与主工作树隔离）上亲跑构建与测试 + 逐条亲读代码。零产品代码改动。
- 构建：`npm run build` **0 TS 错误**（干净 worktree 全量构建）。
- 服务端全套：**292/292**（干净基线亲跑，与 Batch 32 收口数字一致）。
- 注意：复核中途兄弟 Batch 33 子任务开始在主工作树写在途文件，主树 `npm run build` 一度出现大量 TS5055（`packages/db/tests/escalations-proposals.test.ts` 从 tests 直引 `../dist/src/index.js`，与 db 包 tsconfig 的 declaration emit 冲突）——这是 Batch 33 在途问题，**不是** Batch 32 基线的缺陷；干净基线构建 0 错误已证。主线收口时兄弟批次需修。

## 结论

**Batch 32 的三项实质声明全部成立，未发现夸大或造假。** 32-2 的 SPEC 引用逐字准确；32-3 的相对上限接线与审计如实；32-4 的落库语义与重启降级如实。发现 1 处行号小漂移（文档级）与 1 处主树并发干扰观察（见末节）。

## (a) AUTHORITY_CONFLICT 仲裁（32-2）

### SPEC 对齐

- SPEC_V2.md 第 252 行（§8.1）原文："Authority Engine 先检查指令者是否有权，Policy Engine 执行明确 deny / scope / hard limit，Scheduler 才解决多个合法工作请求的次序。Security Authority 的有效 BLOCK 不能被普通 Manager ALLOW 抵消。两个同等有效且不兼容的指令，进入 `AUTHORITY_CONFLICT`，暂停相关动作并升级；不会采用"最后一条命令"。"——`packages/policy/src/authority.ts` 头注释逐字引用，准确。
- INV-31（第 100 行）："多人指令冲突由 Authority / Policy / Scheduler 解析，不按最后发言获胜。"——引用准确。
- 实现如实声明"只做了 Authority 层；Policy/Scheduler 仍是各自引擎"，不冒充。

### 代码亲读

- `AuthorityConflictRegistry`：`directives`/`conflicts` 均为进程内 `Map`，无任何 sqlite/DB 引用——"registry 是内存的，重启丢失未决冲突的暂停状态"的边界声明成立。
- 不兼容对：BLOCK↔ALLOW、BLOCK↔RESUME、CANCEL↔{ALLOW,RESUME,PAUSE}、PAUSE↔RESUME、PAUSE↔ALLOW；其余兼容，无冲突不触发。`incompatible()` 对相同 effect 直接返回 false。
- 等级不同 → `higher-authority-wins` 自动裁决，败方记 `OVERRIDDEN` 不删记录；同级不兼容 → `AUTHORITY_CONFLICT`（OPEN），`isPaused()` 门控；升级裁决要求 decider rank 严格大于双方最大 rank（`resolveConflict` 第 366–376 行逻辑），平级/低级拒绝。
- 服务端 `apps/server/src/routes/authority.ts`：registry 为模块级单例（第 32 行），审计事件经 `pendingAudit` 缓冲、`flushAudit` 逐 handler 刷入 server audit log（`ctx.audit.record('system', …)`）。路由：`POST /api/authority/directives`、`GET /api/authority/conflicts[/:id]`、`POST /api/authority/conflicts/:id/resolve`、`GET /api/authority/targets/:kind/:id`。
- RBAC：`auth.ts` 无 `/api/authority` 专属分支，走默认约定——GET viewer、写 operator（`requiredRoleFor` 末行）。与仓库既有约定一致，非偏差。

### 测试亲跑（干净基线，亲跑）

- `packages/policy/tests/authority.test.ts`：**15/15**（无冲突永不触发 4、自动裁决 3、同级暂停+升级 5、输入校验 3）
- `apps/server/tests/authority-conflict.test.ts`：**6/6**（双 principal 冲突→暂停+审计、targets 面报 paused、spec 显式用例自动裁决、owner 裁决后暂停解除+审计、列表/详情、非法 level 400）
- 回归：`packages/policy` 全套 **76/76**
- 独立探针（不用他们的测试逻辑，直调编译后 `dist`）：兼容指令/同人更新/不同目标 → 0 冲突、不暂停；Security Authority BLOCK vs Manager ALLOW → `RESOLVED`/`auto_rule`/`higher-authority-wins`、不暂停；同级 ALLOW/BLOCK → `OPEN`+暂停；平级裁决被拒（false）、owner 裁决通过（true）且暂停解除。全部符合声明。

- `authority-conflict.test.ts` 头注释诚实声明"Exercises the real route handler (no server boot)"——是路由 handler 级测试，不是整 server e2e；`../src/routes/authority.ts` 用 `.ts` 后缀直引，符合双模式约定。

## (b) §5 相对权限上限（32-3）

### 代码亲读

- `packages/employee-factory/src/governance.ts` `enforcePolicy`：绝对检查（步骤 1–4：顺序、工具/权限白名单、预算）全部在前、口径不变；第 5 步相对检查：`request.granterAgentId` 命中注册表 agent 时，请求的 tools/permissions 必须是 granter 自身集合的子集。
- 越级时先经注入 sink 写 `RELATIVE_CEILING_DENIED` intent（actor=granter，details 含 exceededTools/exceededPermissions），再抛 `grant-exceeds-granter`——与 approvals 的 `EXCEPTION_GRANT_DENIED` 同模式。
- `registry.get()` 抛错（granter 不在注册表，如 human）→ 跳过相对检查，绝对检查仍全量生效——"绝不编造上限"成立。
- 服务端 `apps/server/src/routes/workforce.ts` 第 119–125 行：`POST /api/workforce/employees` 注入审计 sink，把 `RELATIVE_CEILING_DENIED` 写入哈希链审计。

### 测试亲跑（干净基线，亲跑）

- `packages/employee-factory/tests/relative-ceiling.test.ts`：**9/9**（越级工具/权限被拒+审计 intent、平级/降级通过、未知 granter 跳过但绝对检查仍生效、无 granter 旧行为、绝对先行口径、createEmployee 两路接线）
- 回归：`packages/employee-factory` 全套 **37/37**（含既有 governance/factory 零回归）
- 另亲读确认：`RELATIVE_CEILING_DENIED` 的审计 sink 在 `workforce.ts` 第 119–125 行注入，`createEmployee` 的 `requestedBy`→`granterAgentId` 映射在 `factory.ts`，两路接线与测试断言一致。

## (c) gates/delegations 落库（32-4）

### 代码亲读

- DB 层 `packages/db/src/gates.ts` / `delegations.ts`：`gate_definitions`（upsert）、`gate_evaluations`（append-only，newest-first）、`delegations`（全量 JSON + 投影列）；`PersistedDelegationStatus` 在 orchestrator 四态之外加 `INTERRUPTED`（记录层词汇）；`markInterrupted` 只降 ACTIVE 行且不碰 version。
- 服务端 `apps/server/src/delegation-service.ts`：每次 mutation 先经 manager 校验再写透；启动 `initDelegationService` 把 ACTIVE 行写回降为 INTERRUPTED 并逐条审计 `DELEGATION_INTERRUPTED_ON_RESTART`；`list` 时 INTERRUPTED 行 `continue` 跳过（第 130 行），永不进 live manager。
- 启动接线：`apps/server/src/index.ts` 第 485 行 `initDelegationRoutes(fdb, audit)` → `routes/delegations.ts` 第 47 行 `initDelegationService({ fdb, audit })`——链路完整。
- `/api/gates` 的 `POST …/evaluate`：body 带 `verdict` 直接 400（`routes/gates.ts` 第 168–171 行，INV-04），评估记录标 `evidence_source: 'caller-supplied'`。

### 测试亲跑（干净基线，亲跑）

- `packages/db/tests/governance.test.ts`：**7/7**（双实现对拍：upsert 语义、评估 newest-first、INTERRUPTED 仅降 ACTIVE、深拷贝、跨 reopen）
- `packages/orchestrator` delegation：**20/20**（含 loadSnapshot 2 条）；orchestrator 全套 **110/110**
- `packages/db` 全套：**172/172**
- `apps/server/tests/delegations-restart.test.ts`：**1/1**（真 SIGKILL：boot A 建委托 DRAFT→ACTIVE→子委托→COMPLETE→根 COMPLETE、留 DRAFT、留 ACTIVE；SIGKILL 后 boot B：DRAFT 可行动、COMPLETED 原样、ACTIVE→INTERRUPTED 带 "fate UNKNOWN" 注记、INTERRUPTED 上 complete 得 409、定义/评估可读、伪造 verdict 被 400、`/api/audit` 含 `DELEGATION_CREATED`/`DELEGATION_INTERRUPTED_ON_RESTART`/`GATE_EVALUATED`）

- `delegations-restart.test.ts` 用 `FACTORY_SECRETS_BACKEND: 'memory'` 并删除 `FACTORY_SECRETS_DIR`——不继承本地 vault，hermetic。

## 发现的偏差

1. **行号小漂移（文档级）**：32-2 报告写 SPEC_V2 §8.1 在"第 250 行"，实际是第 252 行。引用内容逐字准确，仅行号差 2。
2. **主树并发干扰（过程观察，非 Batch 32 缺陷）**：复核中途兄弟 Batch 33 子任务在主工作树写入在途文件（`packages/db/tests/escalations-proposals.test.ts` 等），主树 `npm run build` 随即出现大量 TS5055（tests 从 `tests/` 直引 `../dist/src/index.js`，与 db 包 tsconfig 的 declaration emit 冲突——server 包能这么做是其 tsconfig 另有安排，db 包是新踩的坑）。干净基线 worktree 构建 0 错误，证实与 Batch 32 无关。主线收口时兄弟批次需自行修复，复核人未碰。
3. **复核环境插曲**：最初在 `/tmp/reaudit32` 建的隔离 worktree 在复核中途被外部删除（/tmp 的 ephemeral 性 + 兄弟 worktree 活动），已迁移到 `~/workspace/b331-wt` 重做全部验证；上方所有数字均来自后者。

## 附：诚实边界再确认（与 Batch 32 声明一致）

- AUTHORITY_CONFLICT registry 纯内存：重启丢失未决冲突的暂停状态（代码亲证：两个 `Map`，无 DB 引用）。
- 相对上限：granter 不在注册表时跳过（不编造上限）；`requestedBy` 来自请求 body 声明值；§8.2"任务范围"维度未并入。
- Delegations：INTERRUPTED 终态不复活；多进程共享 DB 时后启动进程也会降级他进程的 ACTIVE 行（liveness 只在 owning 进程权威）；`/api/gates` 的 evaluate 证据来自调用方 body，provenance 明确标注 `caller-supplied`。
