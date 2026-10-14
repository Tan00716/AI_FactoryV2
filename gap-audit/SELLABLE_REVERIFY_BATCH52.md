# 可售清单第六轮全面复验（基线 `7eadda6`，Batch 52 收口）

> 复验日期：2026-10-14。复验方式：`git rev-parse HEAD` + `git ls-remote origin main` 确认基线一致（均为 `7eadda6`）；
> 对第五轮以来的全部新增交付物做文件存在性 + 内容亲读（grep 亲验关键断言与结论措辞）；
> 对新增的审计链走查做独立抽点亲跑（`node --test .../first-run-walkthrough-audit-chain.test.ts` → 1/1）；
> 全量测试数字引用 Batch 51/52 收口人主线亲验（兄弟任务在途时不重跑全套，避免混合口径），复核人此前各轮已亲跑验证。
> 零产品代码改动。未 commit。

## 复验方式与基线

- HEAD：`7eadda6`（"Batch 52: Batch51 独立复核 / 审计链完整性走查 / 桌面 BackupPanel 人机走查 / 走查文档总览重构"），远端 main 经 `git ls-remote` 复验一致。
- Batch 50（`f0d26df`）→ Batch 51（`4a92f6e`）→ Batch 52（`7eadda6`）三批全部在主线收口、提交、推送，提交链连续无断档。
- `CHANGELOG.md` 头部亲验：`## Batch 50` / `## Batch 51` / `## Batch 52` 三节在位。
- 测试数字（引用收口人主线亲验，复核人独立抽点 1/1 一致）：
  - Batch 51 收口：根 build 0 错误；`npm test` 2517/2517；服务端全套 453/453（+1 redaction→needs-human 升级走查）；desktop tsc 0；smoke:boot OK。
  - Batch 52 收口：根 build 0 错误；`npm test` 2517/2517；服务端全套 454/454（+1 审计链完整性走查）；desktop tsc 0；smoke:boot OK。
  - 复核人独立抽点：`first-run-walkthrough-audit-chain.test.ts` → **1/1**，0 fail。

## 翻绿项（相对第五轮，Batch 49 基线 e86b75d）

1. **§81 全触发器走查**（Batch 50）：`first-run-walkthrough-needshuman.test.ts` 在位；内容亲读确认 7 条阳性链路（S1–S7）全部真实 + S8 是显式负向对照（`t.diagnostic('S8 irrecoverable-env-error: negative control holds — 0 records, boundary documented')`），非伪造阳性路径；走查文档 §81 sweep 一节 + F28–F29 在位（F28 钉死"7/8 触发，第 8 个是钉死的边界"，S8 是未来翻转点）。
2. **桌面 needs-human 只读面板**（Batch 50）：`NeedsHumanPanel.tsx` 在位；亲读确认零 resolve/acknowledge 写路径（`POST /api/needs-human/:id/resolve` 服务端存在但桌面故意不接）、空态文案诚实（"空列表不是'机制关闭'的证据，也不是'功能缺失'"）、narrative 缺失时如实显示"不做推断"；REAUDIT_BATCH50 亲验类型逐字段镜像 + tsc 0。
3. **脱敏 hit → needs-human 升级路径走查**（Batch 51）：`first-run-walkthrough-redaction-escalation.test.ts` 在位；E1–E4 四条链路（E2 恰好 1 条 OPEN security-issue）；走查文档一节 + F30（阈值语义是事件数不是 hit 数）–F31（escalate-once-per-pattern）在位。
4. **备份恢复操作手册**（Batch 51）：`docs/backup-restore-guide.md` 在位（6 节：备份范围 / scope 语义 / 两条不对称恢复路径 / F22 项目根策略 / 桌面两个恢复入口 / 权限与审计）；KNOWN_LIMITATIONS 备份条目已加指针（亲验在位）。
5. **桌面两面板人机走查**（Batch 51 needs-human 面板、Batch 52 BackupPanel）：4 张真机截图在位（`walkthrough-needshuman-panel-empty.png` / `-with-record.png` / `walkthrough-backuppanel-table.png` / `walkthrough-backuppanel-restore-confirm.png`）；REAUDIT_BATCH51 亲读确认截图内容与报告一致；诚实边界在位（Linux+Xvfb dev 模式，不是打包后 AppImage；Windows/macOS 真机仍未验证）。
6. **审计链完整性走查**（Batch 52）：`first-run-walkthrough-audit-chain.test.ts` 在位；A1（链完整，legacyCount=0）+ A2（第二连接直接 UPDATE 篡改 → `brokenAt` 精确定位）在位；走查文档 'audit-chain integrity leg' 一节 + F32–F34 在位；**关键发现**：服务端没有 HTTP verify 端点——验证是消费方的事（server 是 writer，operator 是 verifier）；诚实边界：detection-not-prevention。
7. **走查文档总览重构**（Batch 52）：文档顶部 'Walkthrough index (Batch 51)' 11 行总览表 + 'Findings index (F1–F31)' 状态表在位（亲验）；状态口径 closed/open/hygiene 明确。
8. **独立复核**：`REAUDIT_BATCH49/50/51.md` 全部在位，结论均为 0 偏差（B49 为英文 "Verdict: 0 deviations"，其余为"偏差 0 处"）；REAUDIT_BATCH21–51 连续无断档。

## 新增真实缺口

**0 项**。Batch 50–52 挖出的 F28–F34 均为 Info 级（走查卫生 / 诚实边界钉死），无新增产品缺口。

## A. 真实可用 — verdict

- **真实模型回路**：**仍 BLOCKED，无变化**。`packages/runtime/src/adapters.ts` 的 StubAdapter 亲验仍在（`StubAdapter serves` 注释 + CodexAdapter 说明在位）；卡点未变（Codex 登录需 Tan 本人执行 `codex login --device-auth`）。
- **桌面应用可分发**：**仍只在 Linux 亲验，无变化**。唯一亲验过的仍是 Linux AppImage；Windows/macOS 安装包 + 代码签名仍待 Tan/环境。新增诚实进展：桌面两面板（needs-human 只读面板、BackupPanel）已有真机截图走查（Linux+Xvfb dev 模式，161–205KB PNG 4 张），但**仍不是打包后 AppImage 的双击体验**，Windows/macOS 真机仍未验证。
- **首次运行体验**：**走查继续累积**——v8（`demo:e2e-v8` 1/1×4）+ redaction leg（1/1×3）+ §81 full-trigger sweep（1/1×3，7/8 阳性+S8 负向对照）+ redaction→needs-human escalation leg（1/1×3）+ audit-chain integrity leg（1/1×3，复核人独立抽点 1/1）。**仍只覆盖 API 层**，无真机桌面点验（桌面截图走查是 UI 层但 dev 模式）。
- **关键数据可持久**：保持勾选，无新增持久化面变化。

## B. 规格完整度 — verdict

- **13 项硬阻塞（Tan/环境侧）**：亲验仍全部成立，一项没动——Codex 登录→真实模型 turn、非 Codex 模型适配器仍 stub（StubAdapter 在位）、Windows/macOS 安装包+代码签名、桌面真人点击验收未做、许可证/定价/渠道待 Tan 拍板、CI workflow scope（`.github/` 亲验仍为本地未跟踪 `??` 状态，GitHub CI 从未运行）、MCP SSE/HTTP/OAuth、无真实隔离 Host、生产 attestation 签名待 Tan 密钥决策、Windows 工具探测未真机验证、远程数据库驱动/merge queue 多机 M2 待 Tan 拍板、无测试生产环境、AT-001–AT-064 正式验收（275 条资产不存在，NOT_RUN）。
- **6 项代码侧刻意不做**：REAUDIT_BATCH49 已逐项亲读论证站得住（db.query DENY 分层、mcp.call definition-only、reconcile 只报告、Board v1 需 UI gate、F20 产品规则、env-error HTTP 阳性路径不伪造立场不变），本轮未发现动摇证据。
- **§81 八个触发器**：全部接上且 narrative 活过持久化（8/8，Batch 45 F19 关闭）；Batch 50 走查钉住 7/8 经纯 HTTP 可达 + 第 8 个（irrecoverable-env-error）是钉死的负向边界（S8 是未来翻转点）。
- **merge queue 多机**：口径不变（M1 单写者开关已落地；M2 待 Tan 拍板；部署建议单实例）。

## C. 质量与可信 — verdict

- **全量测试持续全绿**：基线 `7eadda6`，根 build 0 错误；`npm test` 2517/2517；服务端全套 454/454；desktop tsc 0；smoke:boot OK（引用 Batch 52 收口人主线亲验；复核人独立抽点 audit-chain 走查 1/1）。
- **文档一致**：CHANGELOG Batch 50–52 小节在位；KNOWN_LIMITATIONS 经 Batch 48 扫荡后本轮抽查备份条目指针在位；走查文档 v8+redaction leg+§81 sweep+escalation leg+audit-chain leg+总览表全部在位。
- **独立复核**：Batch 49/50/51 追加，全部 0 偏差；**REAUDIT_BATCH21–51 连续无断档**。

## D. 商业化 — verdict

- 版本 0.1.0 + CHANGELOG Batch 50–52 小节在位。
- **许可证仍待 Tan 拍板**：仓库无 LICENSE 文件是刻意状态（亲验仍不存在）。
- **定价/分发渠道仍待 Tan 拍板**。

## 总结论

**仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 相对第五轮翻绿 8 项（§81 全触发器走查、桌面 needs-human 只读面板、脱敏升级走查、备份恢复手册、桌面两面板人机走查、审计链走查、走查文档总览、Batch 49–51 独立复核 0 偏差）；新增真实缺口 0 项（F28–F34 均为 Info）。决定"卖"的硬门槛——真实模型回路（Codex 登录）、三平台分发+签名、许可证/定价/渠道——一项没动，全部需要 Tan 本人动作或外部环境；代码侧已无可代劳的路径。
