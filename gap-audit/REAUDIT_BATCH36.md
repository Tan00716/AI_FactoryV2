# Batch 36 独立复核报告（REAUDIT_BATCH36）

- 基线：`05a19e6`（Batch 36 收口 commit）
- 方法：`/tmp/b37-wt` 干净 worktree（detached HEAD @ 05a19e6，与主工作树隔离；node_modules 软链自主树）上亲跑构建与测试 + 逐条亲读代码；服务端 e2e 按 AGENTS.md 约定用临时 secrets 隔离。复核后 worktree 已删除。
- 零产品代码改动，未 commit。

## 结论：Batch 36 的实质声明全部成立，未发现夸大或造假。偏差 0 处。

## 真实验证数字（干净基线亲跑）

- 根 build：**0 TS 错误**；`npm test`：**2449/2449**；服务端全套：**311/311**；desktop tsc：0
- (a) §81 needsHuman 发射路径：
  - `packages/db/tests/needs-human-upgrades.test.js`：**14/14**
  - `packages/policy/tests/authority-hook.test.js`：**4/4**
  - `apps/server/tests/needs-human-restart.test.ts`：**1/1**（真 server + 真 SIGKILL 重启）
- (b) 走查第四版：`first-run-walkthrough-b36.test.ts`：**1/1**，复核人亲跑 **2/2**（36-4 自报连续 3 次全过，复核未逐一复跑但连续两次全绿无抖动）
- (c) 可售清单：SELLABLE_CHECKLIST.md 的 36-3 改动与 35-4 建议逐条对上（见下）

## (a) §81 needsHuman 发射路径：成立

逐项亲证：

1. **SPEC 对齐准确**：`needsHuman('ai-disagreement', …)` 的 `'ai-disagreement'` 是 `HumanNeedReason` 联合的合法成员（`packages/autonomy/src/escalation.ts:24`）；头注释的"八个触发器只有 ai-disagreement 有发射点"与代码如实相符。
2. **发射路径真实**：`AuthorityRegistryHooks.onConflictOpened` 只在 OPEN 创建分支被调用（`authority.ts:343`，在冲突行已写入 conflicts map 之后）；服务端 `createRegistry(db)` 仅当 db wired 时接线（pre-boot 无发射，Batch 32 行为不变）。`registerDirective` 全库唯一调用点是 `POST /api/authority/directives` handler，`flushNeedsHuman(ctx)` 在同一请求内执行——OPEN 创建即写透，无悬置。
3. **写透失败不回滚**：`flushNeedsHuman` 的 try/catch 里 submit 失败只写 `NEEDS_HUMAN_PERSIST_FAILED` 审计，冲突记录已返回 200。
4. **recipient null 诚实**：`buildUpgradeRecord` 写死 `recipient: null`，并记录 `requiredDeciderLevel`（双方 rank 的严格更高等级；owner-vs-owner 死锁时如实写 maxLevel + out-of-band suggestion）。亲读确认，无编造人名。
5. **/resolve 永不消解**：`POST /api/authority/conflicts/:id/resolve` handler 只调 `registry.resolveConflict`，全函数无 needsHuman 引用——"永不自动消解"是代码事实。消解只走 `POST /api/needs-human/:id/resolve`（条件单行更新，终端行 409 `NEEDS_HUMAN_ALREADY_TERMINAL`）。
6. **旧声明已改写**：`index.ts`、`routes/disputes.ts`、`db/src/escalations.ts` 三处"needsHuman 无发射点/无存储"的旧声明均已改写为"由 AUTHORITY_CONFLICT OPEN 发射、存于 fdb.needsHuman"。
7. **`@ai-factory/autonomy` 依赖**：`apps/server/package.json` 已补 `"@ai-factory/autonomy": "0.1.0"`（此前 routes/autonomy.ts 在用但漏依赖——36-2 的附带修复，如实）。

如实记录（非缺陷）：
- `onConflictOpened` 是同步调用且未包 try/catch；handler 本体只做数组 push 不会抛。未来若接可抛 handler，需要防滚回——头注释写明了意图，当前无问题。
- 其余七个 §81 触发器仍无发射点（代码与文档均如实声明）。

## (b) 走查第四版：成立

- 亲读确认七个链路（P1 pipeline→INTERRUPTED、B1 真实构建纯 HTTP `/api/builds` 观察 SUCCEEDED、A1 冲突 OPEN→人工消解、D1 taskScope 上限、G1 gates/delegations/escalations/proposals 落库链、R1 项目记录+知识、A2 12 个审计动作链 verify）全部在单 `it` 内串行执行，无 mock。
- F10–F13 如实：F10 行形模拟在文件头和文档都诚实标注；F11 "live 记录优先读内存"是设计约定；F12 registry 内存导致 OPEN 冲突重启丢失——走查故意在 kill 前先 resolve；F13 scope 合同真执行（403 点名缺失权限）。
- 审计动作名逐个对代码核过（`SELF_MODIFICATION_PROPOSED`、`AUTHORITY_CONFLICT_DETECTED`/`_HUMAN_RESOLVED`、`TASK_SCOPE_CEILING_DENIED` 等）——36-4 的做法成立。

## (c) 可售清单：成立

- B 剩余缺口："§81 其余七个触发器无发射点（'ai-disagreement' 触发器已于 Batch 36 经 AUTHORITY_CONFLICT OPEN 发射并落库）"——与 35-4 建议 + 36-2 实现一致。
- 已关闭清单追加了"§81 needsHuman 发射路径（Batch 36）"。
- C 基线更新为 `05a19e6`（包套件 2449/2449、服务端 311/311、desktop tsc 0、smoke:boot OK）——与本复核的干净基线亲跑数字**逐字一致**。
- 独立复核追加到 Batch 35（含各批纠偏记录）。
- "当前状态"小节引用 SELLABLE_REVERIFY_BATCH35.md，总结论口径（"可运行的原型 + 持续收敛"）未夸大。
- Tan 侧硬卡点（Codex device login、Windows 构建环境、macOS、代码签名、许可证/定价/渠道、CI workflow scope）一条没动——诚实。
