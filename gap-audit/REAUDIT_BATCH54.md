# Batch 54 独立复核报告（Batch 55-1）

- 基线：`7e96bfe`（Batch 54 收口 commit）
- 复核方式：`git worktree add /tmp/reaudit-b54 7e96bfe` 隔离 worktree 亲读 + 亲跑，主树零干扰；`dist/`/`node_modules` 软链自主树（同 commit），`packages/*/dist` 同样软链。
- 结论：Batch 54 的实质声明全部成立。**偏差 0 处。**

## (a) verify leg 走查——成立

- 全文亲读（`apps/server/tests/first-run-walkthrough-audit-verify.test.ts`）：V1/V2/V3 全部真实——纯 HTTP、零 mock、真实编译 server + 新鲜 temp SQLite；hermetic（temp DB + temp `FACTORY_SECRETS_DIR`）；dual-mode 合规（node builtins + fetch + `node:sqlite`，零 src import）。
  - V1：3×`POST /api/projects` → `GET /api/audit/verify` → 200、`ok:true`、`verifiedCount ≥ 3`、`legacyCount:0`、无 `brokenAt` 键。
  - V2：`GET /api/audit?limit=200`（F21 裸数组）反转为追加序，按 id 找中点记录，第二个 `node:sqlite` 连接直接 `UPDATE audit_logs SET details`（"有 DB 访问权的攻击者"，故意没有 HTTP 篡改路径，10 次重试卫生）→ `GET /api/audit/verify` → 200、`ok:false`、`brokenAt` 恰好等于中点下标、`verifiedCount` 恰好等于断裂前记录数。注：V2 只测 `?limit=1`，`?offset` 拒绝由 Batch 53 的 contract test（`audit-chain-verify.test.ts`）钉住——不重复测试，不算缺口。
  - V3：`?limit=1` → 400 `AUDIT_VERIFY_NO_PAGINATION`。
- 亲读确认：实现位置与 Batch 53 复核一致（`apps/server/src/index.ts:1613–1631`、auth `494` → operator）。
- F35–F37 在 `docs/FIRST_RUN_WALKTHROUGH.md` 第 761/769/776 行在位；"audit-chain verify leg (Batch 54)" 节（第 736 行起）含 V1–V3 表 + 1/1×3 声明 + detection-not-prevention 边界。
- 亲跑：**1/1 连续 3 次**（每次 ~2s，0 fail）。

## (b) 桌面审计链截图——成立

- `gap-audit/walkthrough-auditchain-panel.png` 在位；实际查看：1279×995 真 PNG，Ops tab 高亮，「审计链完整性（§32）」Block + 「拉取全链验证」按钮 + 绿色「✅ 链完整：已验证 17 条」全在渲染，与报告逐条一致，无美化。

## (c) KNOWN_LIMITATIONS 扫荡——成立

8 处改动逐一代码交叉验证：

| # | 条目 | 实证 |
|---|------|------|
| 1 | §33 item ② 预置定义已关闭（Batch 49） | `apps/server/src/routes/tools.ts` 头注释："Batch 49 — the 16 builtin §33 definitions are pre-registered at boot" + 诚实口径（定义≠实现） |
| 2 | F14 已关闭（Batch 49） | `apps/server/src/routes/runtime.ts:6/339/1199` 明确标注 Batch 49 (F14) |
| 3 | env-error HTTP 阳性路径无 → Batch 50 钉为显式负向对照 | KL 更新后的措辞与 F28（走查文档第 604 行 S8）一致，S8 是翻转点 |
| 4 | 走查版本第八版 + 独立走查链路 + B52 总览索引 | `docs/FIRST_RUN_WALKTHROUGH.md` 顶部索引表 + F33 已于 B53 关闭（第 723 行） |
| 5 | 结论基线 → `fc45007`（2517/2517、458/458） | 数字与 Batch 53 收口亲验一致（Batch 54 的 459/459 将在 Batch 55 收口时更新，不算滞后） |
| 6 | Electron 未真人点击验收保留 + B51/B52 真机走查注记 | 措辞仍诚实，边界（Linux+Xvfb dev 模式）明确 |
| 7 | §32 verify 端点（Batch 53）+ detection-not-prevention + 不是第三方公证 | 实现亲验（见 (a)）；"证明的是'从 genesis 到现在的记录没被改过'，不是'记录反映了真实发生的事件'"——措辞诚实 |
| 8 | redaction 升级路径走查证据（Batch 51） | 测试文件在位；走查文档 E1–E4/F30/F31 在位 |

抽查中发现**一处 KL 措辞的既有小缺口（非 Batch 54 偏差）**：§81 需要升级条目里"**§81 八个触发器已全部接上（8/8）**"与"env-error 的 HTTP 阳性路径不存在"是相邻段落写的，接线（builder wired）≠ 可达（HTTP triggerable），但措辞本身没有断言"8/8 经 HTTP 可触发"——F28/B50 的 7/8 边界在另一处明确记录。不算虚假声明，不建议强行改写。

## (d) 卫生注记——总览表仍滞后（pre-existing，不是 Batch 54 偏差）

- 文档顶部仍题为 "# Walkthrough index (Batch 51)" / "## Findings index (F1–F31)"——Batch 52 的 audit-chain leg（F32–F34）、Batch 53 的 F33 closed、Batch 54 的 verify leg（F35–F37）都未进入总览表/索引。
- Batch 52–54 的 commit message 都没声称更新过总览表，所以是文档滞后（pre-existing staleness），不是虚假声明。建议 Batch 55 把总览表和 findings 索引补到 Batch 54。

## commit 文件清单亲验

`git show --name-only HEAD`：恰好 6 个文件（`CHANGELOG.md`、`apps/server/tests/first-run-walkthrough-audit-verify.test.ts`、`docs/FIRST_RUN_WALKTHROUGH.md`、`docs/KNOWN_LIMITATIONS.md`、`gap-audit/REAUDIT_BATCH53.md`、`gap-audit/walkthrough-auditchain-panel.png`）。零产品代码改动，无意外文件。

## 真实验证数字汇总（隔离 worktree @7e96bfe）

- verify leg 走查测试：**1/1 × 3**，0 fail
- 截图：1 张 PNG 实际查看，内容与报告一致
- KL 扫荡：8/8 改动有代码实证

**偏差：0 处。**
