# 可售清单复验报告（Batch 44，第三轮）

> 复验基线：`9448321`（Batch 43，已推送，远端 main 经 `git ls-remote` 复验一致）。上次复验：Batch 40 第二轮全量复验（基线 `59eb7a0`，`gap-audit/SELLABLE_REVERIFY_BATCH40.md`），中间走了 Batch 41–43。
> 本报告为增量：只记录相对 Batch 40 的变化，不重复 40-3 全文。复验方式：亲读 CHANGELOG（Batch 41–43）、KNOWN_LIMITATIONS、`docs/needs-human-triggers.md`、相关代码 grep 与文件存在性验证；HEAD 亲验为 `9448321`；本人独立亲跑 Batch 43 新增测试（见下）；零产品代码改动，未 commit。

## 主线验证数字（Batch 43 收口，主线亲验，引用 + 本人抽查）

- 根 `npm run build`：0 TS 错误（主线亲验，引用）
- `npm test`：**2502/2502**（Batch 40：2476/2476；Batch 41：2478/2478，+2：core/db audit-count；Batch 42：2498/2498，+20：brute-force、redaction-monitor、requirements 增量；Batch 43：2502/2502，+4：env-error-codes 真路径增量）
- `node --test apps/server/tests/*.test.ts`：**405/405**（Batch 40：352/352；Batch 41：362/362，+10：needs-human-policy-violation 9、walkthrough-b41 1；Batch 42：396/396，+34：needs-human-brute-force、needs-human-brute-force-e2e、redaction-monitor、needs-human-requirement-ambiguity；Batch 43：405/405，+9：needs-human-irrecoverable-env-error 8、walkthrough-b43 1）
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误；`npm run smoke:boot`：OK（主线亲验，引用）
- **本人抽查亲跑（基线 9448321，工作树干净）**：`needs-human-irrecoverable-env-error.test.ts` **8/8**、`first-run-walkthrough-b43.test.ts` **1/1**——Batch 43 新增测试在主线真实通过。

## A. 真实可用

| 条目 | 40-3 状态 | 本次状态 | 说明 |
|---|---|---|---|
| 真实模型端到端回路 | BLOCKED（卡 Codex 登录） | **仍 BLOCKED，无变化** | 卡点未变：需 Tan 本人在开发机执行 `codex login --device-auth`（Tan 2026-10-12 明确推迟，不催）。CodexAdapter 本体已真实实现（未登录时 turn 被真实 401 拒绝）；Codex 以外适配器仍 stub（`packages/runtime/src/adapters.ts` 的 StubAdapter 本轮亲验仍在）。 |
| 桌面应用可分发 | 部分（Linux 验证过） | **部分，无变化** | Linux AppImage（Batch 25）仍是唯一亲验过的分发；Windows 无构建环境（exe 仍是模板）、macOS 需 Mac 本机、代码签名零配置（证书待 Tan 采购）。 |
| 首次运行体验 | 走查第四版 1/1 | **走查第六版，保持** | v5（`first-run-walkthrough-b41.test.ts`，`demo:e2e-v5`，Batch 41，1/1×4）、v6（`first-run-walkthrough-b43.test.ts`，`demo:e2e-v6`，Batch 43，1/1×4）在库；v6 串完 B41–B42 四个 §81 发射点（policy-violation、brute-force、redaction、requirement-ambiguity），纯 HTTP 零 mock；本人亲跑 v6 1/1 确认。走查仍只覆盖 API 层，**无真机桌面点验**（诚实边界不变）。 |
| 关键数据可持久 | ✅ 勾选，§48.2 全落库 | **保持勾选** | Batch 41–43 新增持久化面：`needs_human_upgrades` 继续承接四个新发射点（insert-only + 条件 resolve）；brute-force/redaction 聚合计数器为**进程内存**（重启清零窗口，文件头如实注记理由：落库每 401 一写=DoS 向量；告警行本身落库持久）——不是降级冒充，是显式设计选择。 |

## B. 规格完整度

### Batch 41–43 新关闭的真实缺口（亲验在位）

1. **§81 needsHuman 发射面 4/8 → 8/8（全部接上）**：`docs/needs-human-triggers.md` 亲读——`## 已发射（8/8）` 下 8 个触发器全在（ai-disagreement、budget-exceeded、repeated-failure、high-risk-deployment、policy-violation、security-issue、requirement-ambiguity、irrecoverable-env-error），`## 未发射` 节已改写为"全部发射"。各发射点亲验在位：
   - `policy-violation`（Batch 41）：`apps/server/src/routes/workforce.ts` 的 `recordCeilingDenial`（本轮 grep 确认阈值常量在位）；确定性发射点是"同一 granter 累计 3 次 ceiling denial"（哈希链审计事实计数），诚实口径"the policy held on every attempt"。
   - `security-issue`（Batch 42，两个发射点）：`packages/security/src/brute-force.ts`（滑窗 5min/10×401 确定性计数）+ `apps/server/src/redaction-monitor.ts`（`SECRET_REDACTED_HIT` 聚合 5min/3 事件）；单次永不发射；fail-closed。
   - `requirement-ambiguity`（Batch 42）：`RequirementManager.countConsecutiveAcRefinements`（尾部连续 `AC_REFINEMENT` 确定性计数）+ 409 熔断器。
   - `irrecoverable-env-error`（Batch 43）：`apps/server/src/routes/runtime.ts`（本轮 grep `irrecoverable-env-error` 2 处在位）；发射条件 `reasonCode === 'LOOP_STAGNATION' && isEnvErrorCode(stagnationSignature)`，全程 code 成员判定（`ENV_ERROR_CODES` 显式集合），39-4 的正则 `classifyFailure` 一行没用；`RecoveryLoop` 零 server 调用者的问题**绕过而非解决**（发射走 run 自身终局 escalation，文档如实记录）；直接的 `ENV_*` reasonCode 刻意不接（文档命名为未来钩子）。
2. **走查第五/六版**：v5 覆盖 Batch 37–40 新链路（MCP 真握手大声 skip、沙箱诚实回退、attestation 可验），v6 覆盖 Batch 41–42 新发射点；Findings F14–F21 全部诚实记录（含 F19：narrative 未活过持久化——后续批次修复项，见下）。
3. **文档一致性扫荡（Batch 43）**：KNOWN_LIMITATIONS 4 处修正（INV-31 已关闭、§81 补 policy-violation、基线→795d508、§48.2 标题）、SELLABLE_CHECKLIST 4 处更新——亲验文件在位。

### 剩余真实缺口（诚实边界，非遗漏）

1. **§81 全部接上（8/8），无剩余未接触发器**——这是相对 Batch 40 最大的翻绿。注意两个诚实限定：① brute-force/redaction 聚合计数器是进程内存（重启清零）；② `irrecoverable-env-error` 绕过了 RecoveryLoop（其在 server 仍零生产调用者），直接的 `ENV_*` reasonCode 刻意不接。
2. Codex 以外模型适配器仍 stub。
3. 远程数据库驱动未做。
4. merge queue 多机并发未做（只覆盖同一 DB 文件多进程）。
5. Windows 工具探测未在 Windows 验证。
6. 桌面真人点击验收未做。
7. SBOM attestation 生产签名（待 Tan 密钥决策；dev 路径已关闭并纳入 retention）。
8. **F19（新）**：`needsHuman()` 的 narrative 未活过持久化——`NeedsHumanDbRecord` 无 `detail` 列，policy-violation/redaction/requirement-ambiguity 三个 builder 的 `detailJson` 没抄 narrative（只有 brute-force 保留了）；`GET /api/needs-human` 看到的记录里没有任何"并未发生违规"的限定语。走查 v6 已诚实记录，后续批次修复。
9. CI：`.github/workflows/ci.yml` 仍是本地未跟踪状态（本轮 `git status` 亲验），因 OAuth 缺 `workflow` scope 无法推送，**GitHub CI 从未运行过**。

## C. 质量与可信

- **全量测试持续全绿**：✅ 保持勾选。数字见上（2502/2502、405/405、tsc 0、smoke OK）；本人抽查 Batch 43 新增 8/8 + 1/1。
- **文档与实现一致**：✅ 保持勾选。CHANGELOG Batch 41–43 小节在位；KNOWN_LIMITATIONS §81 条目为 8/8 新口径；needs-human-triggers.md 8/8 与代码发射点一一对应（本轮 grep 抽查）。
- **独立复核**：✅ 保持勾选，追加：Batch 40（REAUDIT_BATCH40.md，偏差 0）、Batch 41（REAUDIT_BATCH41.md，偏差 0；干净 worktree 独立 npm install 重跑确认）、Batch 42（REAUDIT_BATCH42.md，偏差 0；29/29 新测试亲跑）。**`gap-audit/REAUDIT_BATCH21.md`–`REAUDIT_BATCH42.md` 连续无断档**（本轮 `ls` 亲验）。Batch 43 的独立复核（44-1）在本轮复验时仍在途，本报告不代其背书。

## D. 商业化最小要件

- **版本号与 CHANGELOG**：✅ 保持勾选。版本仍 0.1.0（本轮 `package.json` 亲验）；CHANGELOG 按批维护（Batch 43 小节在位）。
- **许可证**：**仍待 Tan 拍板**（无变化）。`docs/release/LICENSING_OPTIONS.md` 在位；仓库无 LICENSE 文件是刻意状态（默认保留所有权利）。
- **定价/分发渠道**：**仍待 Tan 拍板**（无变化）。

## 建议的清单勾选更新（相对 40-3）

1. B-剩余缺口列表："§81 仅剩一个触发器无确定性发射点（…）" → "**§81 八个触发器已全部接上（8/8）**：policy-violation（Batch 41）、security-issue 双发射点（Batch 42）、requirement-ambiguity（Batch 42）、irrecoverable-env-error（Batch 43）；诚实限定：聚合计数器进程内存、RecoveryLoop 绕过、直接 ENV_* reasonCode 刻意不接"；已关闭列表追加：走查第五/六版（Batch 41/43）。
2. C-测试基线：→ 基线 `9448321`：包套件 2502/2502，服务端全套 405/405，desktop tsc 0，smoke:boot OK。
3. C-独立复核："Batch 22–41" → "**Batch 22–42** 每批独立复核全成立（…Batch 40/41/42 偏差 0 处）；Batch 43 复核在途"。
4. 顶部新增"当前状态（2026-10-14，Batch 43 收口，基线 9448321）"小节（结论见下）。

## 总结论

- **翻绿项（相对 Batch 40，最大一项）**：§81 needsHuman 发射面从 **4/8 扩大到 8/8（全部接上）**——policy-violation（Batch 41）、security-issue 双发射点（Batch 42）、requirement-ambiguity（Batch 42）、irrecoverable-env-error（Batch 43），均为确定性发射点+落库+测试钉住；走查 v5/v6 串完 Batch 37–42 新链路；Batch 40/41/42 独立复核 0 偏差。
- **仍卡项（硬卡点全在 Tan 一侧或环境项，无变化）**：A-真实模型回路（卡 Codex 登录，Tan 本人动作）；A-桌面分发 Windows/macOS + 代码签名（环境/采购）；D-许可证/定价/渠道（Tan 决策）；B-剩余：非 Codex 适配器 stub、远程数据库驱动、merge queue 多机、Windows 工具探测、桌面真人验收、attestation 生产签名、F19 narrative 持久化（代码侧可做，已排期）；CI 在 GitHub 从未运行过。
- **当前仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 测试全绿（2502/2502、405/405）、文档诚实、Batch 22–42 独立复核 0 偏差、§81 全部接上，但决定"卖"的硬门槛——真实模型回路（Codex 登录）、三平台分发+签名、许可证/定价/渠道——一项没动；这些全部需要 Tan 本人动作或外部环境，代码侧已无可代劳的路径。
