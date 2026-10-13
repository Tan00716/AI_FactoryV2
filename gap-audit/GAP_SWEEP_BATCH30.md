# Batch 30 缺口收敛扫荡（GAP_SWEEP_BATCH30）

- 基线：`7d99787`（Batch 29）
- 扫荡日期：2026-10-13
- 方法：按"真实使用影响"排序重读 `gap-audit/` 与 `docs/KNOWN_LIMITATIONS.md`，逐项核对是否已在 Batch 24–29 的独立复核中关闭；排除 Tan 专属项（Codex 登录、Windows 真机、许可证/证书/定价/签名密钥）。
- 本次改动：**零产品代码改动**——全部为文档纠偏 + 独立复验（亲跑测试），均在基线 `7d99787` 上完成。

## 结论

本次扫荡的三个头号候选**全部已在早先批次真实关闭**——发现的问题是文档过时（在说"还没做"的文档，其功能早已落地并被测试钉住），不是功能缺口。已逐个亲跑测试验证并修正 `docs/KNOWN_LIMITATIONS.md`：

1. **账号状态真实接线** —— 已关闭（Batch 3 接线，Batch 30 亲跑复验 `model-router-account.test.ts` 7/7）
2. **§40→§36 构建↔证据绑定** —— 已关闭（Batch 23 builds 表 / Batch 24 真实构建 / Batch 25 SBOM；Batch 30 亲跑复验 `build-runner.test.ts` 9/9）
3. **Merge Queue 跨进程 drain 并发** —— 已关闭（Batch 23 租约 / Batch 26 enqueue position；Batch 30 亲跑复验 `merge-queue-drain.test.js` 4/4，含双真进程竞速）

另：Linux 安装包分发（Batch 25）在当前树上重新跑 `npm run dist:linux` 复验（见下）。

## ① 账号状态真实接线（profile live account status）

### 审计发现

`docs/KNOWN_LIMITATIONS.md` 曾写：

> 账号状态（profile）默认仍是 stub……但 server 侧把真实账号状态接进 API 路由的工作由另一组进行中，尚未完成——接线完成前，API/UI 看到的账号状态仍可能是 stub。

**这句话已经过时**。`git log` 显示接线在 Batch 3 就落地了（commit `6b55110`："live Codex account status in router account route"）：

- `apps/server/src/routes/model-router.ts` 的 `GET /api/router/account` 先问真实提供方（Codex app-server 经 CodexAdapter，5s 超时保证响应），失败才回退 stub；
- 真实结果经 `getAccountStatus({ live, liveSource: 'LIVE via codex-app-server' })` 注入，`usageNote` 明确标注来源（INV-29：永不伪装 live 数据）；
- 三条行为路径（命中/不可达/抛错）全有测试钉住，绝不把 stub 伪装成 live。

### 亲跑验证（基线 `7d99787`）

`node --test apps/server/tests/model-router-account.test.ts` → **7/7 全绿**。

### 诚实边界（保留）

live 查询需要 `codex login`（待 Tan 本人执行，明确排除项）——未登录时返回明确标注 STUB 的 stub 形状。接线已闭环，缺的是登录本身。

### 文档动作

`docs/KNOWN_LIMITATIONS.md` 条目改写为"账号状态真实接线已关闭（Batch 3，Batch 30 独立复验）"，保留上述诚实边界。零代码改动。

## ② §40→§36 构建↔证据绑定（builds 表 + 真实构建 + digest 回填）

### 审计发现

文档中 Batch 22-3 的审计结论段仍在断言：

> 产品中不存在真实可绑定的构建产物……无 builds 表；合并从不触发构建……`artifactDigest` 保持 null + `'no artifact'` 是当前唯一诚实状态。

这个前提在 Batch 23/24/25 已被逐个推翻：

- **Batch 23**：`builds` 表落地——每次 merge 落一行记录，`status='NOT_EXECUTED'` 起步，digest/定义/SBOM 缺失时为 null 并附真实原因（`sbomNote` 老库迁移回填）；
- **Batch 24**：真实构建执行闭环——显式配置 `FACTORY_BUILD_COMMAND` 后，merge 在钉住 candidate revision 的 detached worktree 中真实执行构建（后台 FIFO 串行，不阻塞 merge 响应；10 分钟超时杀进程树；成功失败均删工作区）；digest 为真实输入重算（revision/lockfile/toolchain/命令哈希/配置哈希，缺项点名不编造）；成功时回填 merge 证据的 `artifactDigest`（移除 `'no artifact'` 注记）；失败/超时/策略拒绝记 FAILED；未配置时功能关闭、记录保持 `NOT_EXECUTED`；
- **Batch 25**：构建 SBOM——成功构建从 worktree lockfile 派生 CycloneDX 1.5 精简 SBOM 落盘（声明/解析依赖清单，provenance 写死在文档里）。

### 亲跑验证（基线 `7d99787`）

- `node --test apps/server/tests/build-runner.test.ts` → **9/9 全绿**（真实构建 e2e：成功 digest 与独立 `lockBuild` 重算一致、失败/超时/策略拒绝、SBOM 生成）；
- `git-merge-evidence-36.test.ts`（§36 五字段 + artifactDigest 绑定）在全套中全绿。

### 诚实边界（保留）

- 构建会执行仓库控制的代码，**不是沙箱**——只应对信任仓库启用（文档化的运维决策）；
- `attestationRef` 仍 null（签名密钥待 Tan 决定，明确排除项）；
- 未配置构建命令 = 功能关闭，`artifactDigest` 诚实为 null——这是"功能关闭"的诚实状态，不是缺口；
- 多机/分布式构建未做（进程内 runner）。

### 文档动作

`docs/KNOWN_LIMITATIONS.md` 的 §40→§36 条目整体改写为"已关闭（Batch 23/24/25；Batch 30 独立复验）"并列出上述边界。零代码改动。

## ③ Merge Queue 跨进程 drain 并发

### 审计发现

`docs/KNOWN_LIMITATIONS.md` 的 Git Broker 条目仍写：

> **仍未做**：多进程同时排空同一 repo 队列的并发语义（两个进程可能各自 hydrate 后重复处理同一条目，生产部署应保持单实例或外部串行化）

**这句话已经过时**。Batch 23 已用双层互斥关闭：`merge_queue_drain_locks` 表的 repo 级 drain 租约（原子 acquire、心跳、条件释放、takeover CAS；争用方审计 `MERGE_QUEUE_DRAIN_CONTESTED` 后明确让路；接管方诚实 re-hydrate，终态行不复活；verifier 内失锁中止 `MERGE_QUEUE_DRAIN_LOST`）+ per-entry `tryClaim` 纵深；Batch 26 补齐了 enqueue position 碰撞（`(repo_path, position)` 唯一索引仲裁，碰撞重试审计 `GIT_MERGE_QUEUE_POSITION_RETRY`）。

### 亲跑验证（基线 `7d99787`）

`node --test packages/git/dist/tests/merge-queue-drain.test.js` → **4/4 全绿**（含双真进程竞速、每 entry 恰好一次、争用让路、接管语义）。

### 诚实边界（保留）

只覆盖同一 DB 文件的多进程，不覆盖多机；队列运行态对象本身仍是进程内内存（靠落库重建）。多机并发仍是真实边界，不是本次要硬做的。

### 文档动作

该条目改写为"已关闭（Batch 23；Batch 26 补齐 enqueue position；Batch 30 独立复验）"，保留多机边界。零代码改动。

## ④ Linux 桌面安装包复验（Batch 25 结论的当树复验）

- 在基线 `7d99787` 上重跑 `npm run dist:linux`：**exit 0**，产物 `release/AI Factory-0.1.0.AppImage`（129,962,883 字节，ELF 64-bit x86-64），与 Batch 25 结论一致（上次约 124MB）。
- `docs/KNOWN_LIMITATIONS.md` 的"没有打过安装包"/"桌面壳从未在真机上点开过"两条目已改写：Linux AppImage 已打并经 xvfb 无头启动验证（Batch 25）；仍未做的是真人点击验收、Windows/macOS 安装包（需真实机器）、三平台代码签名（待 Tan 采购证书）。
- 本次未重做 xvfb 无头启动（Batch 25 已验证，产物构建管线未变）；真机点击仍缺，记录在上节大项第 6 条。

## 记录不硬做的大项（按真实使用影响排序）

以下缺口真实存在，但需要真实设计/实现工作，不属于"零代码改动可关闭"，本次只记录：

1. **pipeline stage 落盘**：pipeline 记录与 stage 定义仍是进程内存；重启后 `/run` 对 REHYDRATED stub 明确 409 拒绝（"stage 从未落盘，跑空 stage 会是假成功"——当前诚实状态）。最小诚实实现 = `pipeline_stages` 表（状态/日志/产物落盘，handler 闭包本就无法落盘、水合后回退默认模拟器并明确标注）+ hydrate 接线。这是一个完整功能批的量级，留给后续批次。
2. **真实隔离 Host**：Linux 本机直跑，非合规隔离后端；`CONFINEMENT_UNAVAILABLE` fail-closed 路径只有单测。这是环境/架构项，需要真实的隔离后端。
3. **除 Codex 外的模型适配器**：仍是 stub（Anthropic 等未接入）。需要真实供应商接入工作。
4. **MCP 真实服务器握手**：Unknown MCP 默认 BLOCK 的逻辑在，但从未连过真实服务器做协议握手验证。需要真实 MCP 服务环境。
5. **远程数据库驱动**：DbBroker 的连接 kind 仅为标签，无真实 postgres/mysql 驱动；引擎直写本机 SQLite。需要驱动接入。
6. **桌面真人点击验收**：xvfb 无头验证了打包后端的启动与 API，逐页 UI 点击的真机冒烟仍未做；Windows/macOS 安装包需真实机器；代码签名需 Tan 采购证书。部分 Tan/机器专属。

## 文档更新清单（本次已做，未 commit）

- `docs/KNOWN_LIMITATIONS.md`：四处过时条目改写为"已关闭"并注明复验证据与诚实边界（账号状态 / §40→§36 / Git Broker drain / 安装包与桌面壳）。

## 收敛结论

- Batch 24 的收敛确认（头号三个候选已关闭）之后，Batch 25–29 又关闭了：MCP 跨进程写互斥、构建 SBOM、SBOM 保留策略、launch 落库、enqueue position 碰撞、install 并发审计、构建孤儿清理、Database 三环境身份、Broker-Runbook 闭环、Browser Profile 隔离、网站文本隔离契约、e2e 启动等待轮询化、db.query Broker 服务端上线。
- 本次扫荡发现**文档滞后于实现**：三个最接近"可售"的候选缺口早已真实关闭（且全部被当批测试钉住、本次亲跑复验全绿），文档却还在说"没做"。这意味着当前的真实缺口清单比文档上写的要短——**剩余真实大项只剩上节列出的 6 项**，其中 2 项明确需要 Tan（Codex 登录、签名证书），2 项需要真实机器/环境（Windows/macOS 打包、MCP 真实服务），真正"纯代码可关闭"的只剩 pipeline stage 落盘与远程 DB 驱动。
- 建议下一批：pipeline stage 落盘（中等功能批），或把 `SELLABLE_CHECKLIST.md` 的 B/C 项按本次扫荡结论同步更新（该清单仍写着"builds 表只有 NOT_EXECUTED 记录""Database 三环境身份、生产写 Broker 未做"等已过时内容）。
