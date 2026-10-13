# Batch 28 独立复核（Batch 29-1）

**基线**：`b033759`（树干净，无在途改动）。复核方法：根构建后亲手重跑四个测试文件；亲读实现关键路径；全部断言独立核对。
**结论：Batch 28 的三项实质声明全部成立，未发现夸大或造假。**

## (a) removeServer 原子化：成立

- 亲跑：`packages/db` `mcp-remove-transaction.test.ts` **6/6**。
- 亲读 `packages/db/src/mcp-servers.ts:448`：`BEGIN IMMEDIATE` → 两条 DELETE → `COMMIT`，异常路径 `ROLLBACK`；测试用的 `afterServerDelete` 故障注入钩子确实能模拟两条 DELETE 之间的交错并验证整单元回滚。
- 亲跑：`apps/server/tests/mcp-remove-orphan-cleanup.test.ts` **1/1**（真 server e2e，2.1s）：注册→批准→安装→DB 里直插孤儿行→`POST /api/mcp/remove`→注册行与 install 行一起消失、孤儿行被防御扫描清掉、`MCP_INSTALL_ORPHAN_CLEANED` 审计留痕。`apps/server/src/routes/mcp.ts:310` 接线与声明一致。
- 语义诚实：实现没有消灭孤儿（锁后写入仍会落成孤儿行），而是让孤儿可观测、可扫、审计留痕——与提交说明的"改变了孤儿的命运"口径一致。孤儿清理只发生在 `/remove` 路径，不是启动 reconcile；这一点代码与文档都如实，没有承诺更多。

## (b) DbBroker/Runbook 最小闭环：成立

- 亲跑：`packages/tools` `db-broker.test.ts` **33/33**。
- 亲读 `packages/tools/src/db-broker.ts`：
  - 执行链确为 registry `authorizeQuery` 门 → broker 自身白名单（操作桶+表白名单）→ 宿主注入 `DbQueryEngine`；每种结局（gate 拒绝、policy 缺失、whitelist 拒绝、NO_ENGINE、引擎异常、成功）都写审计事件。
  - "broker 永不拼接 SQL"真实：`engine.execute({ connectionName, sql: template.sqlTemplate, params: { ...params }, actor })`（runbook 路径 887-893）与 ad-hoc 路径 647-652 都是模板原文 + 参数对象分开传给引擎；broker 自身没有任何字符串拼接参数入 SQL 的操作。参数须标量、slots 精确对应（缺/多/非标量均拒绝，引擎见不到）。
  - "无引擎响亮拒绝"真实：`NO_ENGINE` 时 `allowed: true, executed: false` 并写 `DB_RUNBOOK_DENIED`——允许位是门放行的事实，`executed: false` + 明示理由，没有伪装成执行过。
  - 表名提取的 fail-closed 方向如实：写语句抽不出目标表 → 拒绝（尽力解析 + 状态机剥注释/字符串，文档注明这是单遍尽力法、不是完整解析器）。
- 边界与提交说明一致：服务端 `db.query` 仍 definition-only（本批未动服务端接线）；绑定值永不进审计；无物理隔离。

## (c) Browser 隔离 Profile：成立

- 亲跑：`packages/tools` `browser.test.ts` **11/11**。
- 亲读 `packages/tools/src/browser.ts`：
  - 每 profile 目录 `<root>/browser-profiles/<name>-<id8>/`，含独立 `user-data/`；测试真写 cookie 文件验证不共享（`two profiles never share a user-data dir` 6 行断言）。
  - `resolveDownloadPath` 对绝对路径、`..`、分隔符一律拒绝并审计；成功时返回 `join(downloadDir, fileName)`。
  - `destroyProfile` 递归真删目录；`cleanupOrphanedProfiles` 只删匹配 `PROFILE_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[0-9a-f]{8}$/` 的未注册目录，非匹配目录永不碰，root 不存在时直接返回。
  - `driverAvailability()` 诚实返回 `available: false`；`browser.open` 保持 definition-only。
- 边界与提交说明一致：这是本机目录隔离，不是 OS 沙箱；隔离 Host 仍是未做的一半。

## 本次亲跑验证数字（基线 b033759，根构建 0 TS 错误后）

- `mcp-remove-transaction.test.js`：**6/6**
- `mcp-remove-orphan-cleanup.test.ts`（真 server）：**1/1**
- `db-broker.test.js`：**33/33**
- `browser.test.js`：**11/11**

## 诚实备注

- `removeServer` 的原子性是同进程 SQLite 事务的原子性；跨进程靠 `BEGIN IMMEDIATE` 写锁串行，busy 超时后大声抛错——与 Batch 28 声明的"同一 DB 文件多进程"边界一致，没有承诺多机。
- Runbook "注册即审批"的跳过 ad-hoc 白名单是设计而非漏洞：注册时有完整的 slot/占位符/连接/单语句校验并审计 `DB_RUNBOOK_REGISTERED`；测试钉死了 `run: runbook skips the ad-hoc whitelist BY DESIGN`。
