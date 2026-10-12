# 独立复核报告：Batch 1–10 已关闭条目抽查（Batch 11-4）

> 复核基线：`e47c797`（Batch 10）。复核方未参与 Batch 1–10 开发。
> 证据标准：只有 SPEC_V2.md 口径、当前源码、复核方亲自运行的命令/脚本输出算证据；开发方报告与提交信息只作待核查声明。开发方编写的测试至多作旁证，本报告的「证实」判定均不依赖测试全绿。
> 取证方式（正文证据列中逐条注明）：读源码＝逐行核实现；脚本实证＝复核方自写脚本对 dist 产物运行；HTTP 实证＝复核方启动真 server（临时 DB，PORT=3199）亲自走链。
> 注：复核期间工作区有并行批次的未提交改动；已用 git show HEAD: 核对，本报告引用的关键行（server 绑定、db pragma、审计链持久化列等）在 HEAD 与工作区逐字一致，判定针对的是已提交基线。

## 总判定

| 判定 | 条数 |
|---|---|
| 证实 | **21** |
| 部分证实 | **0** |
| 假关闭 | **0** |

抽查 21 条（每批 ≥2 条），全部证实。未发现假关闭。文末有 4 条非判定性的观察（不影响判定，但值得下一批留意）。

## 逐条判定表

### Batch 1（提交 07efce4）
| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| 1-1 | server 默认绑 127.0.0.1 | 证实 | `apps/server/src/index.ts:106` `HOST = process.env.AI_FACTORY_HOST?? '127.0.0.1'`，`:644` `server.listen(PORT, HOST)`。`ss -ltn` 显示 `127.0.0.1:3199` 单地址监听；用主机外部 IP（198.19.0.2）请求 /api/health 被拒，127.0.0.1 正常。 |
| 1-2 | PRAGMA foreign_keys=ON | 证实 | `packages/db/src/db.ts:584` 在 FactoryDatabase 构造器对每条连接执行；FK 声明真实存在（`packages/db/src/schema.ts` 多处 `REFERENCES`）。重开连接查 `PRAGMA foreign_keys` 返回 `{"foreign_keys":1}`；向 approvals 插入孤儿行（task_id 指向不存在任务）被拒：`FOREIGN KEY constraint failed`。 |
| 1-3 | 通知 emit 脱敏 | 证实 | `packages/notifications/src/engine.ts:110-111` emit 在存储/投递前对 title/body 调 `redactSecrets()`（@ai-factory/security），注释与代码一致：脱敏是单一收口点，去重键只用结构字段。emit BUILD_FAILED 事件、detail.reason 含 `sk-abcdefgh12345678` 与 `password=hunter2`（规则模板会把 reason 拼进正文），存下正文为 `…token sk-*** password=***`，明文零泄漏。 |

### Batch 2（提交 96ade1c）
| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| 2-1 | PromotionHold 门：被 hold 时 promotion-check 409 | 证实 | `packages/requirements/src/manager.ts:609` `assertPromotionAllowed()` 对 active hold 抛错；路由 `apps/server/src/routes/requirements.ts:107-125` 捕获后以 `isPromotionHeld` 二次确认才回 409（其余异常回 500，不冒充）。复核方亲自走完整链：create REQ-001 → links(task-reaudit-1) → newVersion v2 → impact → promotion-check 得 **409**；release hold（200）后再 check 得 **200**。 |
| 2-2 | §25 预算 8 项限额接真实路径（抽查 2 项 + 其余定位） | 证实 | 抽查项一·模型调用：`packages/runtime/src/runner.ts:127` 默认 StepFn 的 ACT 阶段每次 adapter 调用前 `tracker.consumeModelCall()`，超限抛 BudgetExceeded 且注释与 loop 的终局处理一致。抽查项二·工具调用：`packages/runtime/src/harness.ts:266` runTool 每次真实执行 attempt 前 `budgetTracker?.consumeToolCall()`。其余 6 项均在执行路径定位到：steps/retries/timeMs 在 `loop.ts` `enforceBudgets()`（每轮调用）、wall-time `loop.ts:172 checkWallTime()`、no-progress `loop.ts noteProgress()`、repair loops `loop.ts:219,250 consumeRepairLoop()`、context chars `runner.ts:101 checkContext()`。8 项齐备且都在真路径上，不是只声明未接线。 |

### Batch 3（提交 6b55110）
| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| 3-1 | AOCR 经 /api/stats 贯通真实数据、无数据如实 null | 证实 | `apps/server/src/routes/dashboard.ts` `buildOutcomes()`：authorized:= 任务有 decision='APPROVED' 的审批记录，completed:= status='DONE'，数据取自 ctx.tasks / ctx.fdb.approvals 真实存储；withinScope/Budget/Risk 明确不设（无记录源，注释写明不编造）。临时 DB（种子 6 任务、0 审批）GET /api/stats：`authorizedOutcomeCompletionRate.value = null, note = "暂无数据"`——有任务但无获准记录时如实 null，未造数。 |
| 3-2 | router account live-first、STUB/LIVE 标注 | 证实 | `apps/server/src/routes/model-router.ts:264-278` 先尝试 live 查询（CodexAdapter.getAccountStatus 映射注入 profile），失败才回退无 live 的 `getAccountStatus()`；`packages/model-router/src/profile.ts:48,59` STUB/LIVE 文案在代码中。GET /api/router/account 返回 `usageNote: "LIVE via codex-app-server — codex app-server reachable but NOT logged in (authMethod=null, requiresOpenaiAuth=true)…"、authenticated:false`——真查到了本机未登录的 Codex 并如实标注 LIVE + 未登录，未冒充已登录。 |

### Batch 4（提交 b3e42bf）
| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| 4-1 | newVersion 不能绕 HUMAN 授权改 AC 语义 | 证实 | `packages/requirements/src/manager.ts` newVersion Gate 2：对 mutate 前后做 `diffAcMeaning` 差异比对（不看调用方自称的 changeKind），added/removed/changed 任一非空且无 `humanAuthorization.isHuman` 即抛 `AcMeaningChangeRejectedError`；Gate 1 对 completion_target 同理。建需求后以非人类身份 newVersion 改 AC description → 抛 `AcMeaningChangeRejectedError`；对照组（只改 goal 文本）正常通过——门拦的是语义变更，不是全拦。 |
| 4-2 | computeProgress 拒绝无 evidenceRef 的正完成度 | 证实 | `packages/progress/src/engine.ts:115-118` c>0 且 evidenceRef 缺失/为空抛 InvalidCompletionError。单项计划、completion {c:0.5, evidenceRef:null} → 抛 `InvalidCompletionError`（原文含 "requires valid evidence (§20)"）；对照组带 evidenceRef:'ev-1' 正常算出报告。 |

### Batch 5（提交 4ec1db6）
| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| 5-1 | POST /api/review 自审 422 | 证实 | `apps/server/src/routes/review.ts` 走 `reviewWithIndependence()`，身份四字段缺失先 400 并点名字段；IndependenceRequiredError → 审计 CODE_REVIEW_INDEPENDENCE_DENIED + 422。缺身份 → **400**（错误文案列出缺失的四字段）；reviewerId==implementerId 且同 runId → **422**，body 含 `reasonCode:"INDEPENDENCE_REQUIRED"` 与 failedChecks。 |
| 5-2 | runAgent 默认建 StepIntentStore | 证实 | `packages/runtime/src/runner.ts:248-251` 优先级链 `options.intentStore?? harness.intentStore?? new StepIntentStore(clock)`；harness.runTool 在执行前 `persistIntent`、执行后 `recordResult`（harness.ts:258 起）。不给任何 store 跑 runAgent（StubAdapter + read 工具）：run 前 `harness.intentStore === undefined`，run 后为 StepIntentStore 实例，`intentSummary = {count:1, executed:1, failed:0, pending:0}`。 |

### Batch 6（提交 3498c9f）
| # | 条目 | 判定 | 证据 |
|---|---|---|---|
| 6-1 | 工具空结果 EMPTY_RESULT 不 seal 成功 | 证实 | `packages/tools/src/executor.ts:250` 结局判定 `exitCode!==0? FAILED: isEmptyResult? EMPTY_RESULT: SUCCEEDED`，按原始
...[truncated 4797 chars]
---

## 主线补记（2026-10-12，Batch 12 收口时）

本文件原始写入在 Batch 6 条目 6-1 中途截断，Batch 7–10 的表格与文末观察未落盘。审计员的完整结论已在其交付报告中给出（总判定：抽查 21 条，证实 21 / 部分证实 0 / 假关闭 0），以下为据该报告转录的缺失部分判定与观察，证据细节以审计员报告为准；本节为补记，非审计员原文。

### Batch 7（提交 8938108）— 转录判定：证实
- PolicyStore.set() 守卫：无 caller 权威改 locked 规则抛 PolicySetDeniedError + overrideDenied 事件留痕 + 状态零变更；同层 caller 对照放行。
- §22 leases 真实超时等待：deadline、双界、prune、Atomics.wait、可注入 sleep 时钟契约齐全（只读实现核对，未只看测试）。

### Batch 8（提交 987754a）— 转录判定：证实
- Exception Grant 的 WAIVED 在类型层（verdict 联合的独立成员）与代码层（WAIVED 分支不回 approval_id、不写审批记录）均不冒充 APPROVED。
- 核心审计 hash chain：审计员自写脚本对内存审计链做两类篡改（改 actor、删中间记录），verifyAuditChain 均报 ok:false, brokenAt:1。

### Batch 9（提交 4dcce5b）— 转录判定：证实
- SqliteAuditStore 哈希落盘：自写脚本跨进程重开 SQLite 库，2 条审计记录 hash/prev_hash 完整、verify 通过。
- Linux AppImage 实体存在（129,565,317 字节）；git check-ignore 实证 release/ 被 .gitignore 命中。

### Batch 10（提交 e47c797）— 转录判定：证实
- 根 build 脚本顺序对声明依赖抽查 4 对（runtime/leases/approvals→db、core→requirements）全部依赖在前。
- FACTORY_RUNTIME_TOOLS 在路由源码层核实：未设解析为空名单、权限仅在名单非空时授予、未知工具名在 index.ts 启动期致命拒绝。

### 审计员的 4 条观察（不改变判定）
1. StepIntent 在权限检查之后才落 intent：被 default-deny 的工具调用无 intent 记录（只有审计事件），与 §28.1「执行前落 intent」字面有细微差。——**已于 Batch 12 修复**（intent 先于权限检查落盘，被拒调用留 DENIED 终态 intent，db 标签同步对齐）。
2. leases 真等待只在进程内可观察（TTL 到期/prune）；跨进程/分布式锁不在此实现范围（设计注释已声明）。
3. tools 层空结果不产生执行记录意义上的成功，但 Batch 7 后 harness 仍封存一条显式标 empty:true 的 tool_result 证据——只认 type 不看 payload 的仓库外消费方仍会看到一条记录（Batch 7 报告已自述此界）。
4. AOCR「authorized := 有 APPROVED 审批」的口径是已声明的本地映射，与声明一致；分母定义若未来要对齐 §1.2 其他解释需另行确认（非缺口）。
