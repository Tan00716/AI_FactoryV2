# Batch 35 独立复核报告（36-1）

**基线**：commit `7937dfc`（Batch 35）。干净 worktree（detached HEAD，node_modules 软链自主树）上亲跑构建与测试 + 逐条亲读代码 + 独立探针（直调编译后 dist，不用被复核方的测试逻辑）。复核后 worktree 已删除。

**结论：Batch 35 的三项实质声明（§8.2 任务范围、§9.4 org 快照、可售增量复验的报告诚实性）全部成立，未发现夸大或造假。零产品代码改动。**

## 真实验证数字（干净基线亲跑）

- 根 `npm run build`：**0 TS 错误**
- `packages/employee-factory/tests/task-scope-ceiling.test.ts`：**10/10**
- `packages/db/tests/org-version-snapshots.test.ts`：**10/10**
- `apps/server/tests/org-snapshots-restart.test.ts`：**2/2**（真 server + 真 SIGKILL 重启）
- `packages/employee-factory` 全套：**47/47**
- `packages/db` 全套：**239/239**
- 服务端全套：**309/309**（FACTORY_SECRETS_DIR 临时隔离）
- 独立探针 §8.2：**9/9**；独立探针 §9.4：**10/10**

## (a) §8.2 任务范围维度——成立

- 亲读 `enforcePolicy`：顺序为 §19 绝对 (1–4) → granter 集合 (5) → 任务范围 (6)，绝对先行，两个相对维度串行子集 = `requested ⊆ granter ∩ taskScope`（§8.2「有效权限取所有限制交集」）。
- 独立探针确认：缺席跳过（绝不编造）、空 scope 授零（grant-exceeds-task-scope）、`project:`/`path:` 等 domain tokens 不封口 capability、两维皆超时报 `grant-exceeds-granter`（granter 先行）、超 scope 时 reason 为 `grant-exceeds-task-scope` 且 `TASK_SCOPE_CEILING_DENIED` intent 在抛之前先写 sink（恰好 1 次，action 字段正确）、covered tool 通过。
- 边界如实：`taskScope` 与 `requestedBy` 同属请求声明值（workforce 路由既有信任模型，未改）；组织上限维度仍由 §19 绝对检查承载。

## (b) §9.4 org 快照历史——成立

- 亲读 `packages/db/src/org-version-snapshots.ts`：append-only（无 update/delete API，grep 确认），`graph_version` 在单 `BEGIN IMMEDIATE…COMMIT` 内取 max+1、`UNIQUE(graph_version)` 仲裁并发（Batch 26 模式，有界重试 10 次）。
- 独立探针确认：双连接交替 append → 1..8 连续单调无碰撞；close/reopen 后历史存活、续号 9；直接注入腐坏 `graph_json` → `get`/`list` 大声抛（不猜测）、`listSnapshotIds` 照常工作（永不解析 JSON）；快照携带该版本全图 JSON；深拷贝契约成立；非法 change 拒绝。
- GENESIS：`org-snapshots-restart.test.ts` 覆盖 pre-Batch-35 老库启动时写一行 GENESIS 快照记录真实当前状态（记录所见、不发明历史），2/2 通过。
- 边界如实：快照是终局记录，原样水合不降级。

## (c) 可售增量复验报告（SELLABLE_REVERIFY_BATCH35.md）——诚实性抽查成立

- **§81 needsHuman 无服务端发射点**：成立。`disputes.ts:22`、`escalations.ts:26-27`、`index.ts:500` 三处注释均已明确声明未覆盖；grep 确认 needsHuman 仅存在于 `packages/autonomy`，服务端无任何引用/发射。
- **CI scope**：成立。基线 `git ls-files .github/` 为空——`.github/workflows/ci.yml` 未跟踪、未推送，GitHub CI 确实从未运行。
- **A 真实模型回路仍 BLOCKED**：成立。`CodexAdapter` 真实对接 codex app-server（websocket/stdio），未登录时 app-server 的 turn 真实拒绝（库内无任何伪造 401——唯一的 "401" 字面量是 `failures.test.ts` 的分类断言）；`model-router.ts` 把未登录映射为 `authenticated:false` + 自标 STUB（INV-29 不伪装 live）。BLOCKED 口径成立。
- **27/32 章数**：成立，与 32-1 纠偏后的一致。

## 发现的偏差（1 处文档级）

`SELLABLE_REVERIFY_BATCH35.md` 第 34 行：「7 个新缺口全部记录→其中 **5 个**已被 Batch 32–34 关闭（AUTHORITY_CONFLICT、相对上限、项目字段/Clone/模板、知识 9 类、§48.2 落库）」——列出的 5 个名目实际覆盖了全部 7 个原缺口（「项目字段/Clone/模板」= 3 项），实际应为「**7 个已全部关闭**」，剩余的 `needsHuman` 是 34-4 新发现项、并非原 7 项之一。「5 个」是自列举口径的计数偏差，非实现虚构。建议顺手纠偏。
