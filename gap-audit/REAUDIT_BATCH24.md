# Batch 24 独立复核报告（Batch 25-1）

基线：`8f63096`。方法：先读源码取证，再亲手重跑关键测试 + 独立重算。延续 Batch 11/22-2/23-3/24-1 的独立复核传统。

## 总结论

**Batch 24 的实质声明全部成立，未发现夸大或造假。** 发现 1 处措辞偏差（见 §4），属文档口径问题，不影响功能实质。

## 1. 亲手重跑的真实数字

| 套件 | 结果 |
|---|---|
| `packages/db` builds 测试（3 条：双实现对拍、null 注记、老库迁移） | 3/3 ✅ |
| `packages/cicd` build-assemble 测试（5 条：缺失输入点名、lockfile 检测、toolchain 默认） | 5/5 ✅ |
| `apps/server/tests/build-runner.test.ts`（7 条：真 server + 真仓库 e2e） | 7/7 ✅ |

## 2. "五个诚实问题"的实现审计

| 问题 | 取证 | 结论 |
|---|---|---|
| 命令来源显式配置 | `buildRunnerConfigFromEnv()` 未设 `FACTORY_BUILD_COMMAND` 返回 null；`index.ts:249-251` 仅在配置存在时构造 `BuildRunner`；`routes/git.ts:559,654` 用 `ctx.buildRunner?.enqueue`（可选）——未配置时 merge 记录诚实保持 `NOT_EXECUTED` | ✅ 如报告 |
| 工作区钉住 revision | `GitRepo.worktreeAddDetached` = `git worktree add --detach <path> <revision>`，`rec.revision` 为 merge 的 candidate SHA 真值 | ✅ 如报告 |
| 与 /api/exec 相同策略 | `build-runner.ts` 从 `./routes/exec` 导入 `checkCommandPolicy`/`commandHitsControlDir`（与 /api/exec 同一模块、同一函数）；独立验证：`rm -rf /tmp/x` 被拒绝（deny pattern `\brm\b`），`npm run build` 放行 | ✅ 如报告 |
| 超时杀整个进程树 | `runCommandPipe` → `supervise()`：`detached: true` spawn，超时 `killTree(child,'SIGTERM')` → grace → `killTree(child,'SIGKILL')`，不是只杀直接子进程 | ✅ 如报告 |
| 工作区清理 | `runOne` 的 `finally` 块：`worktreeRemove --force` + `rmSync(..., force: true)`；清理失败审计 `BUILD_CLEANUP_FAILED` | ✅ 如报告 |

## 3. digest 真实性独立重算

按文档化算法（`sha256(JSON({revision, lockfileHash, toolchain, buildDefinitionHash, configHash, dependencySources(sorted)}))`）用 `node:crypto` 独立重算，与包内 `lockBuild()` 输出逐字一致（match: true）。`lockBuild` 为纯函数（`builtBy` 不影响 digest）；runner 只在 `assembled.definition !== null` 时调用，任一必填输入缺失 → digest 保持 null 并点名缺失项——代码与"绝不编造"口径一致。

## 4. 状态机单向性与老库迁移（亲手验证）

- `transition()`：缺失行抛错、非 `NOT_EXECUTED` 行抛错（"transitions are one-way"）；未知 status 的行大声抛错（与 merge-queue 的 QUEUED 回退语义不同，注释写明理由）。
- 老库迁移：手工构造 Batch-23 形状的 `builds` 表（无 `exit_code`/`failure_reason`/`completed_at`）→ `FactoryDatabase` 打开后三列原地补上（`migrateBuildsTable`，构造时调用）；旧行可读、新字段为 null；`markSucceeded` 可用；终端行二次改写被拒绝。

## 5. 发现的一处措辞偏差（minor）

报告与 KNOWN_LIMITATIONS 称："`taskId` 为 null 的合并跳过证据绑定（审计留痕）"。

实际代码（`apps/server/src/build-runner.ts:328`）：`if (digest && rec.taskId)` 包住整个绑定块——`taskId` 为 null（`routes/git.ts:543` 的 `pr.taskId || null` 确实可为 null）或 digest 为 null 时，**静默跳过，无任何 `BUILD_EVIDENCE_BIND_SKIPPED` 审计**。另两个跳过分支（无 merge 证据、绑定抛错）才有审计。

跳过行为本身正确（无 task 可绑是事实），偏差仅在"审计留痕"四字。建议主线二选一：(a) 补一行 `BUILD_EVIDENCE_BIND_SKIPPED` 审计使代码符合文档；(b) 把文档改为"静默跳过"。这是 3 行以内的改动，未在本复核中动手（复核批次保持审计-only）。

## 6. 残留边界（报告已如实声明，复核确认无遗漏）

构建执行仓库控制的代码**不是沙箱**（头注释明示，只对信任仓库启用）；SBOM/attestation 仍 null；多机/分布式构建未做（进程内 FIFO runner）；未配置命令 = 功能关闭。

## 交付物

本文件（未 commit，按任务要求）。复核中未改动任何产品代码。
