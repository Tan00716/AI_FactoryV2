# Batch 75 独立复核（Batch 76-1）——偏差 0 处

基线：`848d71c`（Batch 75：Tan 产品决策 A A A 落地，F61/F28/F12 全部 closed）。
复核方式：隔离 worktree `@848d71c`（`~/aifactory-re75`，建在 $HOME，复核后删除），
worktree 内亲读 diff + 全量亲跑；共享主树只读（`git show`）+ 报告落盘，未改动任何跟踪文件。
全程未运行 `git stash`；未 commit；未碰 `.github/`；本报告未跟踪，留给收口人。

## (a) commit 文件清单 —— 成立

`git show 848d71c --name-only` = 恰好 **21 个文件**，无意外文件、无 `.github`：

1. `CHANGELOG.md`
2. `apps/desktop/src/components/Board.tsx`
3. `apps/server/src/index.ts`
4. `apps/server/src/routes/authority.ts`
5. `apps/server/src/routes/runtime.ts`
6. `apps/server/tests/authority-conflict-persistence.test.ts`（新）
7. `apps/server/tests/needs-human-irrecoverable-env-error-http.test.ts`（改）
8. `apps/server/tests/product-authority-default.test.ts`（改）
9. `apps/server/tests/v1-transition-authorization.test.ts`（新）
10. `docs/FIRST_RUN_WALKTHROUGH.md`
11. `docs/KNOWN_LIMITATIONS.md`
12. `docs/needs-human-triggers.md`
13. `packages/db/package.json`
14. `packages/db/src/authority-conflicts.ts`（新）
15. `packages/db/src/db.ts`
16. `packages/db/src/index.ts`
17. `packages/db/src/run-manifests.ts`
18. `packages/db/src/schema.ts`
19. `packages/db/tests/authority-conflicts.test.ts`（新）
20. `packages/policy/src/authority.ts`
21. `packages/policy/tests/authority-hydrate.test.ts`（新）

`--stat`：21 files changed, 2011 insertions(+), 59 deletions(-)。
全部 21 个文件都属于 Batch 75 的三个决策范围，无 scope 外文件。

注：任务 brief 里写"packages/db 的 5 个文件"，实际是 7 个
（package.json + src 5 个 + tests 1 个）；总数 21 无误，是 brief 枚举口径问题，
commit 本身无偏差。

## (b) 三个核心 diff —— 亲读成立

### ① F61：v1 POST /transition §17.2 门禁

- `apps/server/src/index.ts`：v1 transition handler 在 `to` 校验之后、引擎流转之前加门禁，
  `effectiveAuthorizationStatus(task) !== 'AUTHORIZED'` → 403
  `{code: 'TASK_NOT_AUTHORIZED'}`（G5 门形状复用）；注释明示无轴值历史行默认 AUTHORIZED、
  fail-closed（未知状态不通过）。门禁位置正确（先于 `engine.requestTransition`）。
- `apps/desktop/src/components/Board.tsx`：拖拽 catch 分支新增 `err.status === 403`
  专用 toast「⛔ 未授权（§17.2）…请先在 Dispatch 页签完成派发」，不再是通用"流转失败"。
- 与 commit message 声称一致。

### ② F28：S8 翻转点（envErrorSignal）

- `apps/server/src/routes/runtime.ts`：
  - `resolveEnvErrorSignal(body)`：fail-closed 校验（非法/非字符串码 → 400
    `INVALID_ENV_ERROR_SIGNAL`，校验在 run 记录创建之前）；
  - `makeEnvErrorSignalStepFn(code)`：每步抛对应 env FactoryError
   （`SandboxUnavailableError` / `MissingBinaryError`，消息明示"declared via the HTTP
    env-error signal — operator-injected, not a host probe"）；
  - POST `/api/runtime/runs` 路由：校验 → manifest driver 留痕（仅声明时）→
    `RUNTIME_ENV_ERROR_SIGNAL_USED` 审计 → `executeRuntimeRun({envErrorSignal})` 注入 stepFn；
    resume 路由确实未接受该参数。
  - `buildEnvErrorUpgradeRecord` 新增 `declaredViaSignal`：narrative 明确
    declared-not-observed，context 机读 `envErrorSignal` 字段。
- `packages/db/src/run-manifests.ts`：`RunManifestDriver` 新增可选
  `envErrorSignal?: string | null`，形状加法、无 signal 时 driver 形状不变。
- footgun 4 层防护在代码里都在位：route→role 表门禁、fail-closed 400、
  审计 + manifest 双留痕、narrative 限定。

### ③ F12：authority-conflict registry 持久化

- `packages/db/src/schema.ts`：`authority_directives` / `authority_conflicts` 两表，
  `CREATE TABLE IF NOT EXISTS`（老库自动建表，无列迁移需求）。
- `packages/db/src/authority-conflicts.ts`（新，245 行）：`AuthorityConflictStore`
  接口 + `InMemoryAuthorityConflictStore` + `SqliteAuthorityConflictStore`
 （upsert 写透语义），骨架实在非 stub。
- `packages/policy/src/authority.ts`：`AuthorityConflictRegistry.hydrate`
  —— boot-only（非空 registry 抛错）、静默（不调 onConflictOpened）、
  hydrate 前校验行合法性（坏行抛错不 normalize）、`id-N` 序号续接防碰撞。
- `apps/server/src/routes/authority.ts`：`initAuthorityRoutes(db, audit)` 签名变更；
  boot 时读表水合（成功审计 `AUTHORITY_CONFLICT_HYDRATED`，失败审计
  `AUTHORITY_CONFLICT_HYDRATE_FAILED` 并降级纯内存）；register/resolve 成功后写透
  （失败审计 `AUTHORITY_CONFLICT_PERSIST_FAILED`，永不回滚响应）。
- `apps/server/src/index.ts`：`initAuthorityRoutes(fdb, audit)` 调用更新 + F12 注释块。
- API 契约零变化（路由签名/响应形状未动）。

## (c) 声称抽点 —— 在位且内容实在

| 声称 | 亲验 |
|---|---|
| F61 新测试 4/4 | `v1-transition-authorization.test.ts` 顶层 `test(` 恰 4 个 ✓ |
| F28 新测试 7/7 | `needs-human-irrecoverable-env-error-http.test.ts` 顶层 `test(` 恰 7 个 ✓ |
| F12 policy hydrate 6/6 | `authority-hydrate.test.ts` 顶层 `test(` 恰 6 个 ✓ |
| F12 db 16/16 | `authority-conflicts.test.ts`：6 it × 2（memory/sqlite）+ 4 sqlite 专项 = 16 ✓ |
| F12 server 三次 boot + 两次 SIGKILL 1/1 | `authority-conflict-persistence.test.ts` 1 个 `it`，spawn 3 次 boot、2 次 `kill('SIGKILL')` ✓ |
| F61/F28/F12 → closed (B75) | walkthrough findings 表三行均为 closed (B75)，F12/F28/F61 小节标题同步更新 ✓ |
| S8 走查表翻转说明 | §81 full-trigger sweep 表格 + S8 行：Batch 50 负向对照 → Batch 75 阳性 ✓ |
| needs-human-triggers.md | 追加 Batch 75 F28 段落（envErrorSignal + 防护 4 层 + 负向对照仍成立）✓ |
| KNOWN_LIMITATIONS §17.2 | 追加 Batch 75 UX 变化说明（403 + 专用 toast）✓ |

## (d) 隔离 worktree 亲跑 —— 全量

环境：`~/aifactory-re75`（`git worktree add ~/aifactory-re75 848d71c`），
`node_modules` 软链主树（只读），server 套件经 `npm run test:server`（TMPDIR wrapper），
`FACTORY_SECRETS_DIR` 指向临时目录（hermeticity 铁律）。

| 项 | 结果 |
|---|---|
| `npm run build` | **exit code 0，0 错误**（真实 exit code，未用 `\| tail` 口径） |
| `npm test` | **2589 pass / 0 fail**（2591 tests，2 skipped；ℹ tests 2105+486，skipped 2+0）——与 commit 声称完全一致 |
| `npm run test:server` | 第一轮 **499 pass / 1 fail**（ℹ tests 500）；唯一失败是旧文件 `build-orphan-reconcile.test.ts` 的 SIGKILL 时序用例（Batch 75 未动该文件）；**该文件单独重跑 7/7**，Batch 75 的 4 个新测试文件全部通过（v1-transition 4/4、env-error-http 7/7、authority-conflict-persistence 1/1、product-authority 1/1） |
| `npx tsc -p apps/desktop/tsconfig.json` | **exit 0** |
| `npx tsc -p apps/desktop/tsconfig.electron.json` | **exit 0** |
| `npm run smoke:boot` | **OK**（compiled server booted, GET /api/health → 200） |

499/1 说明（非偏差）：失败用例「reaps the orphaned worktree on the next boot」
断言审计日志含 `BUILD_ORPHAN_CLEANED`，是 SIGKILL mid-build 的时序敏感 e2e
（失败时用例耗时 20.3s），在全套件高负载下偶发抖动；单独重跑 7/7 全过，
且 Batch 75 的 21 个文件未触及该路径。按偏差定义"偶发抖动如实记录但不算偏差"，
此处记为抖动，不计偏差。

## (e) 结论

**偏差 0 处。** commit 文件清单、三个核心 diff、测试计数、文档 closed 标记、
亲跑数字，全部与 Batch 75 声称一致。

## 卫生注记（非偏差）

1. 复核期间共享主树出现兄弟 Batch 76 在途产物（`?? gap-audit/SELLABLE_REVERIFY_BATCH75.md`）
   ——复核人**未碰**；本复核全部在隔离 worktree 完成，主树零写入（除本报告）。
2. `.github/workflows/ci.yml` 仍未跟踪，复核未触及。
3. `/tmp` 卫生：复核全程走 TMPDIR wrapper；`~/.aif-test-tmp-*` 残留 **0**；
   `/tmp/factory-*` 计数 460（Batch 73 报告时的 464 是当时基线，本轮未做前后对比，
   但 wrapper 的 rm -rf 在 exit 路径已亲读确认，复核引入零新增）。
4. worktree `~/aifactory-re75` 及两个临时 `FACTORY_SECRETS_DIR` 已在报告完成后删除，
   主树 `git status` 仅剩既定未跟踪项（`.github/`、本报告、兄弟的 SELLABLE 报告）。
