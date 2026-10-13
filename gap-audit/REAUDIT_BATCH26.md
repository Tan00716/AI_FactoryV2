# Batch 26 独立复核（REAUDIT_BATCH26.md）

- 复核人：独立审计子代理（与 Batch 26 实现者不同）
- 基线：`7fb7696`（远端 main 已复验），工作树干净
- 方式：亲手重跑六个新增测试文件 + 独立编写的双连接复现脚本（`/tmp/reaudit26-collision.mjs`）+ 代码语义抽查
- 结论：**实质声明全部成立，未发现夸大或造假**

## (a) SBOM 保留策略：成立

亲跑：`retention-sbom.test.ts` 3/3、`sbom-retention.test.ts` 8/8。

代码抽查（`apps/server/src/routes/retention.ts`）逐条对上：

- 无策略 → `note: 'keep forever (no retention policy)'`，0 候选（第 176–186 行）——"永久保留"真实。
- `deleteOrphans` 必须 boolean 且仅 sboms 可用（第 523–532 行）——参数校验真实。
- 孤儿默认保留：`deleteOrphans === false` 时孤儿走 `orphanNames` 只进报告不进候选（第 350 行 `if (deleteOrphans && !anyHold)`）——"默认保留"真实。
- 任一 active hold → 全部豁免（第 294 行注释 + 339 行 `if (anyHold) { held++; continue; }`）——"legal hold 全豁免"真实。
- 关联先验：候选集合先从 live builds 表重建 `sbomRef→文件` 映射（第 298–304 行），文件名不匹配 `SBOM_FILE_RE`（`packages/cicd/src/sbom.ts:52` 的紧正则）或含 `..` 的一律跳过（第 316、703 行）——"不盲删"真实。
- 双轴取并集（第 337 行 `expiredByDays || overCount`）——与 backups 同口径的说法真实。
- enforce 需确认文本、写 `RETENTION_ENFORCED`（第 698–715 行）——与报告一致。

## (b) MCP launch 记录持久化：成立

亲跑：`mcp-launches.test.ts` 3/3、`mcp-launch-records.test.ts` 1/1（真 SIGKILL e2e）。

e2e 测试（`apps/server/tests/mcp-launch-records.test.ts`）亲读确认：

- 真 SIGKILL → 重开：live 表为空（不伪装管理）、sleeper → `ORPHANED` 且 `orphanNote` 含 "fate is unknown"、STOPPED/EXITED 原样保留。
- 哨兵值 `launch-rec-sentinel-value-must-never-reach-disk`：重启前行级扫描（第 175 行）与重启后（第 208 行）均断言**值不在**，ref 名在 ——"secret 值永不落盘"真实。
- 重启后新 launch 得新行，ORPHANED 终态不复活（第 212 行起）。

水合顺序正确：`hydrateMcpLaunches` 在 sink 挂载前跑（`mcp-persistence.ts` 第 319 行起注释明示），避免重放中途回写。

注：Batch 26-2 报告中提到该测试曾有偶发失败（`/usr/bin/node` vs `node` 路径解析断言）——那是其运行时的兄弟批次在途文件，26-3 已修复；本次复核两次亲跑（合并树 + 本次）均为通过，主线 259/259 全绿。

## (c) enqueue position 并发碰撞：成立

亲跑：`packages/db` `merge-queue-position.test.ts` 3/3、`packages/git` `merge-queue-position.test.ts` 3/3。

独立复现（双 `FactoryDatabase` 连接 = 双进程，脚本独立于 batch 测试文件）：

1. 原子仲裁存在：裸 SQL 对 `(repo_path, position)` 插重复 → `UNIQUE constraint failed: merge_queue_entries.repo_path, merge_queue_entries.position`，**被拒**。
   - 顺带验证：错误文本确实是被违反的*列名*（不是索引名），与 Batch 26-4 报告的 AGENTS.md 经验一致；`persist()` 的正则 `/\.repo_path,\s*[a-z_.]*\.position/i` 对该真实消息能命中（本轮复现即走了这条路径，见下）。
2. 双队列竞速：qA 抢到 position 1，qB 的过期计数器也想拿 position 1 → 触发 `PositionCollisionError` → 重读 `maxPosition` → position 2，审计 `GIT_MERGE_QUEUE_POSITION_RETRY:attempt1@pos2`，DB 里两行 `position 1/2`，**无丢失、顺序确定**。

`ENQUEUE_POSITION_RETRIES = 8` 与报告一致；"最多 8 次后大声失败"已在 `enqueue()` 循环中实现。

## 文档/口径检查

- `docs/KNOWN_LIMITATIONS.md`：三条替换（SBOM 保留已关闭 / enqueue position 碰撞已关闭 / launch 记录已落库）均已落地，各自边界说明与实现一致（只覆盖同一 DB 文件；SBOM 路径跨机判孤儿默认保留；多进程新 boot 会把其他进程的 RUNNING 标 ORPHANED）。
- `CHANGELOG.md`：Batch 26 条目与测试基线数字一致。
- `.github/workflows/ci.yml` 仍为本地未跟踪文件（push 阻塞说明与实际一致）。

## 诚实边界（与 Batch 26 报告一致，无新增）

- SBOM 构建刚写完、markSucceeded 未落盘的窗口内文件判为孤儿（默认保留，opt-in 需避开构建高峰）——文档已写明。
- 多进程共享 DB 时新 boot 会把可能还活着的他进程 RUNNING 标 ORPHANED（liveness 只在 owning 进程权威）——文档已写明。
- 重试 8 次耗尽理论上可能但实践中不可达，耗尽时大声抛错——代码与文档一致。

## 真实验证数字（本次亲跑）

- 包侧四个测试文件：**12/12**（db: retention-sbom 3、mcp-launches 3、merge-queue-position 3；git: merge-queue-position 3）
- 服务端两个测试文件：**9/9**（sbom-retention 8、mcp-launch-records 1）
- 独立双连接复现脚本：仲裁生效 YES、positions 1/2 有序、重试审计 1 次、DB 无丢失

**结论：Batch 26 的三项实质声明全部成立；报告中的边界说明真实，没有发现夸大、捏造或"测了个本来就对的东西"。**
