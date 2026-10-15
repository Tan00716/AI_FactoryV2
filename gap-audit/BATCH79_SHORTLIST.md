# Batch 79 短名单：SPEC_V2 剩余可实施项扫荡（代码侧还能做的活）

> 调研批，只做调研，不动手实现。基线 `980f603`（Batch 78，本地）。方法：只读 + grep；未写产品代码；未 commit。
> 结论先行：**Findings F1–F68 里已没有代码侧可做的 open 项**（13 条 open 全是 by design/文档已记 或 Tan/环境侧）。
> 真正值得做的 3 项来自：Batch 75 翻转 S8 后留下的走查口径债务、F58 记录在案的 follow-up、AT-001–AT-064 纯逻辑子集。

## 1. Open findings 分类（F1–F68，共 13 条 open）

| # | 级别 | 分类 | 一句话 |
|---|---|---|---|
| F5 | Low | by design（不动） | final-report `contentHash` 覆盖 `generatedAt` 是刻意设计——标识一次生成实例，不是内容；比 counts 不比 hash |
| F6 | Medium | 文档已记（不动） | 部分 rebuild 致 `dist/` 不一致，`npm run build` 全量解决；环境卫生说明 |
| F8 | Low | by design（不动） | retention `evaluate` 按类别计数、非按文件枚举，是已知语义，无需改产品代码 |
| F10 | Low | by design（不动） | mid-run pipeline 链用诚实标注的行形模拟（真 SIGKILL 落不到 mid-run） |
| F11 | Low | 文档已记（不动） | `GET /api/pipelines/:id` 优先内存态、重启后持久视图为准；已文档化 |
| F15 | Low | 环境侧（不动） | M1 leg 需要 npm registry（本环境 loud skip） |
| F16 | Low | 环境侧（不动） | sandbox 断言环境自适应（`BUILD_SANDBOXED` 或诚实 `SANDBOX_UNAVAILABLE`） |
| F20 | Low | by design（不动） | 合法登录清暴力破解计数器是文档化的产品规则 |
| F32 | Info | 文档/走查卫生（不动） | 审计链必须按追加序验证（`ORDER BY ts, rowid`），不是 API newest-first |
| F35 | Info | 文档/走查卫生（不动） | verify leg 跑默认无 token 模式；role 轴由契约测试钉死 |
| F54 | Info | Tan/环境侧硬门槛（不动） | 无真实 OS 隔离 Host；走查钉的是"拒绝"不是 sandbox 宣称 |
| F56 | Info | by design（不动） | `downgrade-autonomy` 只决策+记录，不跨包重写 autonomy store（刻意分层） |
| F67 | Medium | Tan/环境侧（不动） | Windows 最终 Setup exe 需 Windows 实机 + wine；三平台未签名、零证书配置（OV/EV、Apple Developer ID 都是 Tan 的决定） |

统计：**13 open = 9（by design/文档已记）+ 4（Tan/环境侧）+ 0（代码侧可做）**。

## 2. 候选池（含被否决项，说明原因）

| 候选 | 结论 |
|---|---|
| §81 sweep 走查 S8 腿（B75 后过期） | ✅ 入选 Top 3-1 |
| AT 纯逻辑验收资产（21/64） | ✅ 入选 Top 3-2 |
| F58：DATA_EXPORT → approvals 授权票据 | ✅ 入选 Top 3-3 |
| git-commit 密钥扫描（F53 提过 out of scope） | ❌ 否决：`GitRepo.commit()` 只在包测试里被调用，**产品路径没有提交用户内容的入口**，无攻击面 |
| F53 剩余：bare 高熵字符串脱敏 | ❌ 否决：B66 已落地 `redactText` choke point；剩余是文档化的 accepted boundary（熵检测误报率高），不值得 |
| F57 follow-up（qa.ts 传 policy） | ❌ 否决：B66 已做（`FactoryPolicyStore` + qa.ts 接线），走查正文是 Batch 66 前快照，index 已是 closed |
| MCP SSE/HTTP 传输 | ❌ 否决：清单列为硬门槛——实现本身可做，但无真实 MCP 服务器可验真；且无需求信号，属 scope creep；OAuth 部分需 Tan 侧凭证 |
| `dist:win` 缺 `--publish never`（74-2 记过） | ⚠️ 备选 bonus：1 行配置卫生（四个 `dist:*` 脚本都没加），防误发布；价值太低，不进 Top 3 |

## 3. Top 3 短名单

### 3-1. §81 sweep 走查 S8 腿更新（Batch 75 翻转后的口径债务）——价值/工作量比最高

- **做什么**：`apps/server/tests/first-run-walkthrough-needshuman.test.ts` 的 S8 段已过期——头部注释仍写"this server's HTTP surface has no input that can put a stagnation signature into ENV_ERROR_CODES"（Batch 75 加了 `envErrorSignal`，现在有了），断言文案"HTTP positive path does not exist"已不成立（测试还绿是因为没传 signal 时负向对照仍成立，但注释在说谎）。更新：修正注释 + 新增 S8 阳性腿（operator token + `envErrorSignal` → ESCALATED，`declared-not-observed` 限定词在位），保留无 signal 负向对照作对照组；tally 从"7/8 + 1 负向"变为真正的 **8/8**。
- **为什么值得**：走查是回归资产，注释说谎会误导后续所有批次；这是 §81 全触发器走查从"7/8+1负向边界"变成"8/8"的最后一步，且阳性路径已有 `needs-human-irrecoverable-env-error-http.test.ts` 7/7 可抄形状。
- **预计改动面**：1 个测试文件（注释 + 新增一个腿）；零产品代码改动；server 套件重跑验证。

### 3-2. AT-001–AT-064 正式验收资产：纯逻辑子集（21/64）

- **做什么**：按 `TEST_PLAN_V2.md` 的 `docs/testing/v2/` 约定，为 21 个**纯逻辑、无需真实模型/真机/真生产**的 AT 建正式验收资产（AT 编号的可执行验收文件，`node:test`），每个显式标注"逻辑层验收（logic-level），非端到端"。21 项（`docs/AT_MAPPING.md` 里 `blocked: 无` 的）：AT-008（Scout 六阶段）、AT-016（组织图去重）、AT-018（越级上报）、AT-023（无证据不 100%）、AT-025（进度权重）、AT-026（需求 v2 影响分析）、AT-033（模型路由三策略）、AT-034（Quota unknown 不编造）、AT-035（Watchdog 分类）、AT-036（Takeover fencing）、AT-037（Lease 过期）、AT-040（锁/FIFO）、AT-042（独立性拒绝自审）、AT-043（QA attempt 保留）、AT-045（凭证不泄漏）、AT-046（审批失效）、AT-052（预算原子）、AT-053（记忆 scope 过滤）、AT-054（记忆 STALE/CONTRADICTED）、AT-056（Eval 独立评分）、AT-057（组织环拒绝）。其余 43 项保持 NOT_RUN 并写清缺的真实环境。
- **为什么值得**：可售清单硬门槛 #13（"275 条资产不存在，NOT_RUN"）**唯一有代码侧突破口**的一项；把模糊的"一条都没验收"变成精确诚实的"21/64 逻辑层已验收、43/64 缺真实环境"，审计口径收敛。
- **预计改动面**：`docs/testing/v2/` 新目录 + 约 21 个薄验收文件（多复用现有包测试的 harness，非重复造轮子）；`docs/AT_MAPPING.md` 同步；server/包套件重跑。工作量中等，无产品行为变更。

### 3-3. F58 follow-up：DATA_EXPORT 接 approvals 授权票据

- **做什么**：非本地模型调用前（`packages/runtime/src/runner.ts` 的 `dataExportEventFor` 已建证据事件处），在 approvals 包创建**授权票据**（PENDING → 决定的记录），与 `DATA_EXPORT` 证据事件双向关联 + 审计留痕。默认**记录式**（不阻塞调用，零 UX 变更）；是否升级为阻塞式门控是产品决策，留给 Tan。
- **为什么值得**：关闭 F58 记录在案的 follow-up（G11/INV-30 诚实边界："DATA_EXPORT is an evidence-level audit record, not an approvals-package authorization ticket"）；让"受控数据外发"从"只有证据记录"升级为"有授权票据可查"。
- **预计改动面**：`packages/runtime/src/runner.ts`（票据创建点）+ approvals 包 linkage + server 端查询面（如需）+ 新测试（票据创建/关联/审计）；中等工作量，无现有行为变更。

## 4. 备注

- 本批**只调研**：以上 3 项均未实现；实现是下一批的事。
- 13 项硬门槛其余 12 项（Codex 登录、非 Codex 适配器 stub、Windows/macOS 包+签名、真人点击验收、许可证/定价/渠道、CI scope、无真实隔离 Host、生产 attestation、Windows 工具探测、远程 DB/merge queue 多机、无测试生产环境）仍在 Tan/环境侧，代码无可代劳。
- 5 项"代码侧刻意不做"（Board 走 v1、`db.query` DENY、`mcp.call` definition-only、reconcile 只报告、F20）维持 by design，不动。
