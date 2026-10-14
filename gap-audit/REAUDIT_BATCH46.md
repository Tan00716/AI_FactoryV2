# Batch 46 独立复核（Batch 47-1）

- 基线：`b0046e2`
- 复核方式：隔离 worktree（detached HEAD `b0046e2`，建于 `~/workspace/tmp-reaudit-b46`，node_modules 软链主树；`/tmp` tmpfs 只剩 ~7M 故未用 `/tmp`），亲读代码 + 亲跑测试，主树零干扰。worktree 已删。
- 零产品代码改动（复核人只读不写）。

## 结论

**Batch 46 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

## (a) F21 修复：GET /api/audit 钉死裸数组契约——成立

- diff 亲读：`apps/server/src/index.ts` 改动仅为路由处的一段正式契约注释（"returns a BARE JSON ARRAY, newest first… Never an envelope… any future shape change is a breaking API change"），**零行为变更**。
- 新建 `apps/server/tests/audit-list-contract.test.ts`（130 行）：纯 HTTP、零 mock，启动真实 built server（`../dist/index.js`，临时 DB + 临时 `FACTORY_SECRETS_DIR`，hermeticity 合规；dual-mode 合规，只用 node builtins + fetch）。三条契约：裸数组（Array.isArray tripwire）/ 新在前（3 条 PROJECT_CREATED 逆序）/ `limit=2` 恰好 2 条。亲跑 **1/1**，0 fail。
- "~27 个消费方"亲验：`grep -rln "api/audit" apps/server/tests` 得 28 个文件，其中 1 个是本批新增契约测试，27 个现有消费方——与注释口径一致。
- desktop 无调用：`grep -rn "api/audit" apps/desktop/src` 为空。
- 同级 `/api/evidence`（index.ts:1578）确为裸数组，库内自洽口径成立。

## (b) 走查第七版（first-run-walkthrough-b46.test.ts + demo:e2e-v7）——成立

- 测试全文亲读（411 行）：N1（granter 3 次空 taskScope → 403 → 1 条 OPEN policy-violation → `GET /api/needs-human` 断言 `detailJson.narrative` 含 "The policy held on every attempt"）、K1（真实项目树 + `.ai/` → `POST /api/projects` 带 path → `POST /api/backup` → scope 断言 `'factory-database+project-files'`、manifest 含 `src/index.ts` 与 `.ai/config.yaml` → 篡改备份拷贝 → `POST /api/restore/project-files` 422 且校验前后 `GET /api/projects` 深相等）、E1(a)（进程内真实编译 `@ai-factory/runtime`、默认 stepFn、零自定义：MissingBinaryError 3 次 → escalated + LOOP_STAGNATION + `ENV_BINARY_MISSING`；普通 Error 3 次 → 签名仍 `tool:boom2:fail`）、E1(b)（unknown-tool 3 连 → ESCALATED → 该 run 恰好 1 条 repeated-failure、0 条 irrecoverable-env-error）。**零 mock**（E1(a) 也是真实包），与 Batch 46 声明一致。
- `demo:e2e-v7` 链亲读 `package.json`：镜像 v6 链（mcp/tools/db/worktrees/employee-factory/runtime/cicd/security/secrets/requirements/server）+ b46 测试。隔离 worktree 亲跑：**1/1**，0 fail，exit 0（构建链含 11 个包重编译）。
- F22（backup collector 信任 project.path——Low 真实产品缺口）与 F23（走查构建链卫生——Info）已在 `docs/FIRST_RUN_WALKTHROUGH.md` Batch 46 一节（行 382/396）如实记录，与 Batch 46 声明一致。
- **Doc nit（非偏差）**：走查测试头注释写 "the HTTP positive path still does not exist — see F22"，但 F22 是备份 path 缺口（env-error 边界在文档 E1(b) 行与 Batch 44/45 边界声明，非编号 finding）——注释的交叉引用写错了编号。纯注释问题，建议顺手修正。

## (c) merge queue 多机界定文档（docs/merge-queue-multimachine.md）——成立，有代码证据

- drain 同步触发：`apps/server/src/routes/git.ts` 的 `POST /api/git/merge-queue` 处理器内 `enqueue()` 后直接 `await queue.processAll(...)`（行 ~610–618），任何能 serve 的进程都会 drain——文档引用准确。
- 锁与数据同一 SQLite 文件：`packages/db/src/db.ts:1220` `new SqliteMergeQueueDrainLock(this.db)`；server 的 `MergeQueue`（`packages/git`）经 `this.persistence?.drainLock`（mergeQueue.ts:425）取锁，persistence 即 `ctx.fdb.mergeQueueEntries`——锁表与队列数据确在同一 DB 文件。脑裂场景 A（两 DB 文件 → 双 drain）的逻辑前提成立。
- 时钟偏移：`MergeQueue` 的 clock 为 `opts.clock ?? Date`（mergeQueue.ts:344），server 未注入 clock → 本地机器时钟；租约 TTL 比较确用各机本地时钟（:428）。场景 C 证据在位。
- "只换锁是伪方案"（状态分叉才是根本）与"真解是共享 DB（Postgres），前置远程 DB 驱动本身是硬阻塞"：与代码现状一致（`packages/db` 只有 `node:sqlite`，无远程驱动——亲验目录无 pg/mysql 驱动依赖）。
- §5 的 `MERGE_LOCK_STALE_RECLAIMED`：真实审计事件（`packages/git/src/mergeQueue.ts:757`），Batch 38 SIGKILL 崩溃恢复测试在位——文档引用无误。
- KNOWN_LIMITATIONS.md：三处 merge queue 条目（行 34/48/73）已收紧，均指向该设计文档并明确"只覆盖同一 DB 文件的多进程、不覆盖多机"。diff 亲读确认。

## 真实验证数字（隔离 worktree @b0046e2，亲跑）

- 构建：**0 TS 错误**
- audit-list-contract.test.ts：**1/1**
- demo:e2e-v7（完整构建链 + 走查）：**1/1**

## 偏差：0 处。附 1 个 doc nit（走查头注释 "see F22" 引用编号错误）。
