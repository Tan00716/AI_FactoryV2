# Merge Queue 多机共识：诚实范围界定（设计文档）

> 状态：设计文档，非实现。基线 `cc528e8`（Batch 45）。
> 结论前置：**多机 merge queue 今天不存在，且不存在便宜的实现路径。**
> 整个持久层是单文件 SQLite（`node:sqlite`），多机是系统级拓扑决策，
> 不是"给队列换个锁"能解决的。本文档界定失效模式、对比方案、给出推荐路线。

## 1. 现状（亲读代码确认）

- 队列本体：`packages/git/src/mergeQueue.ts` 的 `MergeQueue`，per-repo 常驻进程内存
  （server 端 `apps/server/src/routes/git.ts` 的 `mergeQueues` Map 缓存），
  靠 `packages/db/src/merge-queue.ts` 的 SQLite 表落库 + `hydrate()` 重建。
- 跨进程互斥（Batch 23/26/38）：三层纵深——
  1. `merge_queue_drain_locks` 表的 repo 级 drain 租约（`SqliteMergeQueueDrainLock`）：
     原子 INSERT 抢锁、条件 UPDATE（`heartbeat_at = ?`）CAS 接管、心跳、2 分钟默认 TTL、
     接管审计 `MERGE_LOCK_STALE_RECLAIMED`；
  2. per-entry `tryClaim`（单条 UPDATE … WHERE 原子认领）；
  3. `(repo_path, position)` 唯一索引仲裁 enqueue 位置碰撞。
- 触发模型：**drain 是同步的**——`POST /api/git/merge-queue` 处理器内
  `enqueue()` 之后直接 `await queue.processAll(...)`（`routes/git.ts:618`）。
  任何能 serve 该端点的进程都会 drain。
- 锁的装配点：`packages/db/src/db.ts:1220`，`new SqliteMergeQueueDrainLock(this.db)`——
  锁与数据是**同一个 SQLite 文件**。

## 2. 多机部署下锁如何失效（脑裂场景）

### 场景 A：两机各用各的 DB 文件（最常见的多实例部署）

- 每台机器有自己的 `merge_queue_drain_locks` 表 → 两边 `acquireDrain` 都返回
  `'acquired'` → 两边同时 drain 同一 repo。
- §36 核心不变量被打破：条目本应"严格串行、每个都对已含之前所有合并的
  tip 验证"，现在两边对**不同的本地 tip** 各自验证、各自合并。
- `tryClaim` 也是按库的 → 同一条目两边都认领成功 → **同一 PR 被合并两次**
 （或一成功一 FAILED，状态互相覆盖）。
- `(repo_path, position)` 唯一索引按库 → 两边算出相同 position → 队列顺序错乱。
- 审计链分叉：两机的 `MERGE_QUEUE_DRAIN_CONTESTED`/`TAKEOVER` 审计互相不可见，
  "谁死了"从任一单机都答不上来。
- **更深一层**：git 仓库本身在本地磁盘。两机 drain 的"同一 repo"是两个
  工作拷贝——即使锁没问题，合并结果也是两个分叉的仓库。这是锁解决不了的。

### 场景 B：两机共享一个 SQLite 文件（NFS/SMB）

- SQLite 的文件锁在 NFS 上不可靠（POSIX 锁可能不被强制执行）——
  SQLite 官方文档明确警告不要这样用。
- 本库用的还是 rollback journal（非 WAL）：锁语义本就弱于 WAL；
  "原子 INSERT / CAS UPDATE 互斥"的前提（SQLite 串行化写者）在 NFS 上不成立
  → 脑裂：两边都认为自己拿到了租约。
- 结论：共享文件不是"把 DB 放 NFS 就行"，是**已知不可行**。

### 场景 C：时钟偏移

- 租约 TTL 比较用的是**各机本地时钟**（`acquireDrain(repo, holderId, nowMs, ttlMs)`，
  `nowMs` 由调用方时钟提供）。
- 时钟偏快的机器会过早判定对端心跳过期 → 抢走一个**活着**的 holder 的锁 →
  两个 drainer 同时写（verifier 内失锁中止 `MERGE_QUEUE_DRAIN_LOST` 是事后止损，
  不是预防）。
- 反之，时钟偏慢的机器永远抢不到锁 → drain 停滞。

## 3. 可选方案对比

| 方案 | 做法 | 优点 | 代价/取舍 | 前置条件 |
|---|---|---|---|---|
| A. 单写者（single-writer） | 只有一台机器 drain；其余实例只 enqueue（`processAll` 跳过，返回"已入队待处理"语义） | 零新 infra；drain 逻辑一行不动；条目落库了所以 drainer 可随时换 | API 契约变更（现在 enqueue 是同步 201-landed/409-failed）；drainer 是 SPOF（可运维切换）；**仍需共享状态**——各机 DB 文件不通时，非 drainer 的入队 drainer 看不见 | 需要共享 DB（见 C）或把入队请求路由到 drainer；需要 `FACTORY_MERGE_DRAIN=0/1` 这类 env 开关（产品 API 设计） |
| B. 外部锁服务（Redis Redlock / etcd / Consul） | drain 租约搬到分布式锁 | 真正的分布式互斥；Redlock/etcd 都是成熟方案 | **锁只是三分之一**：队列状态（entries/positions/PRs/审计）仍在各机 SQLite 里，锁住了 drain 也解决不了状态分叉；新增运维依赖（Redis 高可用本身）；Redlock 正确性有公开争议，etcd 更稳但更重 | 必须先有共享状态（C），否则锁是摆设 |
| C. 共享数据库服务器（Postgres） | 队列相关表迁到 Postgres；租约改用 advisory lock 或 `SELECT … FOR UPDATE` | 一次解决状态共享 + 锁：advisory lock 是 PG 原生的分布式互斥；事务保证 claim/position 原子性 | **工作量巨大**：整个 `packages/db` 是 `node:sqlite`，无远程 DB 驱动（KNOWN_LIMITATIONS 已列为硬阻塞"远程 DB 驱动"）；迁移影响所有 store，不只是 merge queue；git 仓库本身仍是本地磁盘（需另解：共享存储或"仓库跟 drainer 走"） | 远程 DB 驱动 + 全量数据迁移方案 + 运维（PG 高可用/备份） |
| D. 请求路由（sticky routing） | LB 按 repo 把 merge-queue 请求粘到固定实例；状态仍各机本地 | 不动存储层；无新 infra（若已有 LB） | 跨实例查询/列表端点语义破裂；故障转移要 owner 重选 + 状态搬运（DB 文件拷走——停机窗口）；脑裂窗口依然存在（重选期间） | LB 支持 + owner 注册表 + 故障转移流程（运维手册，不是代码能全包的） |

### 关键判断（诚实结论）

1. **B（只换锁）是伪方案**：分布式锁解决的是"谁先写"，但多机的根本问题是
   "写到哪"——状态都不共享，锁住 drain 毫无意义。任何把 B 单独拎出来做的
   PR 都是"定义冒充实现"。
2. **C 是真解，但它是"换数据库"，不是"改队列"**：前置条件（远程 DB 驱动）
   本身就是一条硬阻塞，工作量按"迁移整个持久层"估，不按"改三行锁代码"估。
3. **A 是唯一"今天能动手"的**，但它只解决"drain 互斥"，不解决"状态共享"——
   它的价值是**把单写者语义做成显式的、可运维的**，而不是假装多机可用。
4. **git 仓库本地性是独立的一维**：即使 DB 共享了，两机各有一个工作拷贝，
   merge 还是分叉。"多机 merge queue"完整成立需要：共享 DB + 单 drainer（或
   分布式锁）+ 共享/归属明确的 git 存储。三者缺一即脑裂。

## 4. 推荐路线与最小里程碑

> 原则：先诚实声明不支持，再做小而真的改进，不为"看起来多机"造伪方案。

- **M0（本批，已做）**：文档界定。`KNOWN_LIMITATIONS.md` 的 merge queue 条目
  口径收紧为"同一 DB 文件的多进程；多机（多 DB 文件 / 共享文件 / 时钟偏移）
  均未覆盖，见本文档"。部署建议：merge queue 只跑单实例。
- **M1（已落地，Batch 47）**：单写者开关。`FACTORY_MERGE_DRAIN=0` 时
  `POST /api/git/merge-queue` 只 enqueue 不 `processAll`，返回 202 +
  `drainPending: true`，条目保持 QUEUED，审计记 `MERGE_QUEUE_ENQUEUED`
 （`drainPending: true`，`reason: 'FACTORY_MERGE_DRAIN=0'`）。开关在请求时
  按请求读 env（无重启即可切换）。默认（未设）行为逐行未动——老测试全绿。
  价值：为"API 实例若干 + drainer 一台"的拓扑铺路；今天单实例部署下
  行为零变更。
- **部署建议（API 实例 + drainer 一台拓扑）**：
  - API 实例：`FACTORY_MERGE_DRAIN=0`——只接受 enqueue，永远不 drain。
    多个 API 实例可以同时存在（enqueue 的原子 INSERT/CAS 本身按 DB 排斥，
    但注意**同一 DB 文件**仍是前提——见 §2 场景 A）。
  - drainer 实例：默认 env（不设该变量）——唯一的 drain 执行者。
    **必须只跑一台 drainer**：drain 触发器本身就是"能 serve 该端点的进程都
    会 drain"，两台 drainer 就是场景 A 的脑裂。
  - **诚实声明**：在 M2（共享状态）落定前，这个拓扑只能解决 drain 互斥，
    不能解决状态共享——多机部署仍是不支持的，任何相反的宣传都是虚假的。
- **M2（大，真正的门）**：共享状态决策。Postgres 迁移的 RFC（含全量表清单、
  迁移策略、回滚方案）或明确"不支持多机"的产品决策。这是唯一能让 M1 产生
  实际多机价值的前置。**在 M2 落定前，任何多机 merge queue 的宣传都是虚假的。**
- **M3（M2 之后）**：租约实现切换。Postgres 落定后，`SqliteMergeQueueDrainLock`
  换成 PG advisory lock 实现（`MergeQueueDrainLock` 接口已抽象好，替换的是
  实现不是调用方——Batch 23 的接口设计在这里是对的）。
- **明确不做**：NFS 共享 SQLite 文件（已知不可行）；只上 Redis 锁不动状态
  （伪方案）；基于本地时钟的租约跨机复用（场景 C 已证伪）。

## 5. 与现有测试/审计的对应关系

- 已覆盖（单机多进程）：双真进程竞速 `merge-queue-drain.test.js`、
  SIGKILL 崩溃恢复（`MERGE_LOCK_STALE_RECLAIMED`，Batch 38）。
- 未覆盖（多机）：以上全部。不要把单机多进程的测试报告读成多机可用——
  这是本文档存在的理由。
