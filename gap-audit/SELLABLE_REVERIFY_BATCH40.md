# 可售清单复验报告（Batch 40，第二轮）

> 复验基线：`59eb7a0`（Batch 39，已推送）。上次复验：Batch 35 增量复验（基线 `7937dfc`，`gap-audit/SELLABLE_REVERIFY_BATCH35.md`），中间走了 Batch 36–39。
> 本报告为增量：只记录相对 Batch 35 的变化，不重复 35-4 全文。复验方式：亲读 CHANGELOG（Batch 36–39）、KNOWN_LIMITATIONS、`docs/needs-human-triggers.md`、相关代码 grep 与文件存在性验证；HEAD 亲验为 `59eb7a0`；零产品代码改动，未 commit。

## 主线验证数字（Batch 39 收口，主线亲验，引用）

- 根 `npm run build`：0 TS 错误
- `npm test`：**2469/2469**（Batch 36：2449/2449，+18：needs-human-upgrades 14、authority-hook 4；Batch 37：2449/2449 持平，real-handshake 2 条在无真实服务器环境大声 skip；Batch 38：2469/2469，+20：attestation 14、runner-reason-code 4、merge-queue-lock-crash 1、db builds 1；Batch 39：无新增包测试）
- `node --test apps/server/tests/*.test.ts`：**350/350**（Batch 36：311/311，+2；Batch 37：326/326，+15 build-sandbox；Batch 38：332/332，+6：needs-human-run-emission 4、build-runner 新 e2e 2；Batch 39：350/350，+18：needs-human-deploy-risk 11、attestation-retention 7）
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误；`npm run smoke:boot`：OK

## A. 真实可用

| 条目 | 35-4 状态 | 本次状态 | 说明 |
|---|---|---|---|
| 真实模型端到端回路 | BLOCKED（卡 Codex 登录） | **仍 BLOCKED，无变化** | 卡点未变：需 Tan 本人在开发机执行 `codex login --device-auth`（Tan 2026-10-12 明确推迟，不催）。自推迟后无新的登录动作记录。CodexAdapter 本体已真实实现（未登录时 turn 被真实 401 拒绝）；Codex 以外适配器仍 stub。 |
| 桌面应用可分发 | 部分（Linux 验证过） | **部分，无变化** | Linux AppImage（Batch 25）仍是唯一亲验过的分发；Windows 无构建环境（exe 仍是模板）、macOS 需 Mac 本机、代码签名零配置（证书待 Tan 采购）。 |
| 首次运行体验 | 走查第三版 1/1 | **走查第四版，保持** | `apps/server/tests/first-run-walkthrough-b36.test.ts`（`npm run demo:e2e-v4`）在库，11 个 it/test 点；Batch 39 收口服务端全套 350/350 包含该走查（亲验引用）。走查仍只覆盖 API 层，**无真机桌面点验**（诚实边界不变）。 |
| 关键数据可持久 | ✅ 勾选，§48.2 全落库 | **保持勾选，覆盖再扩大** | Batch 36–39 新增持久化面：`needs_human_upgrades` 表（insert-only + 条件 resolve，真 SIGKILL 跨重启测试钉住）、`markSucceeded` 的 `attestationRef`（memory+SQLite 双实现）、attestation 文件 retention 分类。 |

## B. 规格完整度

### Batch 36–39 新关闭的真实缺口（亲验在位）

1. **MCP 真实第三方服务器握手（Batch 37）**：`packages/mcp/src/stdio-connector.ts`（真实 stdio JSON-RPC 传输，零外部依赖）在库；主线曾用 npm 官方 `@modelcontextprotocol/server-filesystem@1.0.0` 亲手完成真握手（initialize→2025-11-25、tools/list 14、tools/call 读真实文件）。无真实服务器时测试大声 skip（本轮亲验：文件在位，skip 合同在测试头注释）。
2. **构建沙箱 / 真实隔离 Host（Batch 37）**：`apps/server/src/build-sandbox.ts` 在库；bubblewrap 探针+诚实回退（`SANDBOX_UNAVAILABLE` 审计）；`build-sandbox.test.ts` 15/15（Batch 39 收口全套 350/350 包含）。
3. **§81 needsHuman 发射面 1/8 → 4/8**：`docs/needs-human-triggers.md` 亲读——已发射 4 个（`ai-disagreement` Batch 36：AUTHORITY_CONFLICT OPEN，`apps/server/src/routes/authority.ts:83` 在位；`budget-exceeded`/`repeated-failure` Batch 38：`RunResult.reasonCode` 桥，`apps/server/src/routes/runtime.ts:440-478` 在位，按 code 分类不匹配 message；`high-risk-deployment` Batch 39：`POST /api/pipelines/:id/deploy` 调真实 `assessRisk` 替代硬编码 HIGH，`apps/server/src/routes/cicd.ts:699` 在位）。未发射 4 个各有一句话诚实原因（见下）。
4. **SBOM attestation dev 路径 + retention（Batch 38/39）**：`packages/cicd/src/attestation.ts` 在库（in-toto dev-only 真签名，`FACTORY_ATTESTATION_KEY`，验签强制 devOnly）；attestation 文件已纳入 retention 独立分类（与 sboms 同语义）。**生产签名仍未做**（密钥方案待 Tan 决策，KNOWN_LIMITATIONS 第 39 行）。

### 剩余真实缺口（诚实边界，非遗漏）

1. **§81 其余四个触发器无确定性发射点**：`requirement-ambiguity`（QA 分类器是正则启发式，在正则上发射=冒充确定性）、`policy-violation`（只有事前拒绝，零"违规已发生"检测路径）、`security-issue`（零安全事件检测路径）、`irrecoverable-env-error`（RecoveryLoop 真实但 server 零生产调用者；classifyFailure 文件头明写 heuristic；重试耗尽对 12 种 type 都发生）。详见 `docs/needs-human-triggers.md`。
2. Codex 以外模型适配器仍 stub。
3. 远程数据库驱动未做。
4. merge queue 多机并发未做（只覆盖同一 DB 文件多进程；单机心跳+过期回收 Batch 38 已做）。
5. Windows 工具探测未在 Windows 验证。
6. 桌面真人点击验收未做。
7. SBOM attestation 生产签名（待 Tan 密钥决策）。
8. CI：`.github/workflows/ci.yml` 仍是本地未跟踪状态（本轮亲验 `git status`），因 OAuth 缺 `workflow` scope 无法推送，**GitHub CI 从未运行过**。

## C. 质量与可信

- **全量测试持续全绿**：✅ 保持勾选。数字见上（2469/2469、350/350、tsc 0、smoke OK）。
- **文档与实现一致**：✅ 保持勾选。CHANGELOG Batch 36–39 小节在位（Batch 37 一节经恢复事故后 diff 复验只有 8 行新增）；KNOWN_LIMITATIONS attestation/sandbox/§81 条目均为新口径；Batch 37 收口时 CHANGELOG 被收口脚本截断清零的事故已恢复并记入 `~/AGENTS.md` 铁律。
- **独立复核**：✅ 保持勾选，追加：Batch 36（REAUDIT_BATCH36.md，偏差 0）、Batch 37（REAUDIT_BATCH37.md，偏差 0）、Batch 38（REAUDIT_BATCH38.md，偏差 0）。**Batch 39 的独立复核（40-1）在本轮复验时仍在途**，本报告不代其背书。

## D. 商业化最小要件

- **版本号与 CHANGELOG**：✅ 保持勾选。版本仍 0.1.0；CHANGELOG 按批维护。
- **许可证**：**仍待 Tan 拍板**（无变化）。`docs/release/LICENSING_OPTIONS.md` 在位；仓库无 LICENSE 文件是刻意状态（默认保留所有权利）。
- **定价/分发渠道**：**仍待 Tan 拍板**（无变化）。

## 建议的清单勾选更新（相对 35-4，本报告只建议、不改文件）

1. B-剩余缺口列表："§81 其余五个触发器无确定性发射点" → "**其余四个**"（4/8 已发射：ai-disagreement Batch 36、budget-exceeded/repeated-failure Batch 38、high-risk-deployment Batch 39）；"SBOM attestation 仍 null" → "dev 路径已关闭（Batch 38）+ retention（Batch 39），**生产签名待 Tan 密钥决策**"；已关闭列表追加：MCP 真实第三方服务器握手（Batch 37）、构建沙箱 bubblewrap（Batch 37）、§81 needsHuman 发射路径（Batch 36/38/39，4/8）。
2. C-测试基线：→ 基线 `59eb7a0`：包套件 2469/2469，服务端全套 350/350，desktop tsc 0，smoke:boot OK。
3. C-独立复核："Batch 22–37" → "**Batch 22–38** 每批独立复核全成立（…Batch 36/37/38 偏差 0 处）；Batch 39 复核在途"。
4. 顶部新增"当前状态（2026-10-14，Batch 40 复验，基线 59eb7a0）"小节（结论见下）。

## 总结论

- **翻绿项（4，大项）**：B-剩余缺口继续收敛——Batch 37 关闭 MCP 真实握手与构建沙箱（两个长期环境项）；Batch 38/39 关闭 SBOM attestation dev 路径并纳入 retention；§81 needsHuman 发射面从 1/8 扩大到 **4/8**（ai-disagreement、budget-exceeded、repeated-failure、high-risk-deployment，均为确定性发射点+落库+测试钉住）。
- **仍卡项（硬卡点全在 Tan 一侧或环境项，无变化）**：A-真实模型回路（卡 Codex 登录，Tan 本人动作）；A-桌面分发 Windows/macOS + 代码签名（环境/采购）；D-许可证/定价/渠道（Tan 决策）；B-剩余：§81 其余四个触发器（诚实不接，各有精确原因）、非 Codex 适配器 stub、远程数据库驱动、merge queue 多机、Windows 工具探测、桌面真人验收、attestation 生产签名；CI 在 GitHub 从未运行过。
- **当前仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 测试全绿（2469/2469、350/350）、文档诚实、Batch 22–38 独立复核 0 偏差，但决定"卖"的硬门槛——真实模型回路（Codex 登录）、三平台分发+签名、许可证/定价/渠道——一项没动；这些全部需要 Tan 本人动作或外部环境，代码侧已无可代劳的路径。
