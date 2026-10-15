# Batch 56 独立复核（Batch 57-1）

- **基线**：`a43bbec`（Batch 56 本体）。
- **方式**：隔离 worktree（`/tmp/reaudit-b56`，detached HEAD `a43bbec`；`apps/server/dist` + `node_modules` 软链自同 commit 的主树，主树零干扰）。复核人亲读 + 亲跑。
- **结论**：Batch 56 的四项实质声明全部成立。**偏差 0 处。**

## (a) audit-chain watch leg 走查——成立

- 全文亲读 `apps/server/tests/first-run-walkthrough-audit-chain-watch.test.ts`：A（健康 DB 启动 + 3×`POST /api/projects` → `GET /api/needs-human?status=open` → 0 条）、B（第二个 `node:sqlite` 连接篡改中部记录 → 同 DB 重启 → 恰好 1 条 OPEN `security-issue`：`source=audit-chain-watch`、`severity=critical`、`requiredDeciderLevel=operator`；`detailJson.narrative` 含 BROKEN / "Human judgment needed" / append-order 声明、不含注入载荷 `tampered`；`AUDIT_CHAIN_VERIFY_FAILED` 恰好 1 次、`NEEDS_HUMAN_RAISED` 在位）、B2（链仍断时再次重启 → 仍恰好 1 条，无风暴）、C（`FACTORY_AUDIT_CHAIN_WATCH=0` → 0 条；对照 `GET /api/audit/verify → ok:false`，证明 0 条是 opt-out 而非篡改失败）全部真实——纯 HTTP、零 mock、真实编译 server 进程 + 新鲜 temp SQLite，hermetic + dual-mode 合规（node builtins + fetch + `node:sqlite`，零 src import）。
- **Boot-path 选择诚实**：测试头注释 + 走查文档都明说"选了真实启动完整 server 进程（`spawn(dist/index.js)`），不是模块级 tick"——因为被声称的行为是"server 启动时自检"，最接近真实启动路径的是实际 boot；代价 ~9s vs ~1s、外加 SIGTERM/端口重绑操作面，全部明说。60s interval timer 保持默认开启，断言对多余 tick 免疫（dedupe 保证 OPEN ≤ 1、证据只写一次）。
- **亲跑：1/1 连续 3 次，0 fail**（每次 ~9.5s，与声称的 ~9s 一致）。
- F39–F40 在 `docs/FIRST_RUN_WALKTHROUGH.md` 正文（第 857/865 行）与 Findings index（F1–F40，第 74/75 行）在位；走查文档 diff 只有 index 行替换（+58/−2），正文未动。

## (b) 桌面两张真机截图——成立

两张都是 1279×995 真 PNG，**都亲自查看**：

- `walkthrough-needshuman-auditwatch.png`（162593 bytes）：NeedsHuman tab 高亮，"共 1 条 OPEN 记录"；卡片 `security-issue 安全问题·严重度严重`，"触发于 10/15/2026, 1:01:49 AM · 来源 audit-chain-watch · 解决需 operator 级别"；narrative 全文完整渲染（"Periodic audit-chain self-check found the §32 hash chain BROKEN at append-order index 9 (9 record(s) verified before the break)… Human judgment needed."）；底部 AI Activity 流可见 `AUDIT_CHAIN_VERIFY_FAILED` + `NEEDS_HUMAN_RAISED`。与报告逐条一致。
- `walkthrough-auditchain-broken.png`（193037 bytes）：Ops tab → 「审计链完整性（§32）」Block → 「拉取全链验证」按钮 → 红色告警：'❌ 审计链断裂：首个失败位于追加序下标 9（按 ORDER BY ts, rowid，非列表新在前序）—— 断裂前 9 条已验证，断裂后的记录不可信。detection-not-prevention：链阻止不了 DB 写者，它让篡改显形并定位。'与报告逐字一致。

## (c) 可售清单第七轮复验——抽查成立

- "翻绿 9 项"逐条可定位：① verify 端点（`index.ts:1661–1669` + `auth.ts:494` → operator）；② 桌面审计链 Block（`OpsPanel.tsx` 的「拉取全链验证」按钮，无 limit 暴露）；③ verify leg 走查测试在位；④ 5 张真机截图累计（needs-human ×2 + BackupPanel ×2 + 审计链 ×1）；⑤ KL 扫荡（8 处，抽查 tools 预置定义/F14/verifier"不是第三方公证"有代码实证）；⑥ 走查总览（'Walkthrough index (Batch 54)' 14 行 + Findings F1–F40）；⑦ 周期自检模块（`audit-chain-watch.ts` + `index.ts` 接线，`REASON_SEVERITY['security-issue']='critical'` 亲验成立）；⑧ docs 断链修复；⑨ `REAUDIT_BATCH21–55` 全部在位、连续无断档。
- "新增真实缺口 0 项"成立（F35–F40 均为 Info）。
- 硬门槛抽查：`StubAdapter` 引用仍在（Codex 未登录）、仓库无 LICENSE 文件（刻意状态）、`.github/` 仍本地未跟踪、Codex stub 措辞诚实。
- 报告口径明确：基线 `4f393a9`（Batch 55），远端 main 仍 `7e96bfe`（按 Tan 2026-10-15 暂不推送指令）——不是虚假基准。

## (d) commit 文件清单——成立

`git show --name-only a43bbec`：恰好 7 个文件（CHANGELOG.md、first-run-walkthrough-audit-chain-watch.test.ts、FIRST_RUN_WALKTHROUGH.md、REAUDIT_BATCH55.md、SELLABLE_REVERIFY_BATCH55.md、walkthrough-auditchain-broken.png、walkthrough-needshuman-auditwatch.png），无意外文件，零产品代码改动（本次 batch 的产品改动是 Batch 55 的 watch 模块）。

## 真实验证数字（隔离 worktree @a43bbec）

- watch leg 走查：**1/1 × 3**，0 fail。
- 服务端全套：**466/466**，0 fail（459 → 465 → 466 算术吻合：B55 +6 watch 测试，B56 +1 watch leg）。
- desktop tsc：**0 错误**。

（根 build 0 错误 / `npm test` 2517/2517 / smoke:boot OK 引用 Batch 56 收口人主线亲验，复核人未在隔离 worktree 重跑——服务重启期间 worktree 重建，仍基于同 commit。）

## 卫生注记（非偏差）

1. KNOWN_LIMITATIONS 第 68 行 'Findings index（F1–F37）' 仍滞后——Batch 56 报告里已经自曝（写的是"实际已 F1–F38"）；当前 walkthrough 顶部是 F1–F40，KL 滞后扩大为 F38–F40。属 pre-existing 文档滞后，不是虚假声明。
2. CHANGELOG Batch 56 小节里 B 的括号 "（server 活着时走 HTTP 拉列表取 id，停服后篡改）" 措辞混乱——最终代码是篡改在**停服前**完成（`tamperMiddleRecord` 在 `stopServer` 之前调用；同一小节稍后 "改成篡改在停服前完成" 说得对）。措辞 slip，不影响任何验证结论。

**偏差：0 处。**
