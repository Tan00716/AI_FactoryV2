# 可售清单第八轮全面复验（基线 `76dbc78`，Batch 57 收口，本地）

> 复验日期：2026-10-15。复验方式：`git rev-parse HEAD` 确认基线 `76dbc78`（"Batch 57: Batch56 独立复核 / findings 编号一致性修复 / 桌面'好用'审计 / Linux AppImage 打包复验"）；工作树亲验干净（仅 `.github/` 未跟踪，与历轮一致）；
> 对第七轮（Batch 55，`4f393a9`）以来的全部新增交付物做文件存在性 + 内容亲读（grep 亲验关键断言与结论措辞）；
> watch leg 走查做独立抽点亲跑（`first-run-walkthrough-audit-chain-watch.test.ts` → **1/1**，0 fail）；
> 全量测试数字引用 Batch 56/57 收口人主线亲验（兄弟任务在途时不重跑全套，避免混合口径），复核人此前各轮已亲跑验证。
> 零产品代码改动。未 commit。
> **特别说明**：2026-10-15 Tan 新指令——开发本地进行、先不上传 GitHub，完成后报告再问是否上架。所以本轮基线 `76dbc78` 是**本地 commit**，远端 main 仍为 `7e96bfe`（Batch 54）。以下复验针对本地 `main`。

## 复验方式与基线

- HEAD：`76dbc78`（Batch 57）；链：`4f393a9`（Batch 55）→ `a43bbec`（Batch 56）→ `76dbc78`（Batch 57），本地三连 commit 连续无断档；远端 main 仍 `7e96bfe`（ls-remote 亲验）。
- `CHANGELOG.md` 头部亲验：`## Batch 55` / `## Batch 56` / `## Batch 57` 三节在位。
- 测试数字（引用收口人主线亲验）：
  - Batch 56 收口：根 build 0 错误；`npm test` 2517/2517；服务端全套 466/466（+1 watch leg 走查）；desktop tsc 0；smoke:boot OK。
  - Batch 57 收口：根 build 0 错误；`npm test` 2517/2517；服务端全套 466/466（无新增服务端测试）；desktop tsc 0；smoke:boot OK。
- 远端 main 亲验：`7e96bfe`（Batch 54）；Batch 55–57 本地累积未推送（Tan 2026-10-15 指令）。

## 翻绿项（相对第七轮，Batch 55 基线 4f393a9）

1. **audit-chain watch leg 走查**（Batch 56，**F39–F40**）：`first-run-walkthrough-audit-chain-watch.test.ts` 在位（11.6KB；A–C 真实 server boot：健康 DB → 0 OPEN；篡改中部记录 + 重启 → 恰好 1 条 OPEN security-issue，narrative 含 BROKEN / 'Human judgment needed' / append-order 声明；链仍断第三次重启 → 仍 1 条无风暴；WATCH=0 + broken-chain 对照 → 0 OPEN）；走查文档 'audit-chain watch leg (Batch 56)' 一节 + F39–F40 在位（亲读：F39 hygiene boot-path fidelity note；F40 hygiene WATCH=0 control）。**独立抽点亲跑：1/1，0 fail**。`walkthrough index (Batch 56)` 含 watch leg 一行，`Findings index (F1–F40)` 在位。
2. **周期自检告警桌面真机截图**（Batch 56）：`walkthrough-needshuman-auditwatch.png`（162KB）+ `walkthrough-auditchain-broken.png`（193KB）在位，`file` 亲验均为 1279×995 真 PNG。**桌面真机截图累计 7 张**（needs-human ×2 + BackupPanel ×2 + 审计链 ×1 + watch 告警 ×2；Linux+Xvfb dev 模式）。
3. **findings 编号一致性修复**（Batch 57，零产品代码改动）：Batch 57-1 卫生注记实证——'14 行'/'F1–F37'/'F38' 口径已滞后；修复后亲验：Walkthrough index 实际 15 行（v1–v8 8 行 + 7 legs：redaction / §81 sweep / escalation / audit-chain / verify endpoint / audit-chain verify / audit-chain watch；亲验 walkthrough index 行含 watch leg），Findings index F1–F40（F39–F40 亲读在位）。`KNOWN_LIMITATIONS.md` 第 68 行已同步（15 行 + F1–F40，7 legs 枚举在位，亲读）。历史快照（SECURITY_REVERIFY_BATCH55.md / CHANGELOG 各 batch 小节）刻意未改，理由在位（改写等于篡改审计证据）。
4. **桌面'好用'审计**（Batch 57，产品代码改动，18 个桌面文件）：`git show --stat 76dbc78` 亲验：恰好 18 个桌面 component 文件（ActivityPanel/ApprovalsPanel/Board/BottomPanel/CreateTaskModal/EditorPanel/EvaluationPanel/EventsPanel/GitPanel/KnowledgePanel/McpPanel/ModelsPanel/NotificationsBell/OrchestratePanel/QaPanel/SkillsPanel/TaskDetail/WorkforcePanel）。核心结论抽查在位：零 404 死按钮（60+ 端点逐条 grep 与服务端 routes 匹配）；真实修复已落地——错误吞掉类（`NotificationsBell.tsx` 亲验：`{error && <div className="pill warn">通知加载/更新失败：{error}</div>}` 在位）、连击重复提交类（`ApprovalsPanel.tsx` 亲验：`acting` 行级禁用 + '处理中…' 在位）、loading/empty 误导类。有意保留项诚实记录（备注级接口死方法无桌面按钮、stub 占位文案、幂等刷新按钮、best-effort .catch）。`desktop tsc` 0（引用 Batch 57 收口人主线亲验）。诚实边界：这是 agent 全读 36 面板的代码审计，不是真人点击验收；Windows/macOS 真机仍未验证。
5. **Linux AppImage 打包复验**（Batch 57，零仓库文件改动）：产物在仓库外亲验在位——`/home/hatch/appimage-out/AI Factory-0.1.0.AppImage`（commit message 称 125MB ELF x86-64；`linux-unpacked/` 在位，亲验 `ai-factory` 可执行文件 + chromium pak + LICENSES 文件在位）。启动冒烟亲验记录：AppImage 本体需要 FUSE（本机无 FUSE，环境限制如实记录）→ 改跑包裹的同一棵树 `linux-unpacked/ai-factory --no-sandbox`（xvfb）：主窗口 + renderer 进程在位（Renderer 只在 BrowserWindow 加载页面时出现）、后端恰好 1 个进程、`GET /api/health` 200、`PORT` 透传。两次事故环境侧（/tmp 512MB tmpfs ENOSPC → 改到 ~/appimage-out；无 FUSE），构建代码无需修复。**边界诚实**：验证的是'打包产物能启动到主窗口+后端健康'，不是 AppImage 双击体验（无 FUSE 无法执行 .AppImage 本体）；Windows/macOS 打包仍未验证。
6. **独立复核**：`REAUDIT_BATCH55.md` 在位（亲读结论：**偏差 0 处**；一处实现细节注记非偏差：`emitAuditChainBreakNeedsHuman` 失败分支的 try/catch 兜底设计已考虑）；`REAUDIT_BATCH56.md` 在位（亲读结论：**偏差 0 处**；卫生注记 KL 行滞后已由 Batch 57 修复；CHANGELOG Batch 56 小节 B 括号措辞 slip 不影响验证结论）；**REAUDIT_BATCH21–56 连续无断档**。

## 新增真实缺口

**0 项**。Batch 56 挖出的 F39–F40 均为 hygiene 级（boot-path fidelity note / WATCH=0 control）；Batch 57 的 findings 编号修复是文档卫生；桌面'好用'审计是有意保留项诚实记录，无新增产品缺口。

## A. 真实可用 — verdict

- **真实模型回路**：**仍 BLOCKED，无变化**。`packages/runtime/src/adapters.ts` 的 StubAdapter 亲验仍在（3 处引用亲验）；卡点未变（Codex 登录需 Tan 本人执行 `codex login --device-auth`）。
- **桌面应用可分发**：**Linux 亲验硬化，但 Windows/macOS 仍未动**。新增实证：125MB AppImage 本轮重新打出，linux-unpacked 同一棵树在 xvfb 下 boot 到主窗口 + 后端健康（/api/health 200、PORT 透传、DB 真实落盘）。仍不是 AppImage 本体双击执行（无 FUSE 环境）；Windows/macOS 安装包 + 代码签名仍待 Tan/环境。
- **首次运行体验**：**走查继续累积**——v8（`demo:e2e-v8` 1/1×4）+ redaction leg（1/1×3）+ §81 full-trigger sweep（1/1×3，7/8 阳性+S8 负向对照）+ redaction→needs-human escalation leg（1/1×3）+ audit-chain integrity leg（1/1×3）+ audit-chain verify leg（1/1×3）+ audit-chain watch leg（1/1×3，真实 server boot，本轮亲跑确认）。走查总览 15 行 + Findings F1–F40。**仍只覆盖 API 层**，无真机桌面点验（桌面截图走查是 UI 层但 dev 模式；桌面'好用'审计是代码审计不是点击验收）。
- **关键数据可持久**：保持勾选，无新增持久化面变化。

## B. 规格完整度 — verdict

- **13 项硬阻塞（Tan/环境侧）**：亲验仍全部成立，一项没动——Codex 登录→真实模型 turn、非 Codex 模型适配器仍 stub（StubAdapter 在位）、Windows/macOS 安装包+代码签名、桌面真人点击验收未做（Batch 57 是代码审计不是点击验收）、许可证/定价/渠道待 Tan 拍板、CI workflow scope（`.github/` 亲验仍为本地未跟踪 `??` 状态，GitHub CI 从未运行）、MCP SSE/HTTP/OAuth（无 sse/oauth 路由文件在位，仍是边界）、无真实隔离 Host、生产 attestation 签名待 Tan 密钥决策、Windows 工具探测未真机验证、远程数据库驱动/merge queue 多机 M2 待 Tan 拍板、无测试生产环境、AT-001–AT-064 正式验收（275 条资产不存在，NOT_RUN）。
- **6 项代码侧刻意不做**：Batch 56/57 未触及，无动摇证据；REAUDIT_BATCH49 的论证继续成立。
- **§81 八个触发器**：全部接上且 narrative 活过持久化（8/8，Batch 45 F19 关闭）；Batch 50 走查钉住 7/8 经纯 HTTP 可达 + 第 8 个（irrecoverable-env-error）是钉死的负向边界（S8 是未来翻转点）。周期审计链自检断链 → security-issue 发射点（Batch 55，operator，critical）继续有效。
- **merge queue 多机**：口径不变（M1 单写者开关已落地；M2 待 Tan 拍板；部署建议单实例）。

## C. 质量与可信 — verdict

- **全量测试持续全绿**：基线 `76dbc78`（本地），根 build 0 错误；`npm test` 2517/2517；服务端全套 466/466；desktop tsc 0；smoke:boot OK（引用 Batch 56/57 收口人主线亲验；独立复核 REAUDIT_BATCH56 的卫生注记均非偏差）。
- **文档一致**：CHANGELOG Batch 55–57 小节在位；KNOWN_LIMITATIONS 经 Batch 54 扫荡 + Batch 55 断链修复 + Batch 57 编号修复后本轮抽查在位（15 行总览 + F1–F40 + 7 legs 枚举）；走查文档 v8+legs+15 行总览+Findings F1–F40 全部在位；历史快照刻意未改（审计证据保护）。
- **独立复核**：Batch 55/56 追加，全部 0 偏差；**REAUDIT_BATCH21–56 连续无断档**。

## D. 商业化 — verdict

- 版本 0.1.0 + CHANGELOG Batch 55–57 小节在位。
- **许可证仍待 Tan 拍板**：仓库无 LICENSE 文件是刻意状态（亲验仍不存在）。
- **定价/分发渠道仍待 Tan 拍板**。

## 总结论

**仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 相对第七轮翻绿 6 项（audit-chain watch leg 走查 + 2 张桌面真机截图 / findings 编号一致性修复 / 桌面'好用'审计 18 文件 / Linux AppImage 打包复验 / Batch 55–56 独立复核 0 偏差；独立复核 REAUDIT_BATCH21–56 连续无断档）；新增真实缺口 0 项（F39–F40 均为 hygiene）。桌面真机截图累计 7 张，Linux 打包流水线复验一次通过。决定"卖"的硬门槛——真实模型回路（Codex 登录）、三平台分发+签名、许可证/定价/渠道——一项没动，全部需要 Tan 本人动作或外部环境；代码侧已无可代劳的路径。**补充**：本轮基线是本地 commit（76dbc78），按 Tan 2026-10-15 指令先不推送 GitHub；远端 main 仍为 `7e96bfe`。
