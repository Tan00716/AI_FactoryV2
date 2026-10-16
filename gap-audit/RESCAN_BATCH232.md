# Batch 232 实质性重新扫描（非复核批）——代码侧可执行工作判定

> 扫描基线：本地 main `6f24119`（Batch 231）；B96 基线 `44ef111`。只读扫描，未改代码、未 commit。
> 结论先行：**代码侧可执行事项：无**。仅发现 3 处文档侧滞后（1 批可清）。13 硬门槛 12/13 仍在 Tan/环境侧，第 13 项（AT）经 B106 筛选→B107 落地→B109 纠偏后已无高置信度可晋升项。

## 1. 代码 vs SPEC_V2：10 个 invariants 抽查 + 回归判定

**回归判定（最强证据）**：`git log 44ef111..HEAD -- apps/ packages/` 为空——B96（CORS 修复+AppImage 重打）之后 135 个 commit，**产品运行时代码零改动**。B100 的三套全量亲跑（build 0 / npm test 2593/0 / test:server 500/500）至今仍完整描述当前代码，不可能有回归。

10 个 invariants 机制在位抽查（均为当前树亲验）：

| INV | 机制 | 位置 | 状态 |
|---|---|---|---|
| INV-03 | engine 决定状态，AI 只提交请求 | `apps/server/src/index.ts` `engine.requestTransition` | ✓ 在位 |
| INV-04 | Gate 看可验证证据；caller 证据标注 `evidence_source: 'caller-supplied'`，不与 server-verified 混淆 | `routes/gates.ts` 头注释+实现 | ✓ 在位 |
| INV-05 | 权限校验覆盖 Shell/MCP/API 全路径 | `packages/policy` `checkCapability`；AT-005 逻辑验收 5/5（B107） | ✓ 在位 |
| INV-06 | §17.2 授权轴：未 AUTHORIZED 的任务 `POST /transition` → 403 `TASK_NOT_AUTHORIZED`，fail-closed | `index.ts:1240`（F61，B75） | ✓ 在位 |
| INV-14 | 外部内容视为 hostile 数据；import 包先 DRAFT/QUARANTINED，权限重映射为本地 grant | `packages/project-io/src/untrusted-import.ts` | ✓ 在位 |
| INV-16 | 审计链 60s 自检；断链 → `AUDIT_CHAIN_VERIFY_FAILED` | `audit-chain-watch.ts`（F36） | ✓ 在位 |
| INV-18 | 委托受 §12.2 约束；超限 `SCOPE_VIOLATION`/`BUDGET_EXCEEDED` 在落库前抛出 | `delegation-service.ts` + `@ai-factory/orchestrator` DelegationManager | ✓ 在位 |
| INV-21 | `idempotencyKey` 透传 v2 transition；engine 幂等结果缓存 | `routes/v2-transitions.ts:564,637` | ✓ 在位 |
| INV-26 | 凭证脱敏 `redactSecretValues` + 命中聚合监控（只计数不带内容） | `redaction-monitor.ts` | ✓ 在位 |
| INV-32 | CANCELLED/REJECTED/BLOCKED 映射为 TODO 阶段 + 独立 condition，不等于 PASS/DONE | `routes/v2-transitions.ts:150-180` | ✓ 在位 |

**无 spec 漂移。** 抽查的 transition / approvals / authority / session 关键路径与 SPEC_V2 一致。

## 2. SELLABLE_CHECKLIST：2 处滞后（文档侧）

文件：`~/workspace/goals/ai-factory-app-prototype/files/SELLABLE_CHECKLIST.md`（repo 外）

1. **顶节"当前状态"停在 Batch 100（基线 `fb6ed6c`）**：引用 `test:acceptance` 121/121、AT 逻辑层 21/64。B107 已推进到 **138/138、24/64、NOT_RUN 40**（`9ed15c3`），清单未同步。
2. **"剩余缺口"节**仍写"Batch 80 更新：21/64……43 项仍 NOT_RUN"——同上，应为 24/64、40 项。

→ 可执行：新增一节"当前状态（Batch 107+ 收口）"。代价：小，纯文档，1 批。

## 3. 13 硬门槛逐项（B106 重审结论仍成立）

| # | 门槛 | 状态 |
|---|---|---|
| 1 | Codex device login → 真实模型 turn | Tan 本人，未动 |
| 2 | 非 Codex 适配器 stub | 需 API key，未动 |
| 3 | Windows/macOS 包+签名 | 需机器/证书，未动 |
| 4 | 桌面真人点击 | 需 Tan/真机，未动 |
| 5 | 许可证/定价/渠道 | Tan 决策，未动 |
| 6 | CI workflow scope | token 缺 scope，未动 |
| 7 | MCP SSE/HTTP/OAuth | 无真实 server 可验（stdio 是真实实现）；自写 loopback server 验自己=伪验证，不做 |
| 8 | 真实隔离 Host | 需 infra，未动 |
| 9 | 生产 attestation | Tan 密钥决策，未动 |
| 10 | Windows 工具探测 | 需真机，未动 |
| 11 | 远程 DB/多机 M2 | 需 Tan 拍板，未动 |
| 12 | 测试生产环境 | 需 infra，未动 |
| 13 | AT-001–AT-064 | 见下：B106→B107→B109 后无高置信度可晋升项 |

**AT-001–AT-064 独立复核（针对"NOT_RUN 里有没有纯逻辑可转"）**：
- 现状：24/64 逻辑层可执行（`npm run test:acceptance` 138/138，B107 亲跑），40/64 NOT_RUN（`docs/testing/v2/ACCEPTANCE_INDEX.md`，逐项原因已记录）。
- B106 筛 26 候选 → B107 按 B80 严格标准分析 14 → 晋升 3（AT-005 越权拒绝 / AT-009 MCP 故障注入 / AT-041 证据不可篡改，+17 断言）→ 11 维持（011/012 真实隔离 Host、029 真实 Worker、032 真实模型额度、044 缺网络层、048/051/059 需真实故障注入、060/063/064 无包 API）→ B109（`ceeb226`）纠偏确认另 12 个（001/002/003/004/010/015/017/019/021/022/024/027）在 B106 筛选阶段已正确排除（真实执行类）。
- 本次独立再看最可疑的漏网项：**AT-058（Webhook 去重/验源）**——`packages/notifications` 有 §32 去重逻辑（`dedupeWindowMs`），但"验源"无 HMAC 公共 API，按 B80"判定断言必须被逻辑层完整覆盖"标准过不了。**不建议立项**。
- 结论：40 项 NOT_RUN 的真实环境原因逐项成立，无纯逻辑可转项。正式端到端验收仍为 0/64（如实）。

## 4. 测试/文档/安装包证据新鲜度

| 证据 | 基线 | 新鲜度 |
|---|---|---|
| `npm run build` 0 错误 | B100（`fb6ed6c`） | ✓ 有效（代码零改动） |
| `npm test` 2593/0 | B100 | ✓ 有效 |
| `npm run test:server` 500/500 | B100（B96 重跑确认 CORS 无回归） | ✓ 有效 |
| `npm run test:acceptance` 138/138 | **B107**（`9ed15c3`，最新） | ✓ 有效 |
| desktop/server tsc 0 | B100 | ✓ 有效 |
| smoke:boot OK | B81 | ✓ 有效（server 未动） |
| AppImage `~/b96-pkg/` 130,192,527 bytes | B96（`44ef111`，含 B95 CORS 修复） | ✓ 与当前运行时代码一致（零改动）；本机无 FUSE 未执行本体（既有边界） |
| `docs/USER_GUIDE.md` | B98 dogfood 走查 | ✓ 有效（代码未动） |
| `docs/FIRST_RUN_WALKTHROUGH.md` | B92 | 内容实质仍准（高层流程未变） |
| `docs/KNOWN_LIMITATIONS.md` | B92 | **2 处滞后**（见下） |

**KNOWN_LIMITATIONS.md 滞后（文档侧，可执行）：**
1. 第 11 条（/tmp tmpfs）："teardown 自动清理 mkdtemp 的修复待做（Batch 73-2 方向），未落地前这是硬要求"——**已过时**。B73（`be15336`）已落地中央 TMPDIR wrapper（`scripts/run-tests-tmp.mjs`），且 `test`/`test:server`/`test:acceptance` 三处 package.json 脚本均已接入。应改为"已根治（B73），裸跑 node --test 仍建议设 TMPDIR"。
2. 第 9 条（Linux 安装包）："Batch 25；Batch 30 在当前树复验"——**已过时**。AppImage 已在 B70/B77/B85/B96 重打，当前 `~/b96-pkg/` 130,192,527 bytes（含 B95）。应更新 batch 号与字节数。

## 5. 结论：可执行事项清单

**代码侧可执行事项：无。** 产品运行时代码自 B96 起零改动，10 个 invariants 机制在位，B100 全量基线仍然有效；13 硬门槛 12/13 在 Tan/环境侧，第 13 项经三轮筛选已无高置信度可晋升项；F58（DATA_EXPORT 阻塞式门控）等 open findings 均为"刻意不做/by-design"或待 Tan 决策。

**文档侧可执行事项（共 3 处，建议 1 批清掉）：**
1. `SELLABLE_CHECKLIST.md` 新增"当前状态（Batch 107+）"节：acceptance 138/138、AT 24/64、NOT_RUN 40；同步"剩余缺口"节的 21/64→24/64、43→40。
2. `docs/KNOWN_LIMITATIONS.md` 第 11 条：/tmp 修复已落地（B73），改写过时表述。
3. `docs/KNOWN_LIMITATIONS.md` 第 9 条：Linux 包重打历史更新到 B96（130,192,527 bytes）。

代价估计：1 个文档批，无产品代码改动，无需重跑全量测试（`git log` 亲验范围即可）。

**诚实边界重申**：仍是"可运行的原型 + 持续收敛"，不是可交付产品——真实模型回路、三平台分发+签名、许可证/定价/渠道、CI、正式 AT 端到端 0/64，一项没动，全在 Tan/环境侧。
