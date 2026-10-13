# Batch 23 独立复核报告（REAUDIT_BATCH23）

复核人：独立复核子代理（Batch 24-1）
复核基线：commit `8d7c55f`（Batch 23 提交，已推送）
复核日期：2026-10-13
传统：沿袭 Batch 11 / 22-2 / 23-3 的独立复核——先独立取证、亲手重跑关键断言，再下结论。

## 总结论

Batch 23 的三项实质声明（builds 表、drain 租约互斥、entry claim 纵深）**全部成立**，未发现夸大或造假。
23-2 与 23-4 在同一文件（`packages/git/src/mergeQueue.ts`、`packages/db/src/merge-queue.ts`）
的并行收敛**无重复实现、无冲突导出**——接口定义唯一，`packages/git/src/index.ts` 一次性 re-export，
全仓构建 0 TS 错误即证明。

## (a) builds 表 —— 成立

取证（亲读代码，非转述报告）：

1. **双实现对拍**：`packages/db/src/builds.ts` 有 `MemoryBuildRecordStore` 与
   `SqliteBuildRecordStore`，同一 `BuildRecordStore` 接口；测试
   `packages/db/tests/builds.test.ts` 用同一脚本序列跑双实现（字段逐字 round-trip、
   null 注记逐字一致、copy 契约、空 revision 大声拒绝）。亲跑：3/3 通过。
2. **老库迁移**：`schema.ts:663` `CREATE TABLE IF NOT EXISTS builds`（+ `idx_builds_pr` /
   `idx_builds_revision`）；测试 `'rows survive a reopen on a database that predates
   the builds table'` 用只有 projects 表的老库文件验证自动建表 + 跨 reopen 可见。成立。
3. **merge 落记录**：`apps/server/src/routes/git.ts` 两条合并路径（直接合并 ~L540、
   队列 `onMerged` ~L632）各调 `buildRecordInputForMerge()` 后 `ctx.fdb.builds.record()`；
   candidateSha 缺失 → `BUILD_RECORD_SKIPPED` 审计，**不**回退用 targetSha 冒充 revision
   （helper 的注释把"fabrication-adjacent"写明了）。亲跑服务端 e2e
   `apps/server/tests/build-records.test.ts`：3/3（真 server dist + 真 git 仓库 + 两次
   HTTP 合并后杀进程，直开 DB 文件断言 revision 等于真实 candidate SHA）。
4. **null 注记逐字**：`NO_BUILD_DIGEST_NOTE` / `NO_BUILD_DEFINITION_NOTE` 为导出常量，
   db 测试与 server 测试均 `assert.equal(..., NO_BUILD_DIGEST_NOTE)` 逐字钉住。成立。
5. **未知状态大声拒绝**：`rowToRecord` 遇非 `NOT_EXECUTED` 抛错（注释写明与 merge-queue
   的 QUEUED 回退语义不同：build 行是纯历史、无可安全回退的语义）。测试覆盖。成立。

诚实边界确认：`status` 恒为 `'NOT_EXECUTED'`（合并从不执行真实构建），digest/definition/
SBOM/attestation 全 null + 原因注记——报告没有伪装成"构建已执行"。`artifactDigest`
在 merge 证据里仍是 null + `'no artifact'`（Batch 22-3 口径不变）。**无夸大。**

## (b) drain 租约 —— 成立

取证（亲读代码 + 亲跑测试）：

1. **原子性真实**：`SqliteMergeQueueDrainLock.acquireDrain` 用 `INSERT` 抢锁
   （PK 冲突者失败）、takeover 用单条 `UPDATE … WHERE heartbeat_at = ?` 做 CAS
   （两 contender 恰其一 `changes === 1`）。`tryClaim` 同样是单条原子
   `UPDATE … WHERE status='QUEUED' AND (claimed_by IS NULL OR … OR claimed_at < ?)`。
   不是"先读后写"。成立。
2. **争用大声让路**：`processOne` 拿租约 → `contested` 则审计
   `MERGE_QUEUE_DRAIN_CONTESTED`（带 repo、holderId、liveHolderId）后 `return null`，
   不碰队列。测试 `'a contested drain yields loudly'` 断言 entry 保持 QUEUED。成立。
3. **心跳与失锁中止**：`heartbeat()` 在 processOne 的 4 个进展点调用
   （acquire 后、takeover 后、claim 后、verifier 返回后）；verifier 返回后
   `stillDrainOwner()` 先心跳再重读锁行，失锁则审计 `MERGE_QUEUE_DRAIN_LOST` 并中止合并
   （不双写）、丢弃过期内存。成立。
4. **接管诚实**：takeover 后 `refreshFromPersistence()` 先对齐 DB 真相再
   `demoteAbandoned()`——测试 `'stale lock takeover demotes abandoned rows but never
   resurrects terminal ones'` 覆盖。hydrate 在活租约下推迟降级并审计
   `MERGE_QUEUE_REHYDRATED_DEFERRED`。成立。
5. **双真进程**：`'two real processes draining concurrently process every entry
   exactly once'`（真 git 仓库、双进程、120s 超时）在复核中**两次独立运行均 4/4 通过**
   （加上报称的 3 遍，共 5 次稳定）。修前行为（4 MERGED / 2 entries）无法在已修复的树上
   复现，但机制（原子 INSERT/CAS + 让路审计）经代码取证成立，且测试覆盖了争用路径。
6. **server 零改动生效**：`FactoryDatabase` 构造函数默认给
   `SqliteMergeQueueEntryStore` 接入 `SqliteMergeQueueDrainLock`（db.ts:888-893）。
   成立。

亲跑数字：db drain-lock 5/5、db claim 5/5、git drain 4/4（含双进程）、git claim 4/4、
server build-records 3/3。

## (c) 23-2 × 23-4 收敛 —— 无冲突

- `MergeQueueDrainLock` / `DrainAcquireResult` / `MergeQueueDrainLockState` /
  `DEFAULT_CLAIM_TTL_MS` / `DEFAULT_DRAIN_LOCK_TTL_MS` 在 `mergeQueue.ts` 中各**只定义一次**，
  `packages/git/src/index.ts` 一次性 re-export（L38-43）。无重复实现。
- 语义分层自洽：drain 租约保 repo 级串行（§36"逐条验证、每条基于已含之前所有合并的
  tip"不变量），`tryClaim` 为 entry 级纵深（无 drainLock 的旧 backing 仍受保护；
  有租约时 claimNextQueued 跳过被占 entry 的逻辑不与租约冲突——租约已保证单 drainer）。
- 构建验证：`npm run build` 0 TS 错误（复核基线构建产物）。

## 残留边界（报告已如实声明，复核确认无隐瞒）

1. 只覆盖**同一 DB 文件**的多进程，不覆盖多机（KNOWN_LIMITATIONS 已写）。
2. 心跳 TTL 默认 2 分钟（`drainLockTtlMs` 可配）；entry claim TTL 默认 5 分钟，需大于最长
   verifier 运行时间——配置责任在运维侧，文档已写。
3. 两进程同时 enqueue 的 position 可能碰撞（无唯一约束）：顺序不保证、任务不丢。
4. builds 表是"记录"不是"构建"：真正闭环（真实构建执行 → 状态流转 → digest 回填 →
   与证据绑定）仍是未来工作，Batch 23 的 commit message 与 KNOWN_LIMITATIONS 均已如实说明。

## 复核方法注记

本次复核亲读了 `packages/db/src/builds.ts`（全）、`mergeQueue.ts` 的 drain 相关段落
（L129-340 接口/选项、L513-870 processOne/heartbeat/stillDrainOwner/claimNextQueued）、
`packages/db/src/merge-queue.ts` 的 `SqliteMergeQueueDrainLock` 与 `tryClaim`、
`apps/server/src/routes/git.ts` 的 `buildRecordInputForMerge` 与两处接线、
`packages/db/src/db.ts` 的 FactoryDatabase 接线；亲跑了 db builds/drain-lock/claim、
git drain/claim、server build-records 共 21 条新增测试（13+8，全部通过）及双进程测试
的重复运行。未发现报告与代码不符之处。
