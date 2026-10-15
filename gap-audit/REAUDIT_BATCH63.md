# Batch 63 独立复核报告（REAUDIT_BATCH63）

- 复核对象：Batch 63 commit `8459647`（"Batch 63: Batch62 独立复核 / G9 INV-26 预发送 prompt 密钥扫描接入 / G8 INV-15 exec-confinement 拒绝钉住 / G6 INV-10 RunManifest 版本 pin"）
- 复核方式：隔离 worktree（detached HEAD `8459647`，路径 `~/reaudit-b63`；`node_modules` 自主树软链；各包 `dist` 自主树软链——主树 dist 在 Batch 63 收口时从逐字节一致的树构建，0 错误）；亲读 diff + 亲跑测试；主树零干扰；worktree 已删除。
- **结论：偏差 0 处。**

## (d) commit 文件清单 —— 成立

`git show --name-only 8459647` = **恰好 12 个文件**：

1. `CHANGELOG.md`
2. `apps/server/src/routes/runtime.ts`（G6）
3. `apps/server/tests/first-run-walkthrough-exec-confinement.test.ts`（G8，新建）
4. `apps/server/tests/runtime-manifests.test.ts`（G6）
5. `gap-audit/REAUDIT_BATCH62.md`
6. `packages/db/src/db.ts`（G6）
7. `packages/db/src/run-manifests.ts`（G6）
8. `packages/db/src/schema.ts`（G6）
9. `packages/db/tests/run-manifests-persistence.test.ts`（G6）
10. `packages/runtime/package.json`（G9，加依赖）
11. `packages/runtime/src/runner.ts`（G9）
12. `packages/runtime/tests/runner-secret-scan.test.ts`（G9，新建）

无意外文件。产品代码改动：G9 的 runner.ts + package.json 依赖、G6 的 4 个源码文件；其余为测试/文档。

## (a) G9 / INV-26 预发送 prompt 密钥扫描 —— 成立

逐行亲读 `git diff 0f27c30 8459647 -- packages/runtime/src/runner.ts`：

- `import { scanForSecrets } from '@ai-factory/memory'`（bare-specifier，dual-mode 合规）；
- ACT 阶段内：`const prompt = buildPrompt(agent, task)` 一次组装，随后 `try { scanForSecrets(prompt); } catch` ——位置在 `tracker.consumeModelCall()` **之前**、`adapter.invoke` **之前**（diff 上下文亲验）；
- 检出 → 返回 `{ ok: false, error: 'pre-send secret scan blocked the adapter invoke [adapter:secret-in-prompt] (§46.2/INV-26): ${message}', errorSignature: 'adapter:secret-in-prompt', note: 'prompt blocked: suspected raw secret detected' }`，adapter 未被调用；
- 失败路径不抛异常（返回 ok:false），由 loop 的 stagnation 逻辑接管——与"确定性重试清不掉签名 → LoopStagnation 升级"的声称一致。
- 错误文本是否回显密钥：`scanForSecrets`（`packages/memory/src/guards.ts:60`）抛出的 `MemoryError` 消息只含 pattern 名（`refusing to store suspected raw secret (pattern: ${name})`），不含密钥值——亲读确认。`runner.ts` 拼进 error 的 `${message}` 因此不带密钥值。成立。
- `package.json` 只加了 `@ai-factory/memory: 0.1.0`（memory 包零依赖，无循环依赖风险）。

测试（隔离 worktree 亲跑）：
- `packages/runtime/tests/runner-secret-scan.test.ts`：**2/2，0 fail**（密钥 prompt：adapter 调用 0 次、outcome escalated、reason 命中 /stagnat/、ACT 条目与 escalation reason 均不含密钥值；干净 prompt：adapter 正常调用、outcome completed）。
- runtime 包全套 176/176（174+2）是 63-2 报告人连续 3 轮亲跑的数字，我未重跑全包（scope 内注明；2 条新测试我亲跑通过）。

## (b) G8 / INV-15 exec-confinement 拒绝钉住 —— 成立

- `apps/server/tests/first-run-walkthrough-exec-confinement.test.ts` 在位（7902 bytes），文件头注释如实写了 honest boundary（钉住的是*拒绝*，不是真实 OS 级隔离；`UnverifiedBackend` 恒 `verified:false`）。
- 走查 A–C 逻辑亲读：A（agent actor + 合法命令 → 403 `CONFINEMENT_UNAVAILABLE` + `EXEC_DENIED` 审计 + 零 `EXEC_RUN`）、B（human → 200）、C（deny-pattern 命令仍先命中 confinement 检查）——与 routes/exec.ts 的"confinement 检查在命令策略检查之前"一致。
- 隔离 worktree 亲跑：**3/3，0 fail**。

## (c) G6 / INV-10 RunManifest 版本 pin —— 成立

逐文件亲读 `git diff 0f27c30 8459647`：

- `packages/db/src/run-manifests.ts`：新增 `RunManifestVersionPins`（employeeVersion/organizationVersion/policyVersion/requirementVersion，number|string|null；null = "未记录，绝不虚构"）+ `NULL_VERSION_PINS`；`RunManifest.versionPins` 字段；`rowToManifest` 读 `version_pins` 列，缺失/NULL 回退全 null（"从不回填虚构版本"）；`SqliteRunManifestStore` 的 INSERT/ON CONFLICT 含 `version_pins`。
- `packages/db/src/schema.ts`：`run_manifests` 新增 `version_pins TEXT`（可空；注释说明 legacy 行迁移）。
- `packages/db/src/db.ts`：新增 `migrateRunManifestsTable`（PRAGMA 检查缺列才 ALTER；表不存在时 SCHEMA 新建），在构造器迁移链中调用。
- `apps/server/src/routes/runtime.ts`：新增 `resolveRunVersionPins(ctx, agent, task)`（employee 取 agent.version 数字、org 取 `orgSnapshots.maxVersion()`（>0 否则 null）、policy 取 project.policy_version 非空字符串、requirement 取 task.requirementRef 非空字符串）；在 **两个**创建点调用：`handleRuntimeRoutes` 的 POST /runs 与 `createResumedRunManifest`（resume 建新 run 也 pin，口径"创建时快照"成立）。
- 测试：`runtime-manifests.test.ts` 新增 2 条（creation pin + null pins）；`run-manifests-persistence.test.ts` 新增 1 条（pre-pin DB 原地迁移，旧行读全 null）+ helper 更新。npm test +3（2517→2520）算术完全吻合。
- 隔离 worktree 亲跑：`runtime-manifests.test.ts` **9/9**，`run-manifests-persistence.test.js` **5/5**，0 fail。

## 真实验证数字（隔离 worktree @8459647）

- desktop tsc **0**；electron tsc **0**
- 服务端全套：**474/474，0 fail**（469 + 3 confinement + 2 G6 server；第一轮 335/139 失败是环境问题，见卫生注记 1）

## 卫生注记（非偏差）

1. worktree 首次跑服务端全套得 252 pass / 117 fail——worktree 里没有编译产物（dist 被 gitignore，commit 里没有）。修复：把主树各包 `dist` 软链进 worktree（主树 dist 在 Batch 63 收口时从逐字节一致的树构建，build 0 错误）。随后仍 139 fail——`/tmp`（512MB tmpfs）被之前失败轮次留下的 `factory-*-e2e-*` 临时 SQLite 目录塞满（100%），server 进程"exited early with code 1"（写不出 DB）。清理后重跑 **474/474 全绿**。两次都是环境侧问题，非产品代码问题。
2. 复核期间主树无其他兄弟任务在途写入；我全程未碰主树（只写本报告文件），未运行 `git stash`（铁律遵守：干净基线用隔离 worktree）。
3. runtime 包全套 176/176 引用 63-2 报告人的 3 轮亲跑数字；G6 的 db 迁移在 pre-pin 旧库上的行为由新增的迁移测试覆盖。
