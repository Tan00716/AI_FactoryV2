# 可售清单全面复验报告（Batch 30）

> 复验基线：`7d99787`（Batch 29，已推送）。上次全面复验：Batch 24（基线 `8f63096`），中间走了 Batch 25–29。
> 复验方式：亲读 KNOWN_LIMITATIONS / CHANGELOG / 相关代码 + 本机亲跑全量测试与走查。零产品代码改动。

## 主线验证数字（本批亲跑）

- 根 `npm run build`：0 TS 错误
- `npm test`：**2304/2304**，0 失败
- `node --test apps/server/tests/*.test.ts`：**275/275**，0 失败（注：Batch 29 基线为 274，+1 来自 Batch 30-1 在途新增的 `first-run-walkthrough-b30.test.ts`，非本复验所加）
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误
- `npm run smoke:boot`：OK（编译产物启动，`/api/health` → 200）
- 首次运行走查 `npm run demo:e2e-new`（first-run-walkthrough-b21）：**1/1 全绿**（真 server + 临时 DB + 中途 SIGKILL 双 boot）

## A. 真实可用

| 条目 | 上次状态 | 本次状态 | 说明 |
|---|---|---|---|
| 真实模型端到端回路 | BLOCKED（卡 Codex 登录） | **仍 BLOCKED** | 卡点未变：需 Tan 本人在开发机执行 `codex login --device-auth`（Tan 2026-10-12 明确推迟）。进展：账号状态服务端接线已完成（`/api/router/account` 先试真实 Codex app-server，失败回 stub 并标注来源，亲读代码确认）——登录这一步走完即可真 turn。Codex 以外适配器仍 stub。 |
| 桌面应用可分发 | 部分（Linux 验证过） | **部分，无变化** | Batch 25 亲验：Linux `dist:linux` exit 0，124MB AppImage，无头启动真实服务。Windows：本机无构建环境，`release/` 的 exe 仍是未合入载荷的模板、不可用，需 Windows 机器跑 `dist:win`。macOS：需 Mac 本机 `dist:mac`。代码签名：零配置，证书待 Tan 采购。 |
| 首次运行体验 | 走查第二版 1/1（基线 8d7c55f） | **保持，基线已更新** | 本批在基线 `7d99787` 亲跑 `demo:e2e-new` **1/1 全绿**。走查仍只覆盖 API 层，无真机桌面点验（诚实边界不变）。 |
| 关键数据可持久 | ✅ 已勾选 | **保持勾选，覆盖扩大** | Batch 24–29 新增持久化面全部有跨重启测试钉住：builds（含 SBOM 落盘）、MCP launch 记录（ORPHANED 诚实语义）、enqueue position、merge queue drain 租约、Database broker、白名单策略。 |

## B. 规格完整度

- **Batch 1–7 约 64 条**：保持关闭。
- **Batch 8–23 高影响项**：保持关闭。
- **Batch 24–29 新关闭的高影响项**（CHANGELOG 可查）：
  - 真实构建执行（§40 闭环）：`FACTORY_BUILD_COMMAND` 真执行 + 真 digest 重算 + 成功回填 merge 证据 `artifactDigest`；未配置 = 功能关闭（记录 `NOT_EXECUTED`）。边界：构建跑仓库代码**不是沙箱**，只对信任仓库启用。
  - 构建 SBOM（CycloneDX 1.5 精简）+ SBOM 保留策略（双轴 + deleteOrphans 默认关 + legal hold 豁免）；构建工作区孤儿清理（启动 reconcile，`BUILD_ORPHAN_CLEANED`）。
  - MCP 注册表跨进程写互斥（op 意图协议，过期健康写不再撤销批准）+ install 并发审计（单语句原子，后写者胜，测试钉住）+ removeServer 两删除原子化（Batch 28 关闭了 27 的理论接缝）+ launch 记录落库。
  - merge queue enqueue position 碰撞（唯一索引仲裁 + 碰撞重试，老库迁移先修后建）。
  - Database 三环境身份（dev/staging/prod，prod 写字面确认门）+ 生产写 Broker/Runbook 最小闭环（包内 + **服务端 HTTP 面已上线**：`/api/db/*`，RBAC 门控，默认无白名单 opt-in）。
  - Browser 隔离 Profile（真目录隔离）+ 网站文本隔离契约（FetchedProvenance/QuarantinedContent/prompt choke point）。边界：无真实驱动（`available:false`），隔离 Host 一半仍未做。
  - 独立复核传统延续：Batch 25/26/27/28 复核全部成立（0 假关闭）。
- **仍是真实缺口的剩余项**（诚实边界，非遗漏）：
  1. 真实模型回路：卡 Codex 登录（Tan）；其余适配器 stub。
  2. MCP 未连真实服务器做协议握手（环境项）。
  3. 真实隔离 Host 未验证；Windows 工具探测未在 Windows 验证。
  4. pipeline stage 未落盘（stub `/run` 409，记录与 stage 定义仍进程内存）。
  5. Browser 隔离 Host 未做（Profile 已做）。
  6. merge queue 多机并发未做（只覆盖同一 DB 文件多进程）。
  7. `db.query` 工具 definition-only（刻意分层，非缺口）；Broker 引擎直写 SQLite 绕领域层校验（白名单是唯一控制，绑窄）。
  8. SBOM attestation 仍 null（待 Tan 密钥决策）。
  9. 真机三平台安装包 + 代码签名（环境/采购项）。

## C. 质量与可信

- **全量测试持续全绿**：✅ 保持勾选。本批亲跑数字见上（2304/2304、275/275、tsc 0、smoke OK）。
- **文档与实现一致**：**翻绿**。上次注明的两处文档缺口均已关闭：① CHANGELOG Batch 20 小节已补（Batch 24）；② KNOWN_LIMITATIONS merge queue 条目已更新（Batch 23/26）。KNOWN_LIMITATIONS 现共 58 条目，全部标注批次与边界。
- **独立复核**：✅ 保持勾选，追加：Batch 25（REAUDIT_BATCH25.md）、Batch 26（REAUDIT_BATCH26.md）、Batch 27（REAUDIT_BATCH27.md）、Batch 28（REAUDIT_BATCH28.md）——实质声明全部成立，0 假关闭。

## D. 商业化最小要件

- **版本号与 CHANGELOG**：✅ 保持勾选。版本仍 0.1.0；CHANGELOG 按批维护（Batch 20 缺口已补）。
- **许可证**：**仍待 Tan 拍板**（无变化）。备料完成（`docs/release/LICENSING_OPTIONS.md`，推荐专有 EULA）；仓库无 LICENSE 文件是刻意状态（默认保留所有权利）。
- **定价/分发渠道**：**仍待 Tan 拍板**（无变化）。

## 总结论

- **翻绿项（2）**：C-文档一致性（两处缺口已补）；B-剩余缺口清单实质性收缩（Batch 24–29 关闭了构建执行、SBOM、MCP 并发三件套、Database 身份+Broker、Browser Profile 等高影响项）。
- **仍卡项**：A-真实模型回路（卡 Codex 登录，Tan 本人动作）；A-桌面分发 Windows/macOS + 代码签名（环境/采购）；D-许可证/定价/渠道（Tan 决策）；B-剩余环境项（真实隔离 Host、MCP 真服务器握手、Windows 工具探测、多机并发、pipeline stage 落盘）。
- **当前仍是"可运行的原型 + 持续收敛"，不是可交付产品**：测试全绿且文档诚实，但 A/D 两项的硬卡点全在 Tan 一侧，B 剩余多为环境依赖项。CI 在 GitHub 从未运行过（`.github/workflows/ci.yml` 因 OAuth 缺 `workflow` scope 无法推送，待 Tan 处理）。
