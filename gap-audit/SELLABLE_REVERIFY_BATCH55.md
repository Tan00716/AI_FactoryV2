# 可售清单第七轮全面复验（基线 `4f393a9`，Batch 55 收口，本地）

> 复验日期：2026-10-15。复验方式：`git rev-parse HEAD` 确认基线 `4f393a9`（"Batch 55: Batch54 独立复核 / 走查总览补到 Batch 54 / 周期审计链自检 / docs 断链修复"）；工作树亲验干净（仅 `.github/` 未跟踪，与历轮一致）；
> 对第六轮（Batch 52，`7eadda6`）以来的全部新增交付物做文件存在性 + 内容亲读（grep 亲验关键断言与结论措辞）；
> 全量测试数字引用 Batch 53/54/55 收口人主线亲验（兄弟任务在途时不重跑全套，避免混合口径），复核人此前各轮已亲跑验证。
> 零产品代码改动。未 commit。
> **特别说明**：2026-10-15 Tan 新指令——开发本地进行、先不上传 GitHub，完成后报告再问是否上架。所以本轮基线 `4f393a9` 是**本地 commit**，远端 main 仍为 `7e96bfe`（Batch 54）。以下复验针对本地 `main`。

## 复验方式与基线

- HEAD：`4f393a9`（Batch 55）；链：`7eadda6` → `fc45007`（Batch 53）→ `7e96bfe`（Batch 54）→ `4f393a9`（Batch 55），本地四连 commit 连续无断档。
- `CHANGELOG.md` 头部亲验：`## Batch 53` / `## Batch 54` / `## Batch 55` 三节在位。
- 测试数字（引用收口人主线亲验）：
  - Batch 53 收口：根 build 0 错误；`npm test` 2517/2517；服务端全套 458/458（+4 verify 端点 contract test）；desktop tsc 0；smoke:boot OK。
  - Batch 54 收口：根 build 0 错误；`npm test` 2517/2517；服务端全套 459/459（+1 verify leg 走查）；desktop tsc 0；smoke:boot OK。
  - Batch 55 收口：根 build 0 错误；`npm test` 2517/2517；服务端全套 465/465（+6 周期审计链自检测试）；desktop tsc 0；smoke:boot OK。

## 翻绿项（相对第六轮，Batch 52 基线 7eadda6）

1. **operator verify 端点**（Batch 53，**F33 关闭**）：`GET /api/audit/verify` 在位（`apps/server/src/index.ts`；亲验返回裸 `audit.verify()`、分页 → 400 `AUDIT_VERIFY_NO_PAGINATION`、注释明确 F33 教训）；`auth.ts` 规则 `path === '/api/audit/verify' → operator` 在位；`audit-chain-verify.test.ts` 在位（contract test 4 个 it：完好链 ok:true / 直接篡改 → ok:false+brokenAt / 分页拒绝 / viewer 403 + operator 200）。走查文档 Batch 53 update 块 + F33 "Closed by `GET /api/audit/verify` (Batch 53)" 在位；backup-restore-guide §6 审计链自检小节在位。
2. **桌面审计链验证入口**（Batch 53）：`api.ts` 的 `AuditChainVerification` 接口 + `auditVerify` 在位；`OpsPanel.tsx` 的 `<Block title="审计链完整性">` 在位（状态机 idle→loading→ok/broken/error，未暴露 limit 参数）；REAUDIT_BATCH53 亲验 tsc 0。
3. **audit-chain verify leg 走查**（Batch 54）：`first-run-walkthrough-audit-verify.test.ts` 在位（V1 完好链 → ok:true；V2 第二个 `node:sqlite` 连接篡改中点 → ok:false + `brokenAt` 恰好等于中点下标；V3 `?limit=1` → 400）；走查文档 'audit-chain verify leg (Batch 54)' 一节 + **F35–F37** 在位。
4. **桌面审计链 Block 真机截图**（Batch 54）：`walkthrough-auditchain-panel.png` 在位（1279×995 真 PNG；亲验内容：Block「审计链完整性（§32）」+「拉取全链验证」按钮 + 绿色「✅ 链完整：已验证 17 条」；如实记录：token-less 本地 server，门控放行，不是 viewer 角色场景；边界：Linux+Xvfb dev 模式）。**桌面真机截图累计 5 张**（needs-human ×2 + BackupPanel ×2 + 审计链 ×1）。
5. **KNOWN_LIMITATIONS 诚实性扫荡**（Batch 54，Batch 48 同款）：8 处改动全部亲验有代码实证（tools 预置定义闭合+诚实口径、F14、§81 env-error 负向对照、走查第八版+总览、基线数字、Electron 壳保留诚实、verify 端点"不是第三方公证"新增、redaction 升级证据新增）。
6. **走查文档总览补到 Batch 54**（Batch 55）：'Walkthrough index (Batch 54)' 亲验在位（新增 3 行：audit-chain leg B52 / verify endpoint B53 / verify leg B54，Batch 51 同款格式）；'Findings index (F1–F38)' 亲验在位（F32 open、F33 closed B53、F34 hygiene、F35 open、F36 open、F37 hygiene、**F38 closed B55**）。
7. **周期审计链自检**（Batch 55，**F36 的未来项落地**）：`apps/server/src/audit-chain-watch.ts` 在位；`index.ts` 接线亲验（`FACTORY_AUDIT_CHAIN_WATCH !== '0'` 则默认开启，启动时检查 + setInterval + unref）；设计决策亲验：进程内调 `audit.verify()`（绝不 HTTP 回环）、复用 §81 `needsHuman('security-issue')` 写透路径（不另起炉灶）、`requiredDeciderLevel: 'operator'`、健康 tick 静默、断链先记 `AUDIT_CHAIN_VERIFY_FAILED` 再升级、去重（同 source 最多一条 OPEN）。`audit-chain-watch.test.ts` 在位（6 个测试）。文档：FIRST_RUN_WALKTHROUGH.md（F38 + findings index F1–F38）、backup-restore-guide.md §6、KNOWN_LIMITATIONS.md §32 第 ④ 点。**真机启动验证**：篡改 DB 启动 → 恰好 1 条 OPEN security-issue（`AUDIT_CHAIN_VERIFY_FAILED` + `NEEDS_HUMAN_RAISED` 各 1 条，直接查 DB 确认）；健康 DB → 静默；`WATCH=0` → disabled 日志。诚实边界：仍是 detection-not-prevention；仍是服务端本地链；60s 间隔内的篡改要到下个 tick 才显形。
8. **docs 交叉引用断链修复**（Batch 55）：报告 `SELLABLE_REVERIFY_BATCH52.md` 亲读（上一轮方式是本轮模板）——55-4 结论：真实断链 0 处；修复 10 处文档滞后（KNOWN_LIMITATIONS.md 3 处 + SELLABLE_CHECKLIST.md 7 处），本轮已亲验 checklist 7 处全部在位。
9. **独立复核**：`REAUDIT_BATCH52.md` / `REAUDIT_BATCH53.md` / `REAUDIT_BATCH54.md` 全部在位，结论均为 0 偏差；**REAUDIT_BATCH21–54 连续无断档**。

## 新增真实缺口

**0 项**。Batch 53–55 挖出的 F35–F38 均为 Info 级（F35 operator-role note、F36 point-in-time、F37 brokenAt 追加序、F38 周期自检默认开启），F33 已关闭；无新增产品缺口。

## A. 真实可用 — verdict

- **真实模型回路**：**仍 BLOCKED，无变化**。`packages/runtime/src/adapters.ts` 的 StubAdapter 亲验仍在（7 处引用）；卡点未变（Codex 登录需 Tan 本人执行 `codex login --device-auth`）。
- **桌面应用可分发**：**仍只在 Linux 亲验，无变化**。唯一亲验过的仍是 Linux AppImage；Windows/macOS 安装包 + 代码签名仍待 Tan/环境。新增诚实进展：桌面三面板（needs-human 只读面板、BackupPanel、审计链 Block）已有真机截图走查（Linux+Xvfb dev 模式，5 张 PNG），但**仍不是打包后 AppImage 的双击体验**，Windows/macOS 真机仍未验证。
- **首次运行体验**：**走查继续累积**——v8（`demo:e2e-v8` 1/1×4）+ redaction leg（1/1×3）+ §81 full-trigger sweep（1/1×3，7/8 阳性+S8 负向对照）+ redaction→needs-human escalation leg（1/1×3）+ audit-chain integrity leg（1/1×3）+ audit-chain verify leg（1/1×3，V1–V3）+ 周期审计链自检（真机启动验证）。**仍只覆盖 API 层**，无真机桌面点验（桌面截图走查是 UI 层但 dev 模式）。走查总览 14 行 + Findings F1–F38。
- **关键数据可持久**：保持勾选，无新增持久化面变化。

## B. 规格完整度 — verdict

- **13 项硬阻塞（Tan/环境侧）**：亲验仍全部成立，一项没动——Codex 登录→真实模型 turn、非 Codex 模型适配器仍 stub（StubAdapter 在位）、Windows/macOS 安装包+代码签名、桌面真人点击验收未做、许可证/定价/渠道待 Tan 拍板、CI workflow scope（`.github/` 亲验仍为本地未跟踪 `??` 状态，GitHub CI 从未运行）、MCP SSE/HTTP/OAuth、无真实隔离 Host、生产 attestation 签名待 Tan 密钥决策、Windows 工具探测未真机验证、远程数据库驱动/merge queue 多机 M2 待 Tan 拍板、无测试生产环境、AT-001–AT-064 正式验收（275 条资产不存在，NOT_RUN）。
- **6 项代码侧刻意不做**：REAUDIT_BATCH49 已逐项亲读论证站得住（db.query DENY 分层、mcp.call definition-only、reconcile 只报告、Board v1 需 UI gate、F20 产品规则、env-error HTTP 阳性路径不伪造立场不变），本轮未发现动摇证据。
- **§81 八个触发器**：全部接上且 narrative 活过持久化（8/8，Batch 45 F19 关闭）；Batch 50 走查钉住 7/8 经纯 HTTP 可达 + 第 8 个（irrecoverable-env-error）是钉死的负向边界（S8 是未来翻转点）。Batch 55 新增 §81 发射点：**周期审计链自检断链 → security-issue**（`audit-chain-watch` source，operator，critical；恰好 1 条 OPEN，去重；`AUDIT_CHAIN_VERIFY_FAILED` + `NEEDS_HUMAN_RAISED`）。
- **merge queue 多机**：口径不变（M1 单写者开关已落地；M2 待 Tan 拍板；部署建议单实例）。

## C. 质量与可信 — verdict

- **全量测试持续全绿**：基线 `4f393a9`（本地），根 build 0 错误；`npm test` 2517/2517；服务端全套 465/465；desktop tsc 0；smoke:boot OK（引用 Batch 55 收口人主线亲验；独立复核 REAUDIT_BATCH54 的隔离 worktree 数字一致）。
- **文档一致**：CHANGELOG Batch 53–55 小节在位；KNOWN_LIMITATIONS 经 Batch 54 扫荡 + Batch 55 断链修复后本轮抽查在位（verify 端点"不是第三方公证"、周期自检第 ④ 点）；走查文档 v8+legs+14 行总览+Findings F1–F38 全部在位。
- **独立复核**：Batch 52/53/54 追加，全部 0 偏差；**REAUDIT_BATCH21–54 连续无断档**。

## D. 商业化 — verdict

- 版本 0.1.0 + CHANGELOG Batch 53–55 小节在位。
- **许可证仍待 Tan 拍板**：仓库无 LICENSE 文件是刻意状态（亲验仍不存在）。
- **定价/分发渠道仍待 Tan 拍板**。

## 总结论

**仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 相对第六轮翻绿 9 项（operator verify 端点 F33 关闭、桌面审计链验证入口、verify leg 走查、桌面审计链 Block 真机截图、KNOWN_LIMITATIONS 扫荡、走查总览补到 Batch 54、周期审计链自检、docs 断链修复、Batch 52–54 独立复核 0 偏差）；新增真实缺口 0 项（F35–F38 均为 Info）。决定"卖"的硬门槛——真实模型回路（Codex 登录）、三平台分发+签名、许可证/定价/渠道——一项没动，全部需要 Tan 本人动作或外部环境；代码侧已无可代劳的路径。**补充**：本轮基线是本地 commit（4f393a9），按 Tan 2026-10-15 指令先不推送 GitHub；远端 main 仍为 `7e96bfe`。
