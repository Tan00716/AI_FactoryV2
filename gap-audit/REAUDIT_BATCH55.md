# Batch 55 独立复核报告（REAUDIT_BATCH55）

- 基线：`4f393a9`（"Batch 55: Batch54 独立复核 / 走查总览补到 Batch 54 / 周期审计链自检 / docs 断链修复"）
- 方式：隔离 worktree（`/tmp/reaudit-b55`，detached HEAD `4f393a9`；`node_modules`/`packages/*/dist`/`apps/server/dist` 软链自主树，主树零干扰），亲读 + 亲跑；worktree 已删。
- 结论：**Batch 55 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

## (a) 周期审计链自检（产品代码改动）——成立

**亲读 `apps/server/src/audit-chain-watch.ts`（全文件 220 行）：**
- **默认开启 fail-closed**：接线块是 `if (process.env.FACTORY_AUDIT_CHAIN_WATCH !== '0')`（无变量 → 开启）；无效 interval（`parseAuditChainWatchIntervalMs`：非有限/零/负 → 回退 60000）不断检查。`FACTORY_AUDIT_CHAIN_WATCH=0` 可关，有 disabled 日志。✓
- **内部 `audit.verify()`，零 HTTP 回环**：`tickAuditChainWatch` 直接调 `deps.audit.verify()`；注释明确"a loopback would add auth/network failure modes"。✓
- **§81 写透路径，不另起炉灶**：`emitAuditChainBreakNeedsHuman` = needsHuman store insert-only submit + `NEEDS_HUMAN_RAISED` 审计；失败记 `NEEDS_HUMAN_PERSIST_FAILED` 永不抛。与 `apps/server/src/brute-force-emission.ts` 注释的同一契约（submit + RAISED / 失败 PERSIST_FAILED）一致。✓
- **去重**：`list('open').some(r => r.source === 'audit-chain-watch')`，已 OPEN 不再 raise；resolve 后链仍断 → 下一 tick 重报。无风暴。✓
- **F19 narrative 持久化**：`buildAuditChainBreakRecord` 的 narrative 进 `detailJson.narrative`（JSON 结构化），含 append-order 声明（F37）、detection-not-prevention（Batch 52）、本地链非第三方公证。`context` 字段全为 `Record<string,string>`（`String(...)` 包裹），与 `NeedsHumanOptions.context` 类型一致。✓
- **`requiredDeciderLevel: 'operator'`**：硬编码，与 verify 端点角色门控一致；模块注释写明"Spec defines no risk→rank mapping; this choice is documented, not derived."——诚实。✓
- **健康静默**：`v.ok` → 直接返回 `'ok'`，零写入。✓
- **tick 永不抛**：外层 try/catch → `AUDIT_CHAIN_WATCH_ERROR`（best-effort 内层 try/catch）→ 返回 `'watch-error'`；index.ts 再加一层 try/catch（backup scheduler 同款）。✓
- **`needsHuman('security-issue', …)` 合规**：`security-issue` 是八个 §81 trigger 之一（`packages/autonomy/src/escalation.ts`），映射 severity `critical`（line 48），与 Batch 55 报告声称一致。✓

**亲读 `index.ts` 接线（595–631 行）：**
- `fdb`（258 行）/`audit`（262 行）在接线块（608 行）之前初始化；backup scheduler（576–586 行）同款模式（setInterval + unref + try/catch），注释逐项呼应模块契约。✓

**亲跑 `apps/server/tests/audit-chain-watch.test.ts`：6/6，连续 3 次全绿（0 fail）。**
六个用例逐项与报告一致：健康静默 / 篡改后恰好 1 条 OPEN security-issue（narrative 持久化）/ 无风暴 / resolve 后重报 / builder 纯函数 / 间隔解析 fail-closed。测试本身 hermetic（temp DB）+ dual-mode 合规（`.ts` 后缀 import，type-only 相对 import，包走 dist）。

**一处实现细节注记（非偏差）**：`emitAuditChainBreakNeedsHuman` 的失败分支里 `deps.audit.record` 也可能抛（audit.store 写失败时）——但 tick 的外层 try/catch 会兜住为 `'watch-error'`，"永不抛"契约成立，`AUDIT_CHAIN_VERIFY_FAILED` 的写入也有同样的"失败不阻塞告警"内层 try/catch。设计已考虑。

## (b) 走查文档总览补到 Batch 54——成立

- Walkthrough index 表头题为 `(Batch 54)`，新增 3 行（audit-chain leg | 52、verify endpoint (operator) | 53、audit-chain verify leg | 54），格式与 Batch 51 行一致；引言补 "and the audit-chain legs for B52–B54"。3 行逐行核对，数字/链路/findings 编号与正文一致。
- Findings index 标题 `(F1–F31)` → `(F1–F38)`，新增 F32–F38 共 7 行；F32 open（追加序）、F33 closed (B53)、F34 hygiene、F35 open（无 token 模式）、F36 open（point-in-time）、F37 hygiene（追加序下标）、F38 closed (B55)——与正文措辞逐字一致。
- diff 仅 +12/−3 行，正文未动。✓

## (c) docs 断链修复——成立

**`docs/KNOWN_LIMITATIONS.md`（3 处），逐项亲验：**
1. 结论基线 → `7e96bfe`（构建 0、npm test 2517/2517、服务端 459/459、tsc 0、smoke OK）= Batch 54 收口亲验数。✓
2. "首次运行走查发现"段：补 verify 端点（B53，F33 关闭）与 verify leg（B54，V1–V3，F35–F37）；总览索引口径 → 14 行 + Findings F1–F37。✓（注：此处 F38 落后，见"卫生注记"）
3. 桌面壳段 → "Batch 51/52/54"，补 OpsPanel 审计链 Block 真机截图（绿色「✅ 链完整：已验证 17 条」），边界仍是 Linux+Xvfb dev 模式。✓

**`SELLABLE_CHECKLIST.md`（7 处，goals 工作区仓库外文件），逐项 grep 亲验：**
4. A 项：补 B53 verify 端点落地 + B54 verify leg 1/1×3；"桌面三面板真机截图走查"（needs-human + BackupPanel + 审计链 Block），5 张 PNG。✓
5. B 项："走查文档总览索引补齐（Batch 55：Walkthrough index 14 行 + Findings F1–F37）"；"Batch 49–53 独立复核 0 偏差"（REAUDIT_BATCH52/53 在位亲验）。✓
6. B 项枚举中部："桌面三面板人机走查（Batch 51/52/54：5 张真机截图）"。✓
7. C 项：基线 7e96bfe / 459/459 + verify leg 1/1×3。✓
8. C 项独立复核："Batch 33–53 偏差 0 处"。✓
9. C 项 README 同步："Batch 47–54 同步"；CHANGELOG："Batch 47–54 小节在位"。✓（CHANGELOG 亲验有 Batch 50–54 小节）
10. D 项："Batch 47–54 小节已补"。✓

## (d) commit 文件清单——成立

`git show --name-only --pretty=format: 4f393a9`：**恰好 8 个文件**，无意外文件：
`CHANGELOG.md`、`apps/server/src/audit-chain-watch.ts`、`apps/server/src/index.ts`、`apps/server/tests/audit-chain-watch.test.ts`、`docs/FIRST_RUN_WALKTHROUGH.md`、`docs/KNOWN_LIMITATIONS.md`、`docs/backup-restore-guide.md`、`gap-audit/REAUDIT_BATCH54.md`。
主树 `git status` 干净（仅 `.github/` 未跟踪排除），零产品代码改动外全部在清单内。

## 真实验证数字汇总

- `audit-chain-watch.test.ts`：**6/6 × 3** 连续全绿（隔离 worktree）
- commit 文件清单：恰好 8 个文件
- index.ts 接线顺序亲验：fdb(258)/audit(262) 先于 watch 块(608)

## 卫生注记（非偏差）

- `docs/KNOWN_LIMITATIONS.md` 第 68 行仍写 "Findings index（F1–F37）"，而走查文档实际已是 F1–F38（F38 由 55-3 追加）。文档滞后 1 条，不是虚假声明（KL 同段其他口径已与 55-2 一致）。建议下批带上。
- `emitAuditChainBreakNeedsHuman` 的失败分支里 `deps.audit.record` 本身也可能抛，但外层 tick try/catch 兜住为 `'watch-error'`——"永不抛"契约成立。实现细节已记录，不算缺口。

**偏差：0 处。**
