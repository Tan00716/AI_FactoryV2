# Batch 27 独立复核（REAUDIT_BATCH27）

- 基线：`d863af4`（复核开始时工作树干净；复核期间 Batch 28 的兄弟批次在同一工作树上在途编辑）。
- 亲跑：根 `npm run build` → **0 TS 错误**（注：`grep -c "error TS"` 计数为 0 时 grep 退出码为 1，属 grep 语义，不是构建失败）。

## 关于兄弟批次在途改动的隔离说明

复核结束时工作树上有 Batch 28 在途改动（`packages/db/src/mcp-servers.ts` 的 removeServer 事务化+`removeOrphanInstalls()`、`apps/server/src/routes/mcp.ts` 的孤儿清扫接线、`packages/tools/src/{database.ts（broker 审计 intent 类型 + statementKeywords 导出）,db-broker.ts,browser.ts,builtins.ts（注释）,index.ts（导出）}`、新测试文件若干）。经 `git diff` 逐项检查：

- 我验证的三条代码路径（`saveInstall`/`removeInstall` 的 SQL 语句、`build-runner.ts` 的 reconcile、`DatabaseEnvironmentRegistry`/`authorizeQuery`）**均未被改动**；
- 所有在途改动都是加法性（新方法、新导出、类型扩展、注释更新）或正交路径（removeServer 事务化），不改变被验证语义。

因此下列验证数字归属 Batch 27 的代码，无兄弟批次干扰。

## (a) install 并发语义：成立

- 亲跑 `packages/db/dist/tests/mcp-install-concurrency.test.js`：**5/5**。
- 测试内容真实：双实现对拍（memory + sqlite）200 轮交错锤击、**两条独立 `DatabaseSync` 连接同文件 150 轮锤击**、整行覆盖语义、删缺失行无副作用。
- 独立再复核（审计自写脚本，非 batch 测试文件）：两个真实 `node` 进程、共享同一 SQLite 文件、每进程 300 次带 tag 的 install/removeInstall 写入 → 最终行 `status/installedAt/scopeEnabledJson/lastUsedVersion` 全列同一 tag（`A-299`），**无混合行**，终态=某完整写入或干净消失。
- "单语句原子"与源码一致：`saveInstall` 是单条 `INSERT … ON CONFLICT DO UPDATE`（全部列一次写入），`removeInstall` 单条 DELETE；无 read-modify-write。结论"最后一个完整写入胜出、从不字段合并"真实。

## (b) 构建孤儿清理：成立

- 亲跑 `apps/server/tests/build-orphan-reconcile.test.ts`：6 个单元测试全部稳定通过（死 PID 孤儿清理+git 解除注册+审计、活 PID 跳过、非 `build-<uuid>` 不动、workRoot 缺失 no-op、无标记无记录不可归属不动、有记录无标记的 pre-marker 窗口兜底清理且记录保持 `NOT_EXECUTED`）。
- e2e "真 SIGKILL mid-build → reboot 清理"：**单独运行时通过**（24s：boot A → merge → worktree 出现 → SIGKILL → boot B → 孤儿被清理、`BUILD_ORPHAN_CLEANED` 审计含 "cleaned, never replayed"、构建记录保持 NOT_EXECUTED）。全文件连续跑时曾出现 3 次失败，全部卡在 e2e 的第一步 `GET /api/health`（ECONNREFUSED）：实测本机 server 从 spawn 到可服务约 **2.5s**，测试固定等 2.5s 是零裕量，机器稍有负载就超——**测试时序抖动，非产品回归**。建议下一批把 e2e 的启动等待改为轮询 `/api/health` 直到就绪（与 boot-smoke 同模式），而不是固定 2500ms。
- 源码对表：
  - 归属标记 `.factory-build-runner.json`（buildId、revision、owner PID + `/proc` PID 启动时间）→ 防 PID 复用，代码在 `procStartMs`/`isPidAlive`。
  - 活 PID 跳过：`isPidAlive(marker.pid, marker.pidStartMs)` 为真则 `BUILD_ORPHAN_SKIPPED`，目录不动。
  - 不可归属（无标记+无构建记录）→ `BUILD_ORPHAN_SKIPPED`，不动。
  - 非 `build-<uuid>` 目录永不扫描（严格正则）。
  - 清理顺序：先 `git worktree remove --force` + prune，再删目录；失败则 `BUILD_ORPHAN_CLEANUP_FAILED`。
  - reconcile 永不抛（readdir 失败 no-op；逐条 try/catch）。
  - 启动接线：`index.ts` 在启动时 `buildRunner?.startReconcile()`，`pump()` 先等 reconcile 完成再跑新构建——pre-marker 窗口的"名+记录"兜底不会误伤本轮在途构建。
  - 诚实边界如实：功能关闭时不运行、换 workRoot 后旧 root 不扫、单机。

## (c) Database 三环境身份：成立

- 亲跑 `packages/tools/dist/tests/database.test.js`：**21/21**。
- 断言点真实存在：`register()` 不带 environment → `dev`（永不猜 prod）；同名换 env 注册抛错（含 immutable 字样）；prod 写 `prodWriteConfirmed === true` 字面 true 才放行，`'yes'` 等 truthy 被拒；切换审计 `DB_CONNECTION_SWITCHED`；语句分类保守（未知语句按写处理）。
- 源码对表：`DatabaseEnvironmentRegistry`（`packages/tools/src/database.ts`），db.query 内置定义加了可选 `connectionName`/`prodWriteConfirmed` 字段，仍 definition-only。
- 边界措辞真实："这是 fail-closed 确认门，不是 §33 的最小权限 Broker/Runbook——生产写 Broker 仍未做；无查询引擎；无物理隔离，身份是逻辑标签。"

## 口径检查

- KNOWN_LIMITATIONS：Database 三环境身份、构建孤儿清理两个新增条目已落地，install 条目已改写为"已审计钉死"；边界说明与实现一致。
- 诚实边界无新增；`removeServer` 两条 DELETE 的理论接缝（6 轮×20000 次未命中）如实记录。

**最终口径：Batch 27 三项声明全部真实，文档边界真实，零夸大。发现一项测试时序抖动（已定位到 e2e 的固定 2.5s 启动等待），产品侧无回归。**
