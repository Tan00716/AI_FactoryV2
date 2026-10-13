# 发布前清单（Release Checklist）

> 对照《AI Factory「能拿出来卖」验收清单》（SELLABLE_CHECKLIST，2026-10-12
> 落盘于目标工作区）的 A–D 四组逐项列状态。状态口径：**已完成**（有实测
> 证据）/ **进行中**（助手侧在推进）/ **待 Tan 决策**（必须 Tan 本人拍板
> 或亲自执行，助手无法代劳；每项写明要决定什么、定完后助手做什么）。
> 更新日期：2026-10-12，代码基线远端 main = `fc894da`，远端
> Tan00716/AI_FactoryV2。

## A. 真实可用（产品本体）

- **待 Tan 决策 — Codex 真实模型回路验证**：适配器已真实实现并验到认证
  边界（未登录时真实 401 透传）。**需要你做的事**：在开发机执行一次
  `codex login --device-auth`（设备码授权，必须本人操作）。**完成之后**
  助手立刻跑一次真实 turn 端到端验证并留证，此项即可关闭。
- **已完成 — Linux 桌面安装包**：AppImage（约 124MB，带图标）已构建并
  无头运行验证通过（后端单进程、API 真实数据、数据库落盘）。
- **待 Tan 决策 — Windows 安装包定稿**：配置、图标、载荷（113MB nsis
  载荷）均已就绪，但本开发机的 Ubuntu 包源不可达、wine 装不上，无法在
  本机完成。**需要你决定/提供**：一台可用的 Windows 机器（或可达的构建
  环境），在上面跑 `npm run dist:win`。**完成之后**助手负责远程指导、
  验收产物（安装/启动/首跑走查）。macOS 安装包同理需一台 Mac，非首发
  必需时可后置。
- **已完成 — 首次运行体验**：空库启动 → 建项目 → 派任务 → 证据 → 审批 →
  运行 → Final Report 的八步走查全通（真实 server、纯 HTTP、含重启复验），
  存档于 docs/FIRST_RUN_WALKTHROUGH.md 并固化为常驻测试 `demo:e2e`；走查
  发现的 F1–F4 已在 Batch 12 全部修复。残留：桌面 UI 的点击级走查未做
  （无头环境只验到 API 层与 AppImage 启动），不阻塞服务端能力结论。
- **已完成（主体）— 关键数据持久**：§28 全部运行状态落 SQLite（step
  intents / external operations / checkpoints），需求、run 记录、审计哈希
  链同样落库；重启不丢、链可验。残留两项在 Batch 13 处理中，见 B 组。

## B. 规格完整度（SPEC_V2 审计缺口）

- **已完成**：Batch 1–12 关闭的缺口（安全、完整性硬约束、接线、持久化、
  走查发现），每批均经全量复验后提交并推送。
- **进行中 — Batch 13 三项**：① TaskV2Extension 落库（消除「重启后
  finalSeal 显示回 0、v2 镜像靠播种近似」的残留）；② checkpoint 第一个
  真实消费方接线（落盘已就绪，捕获/恢复消费未接，见 KNOWN_LIMITATIONS）；
  ③ 备份/恢复能力。
- **进行中 — 剩余约 135 条审计缺口**：按「影响真实使用」排序逐批关闭，
  后续大项包括完整 RBAC、真实 PTY、Git Broker / Merge Queue、OS Secret
  Broker、retention/legal hold、项目归档生命周期、Manager Team /
  Observatory UI、Run Manifest、Dispatch 流程 + UI 等。口径不变：实现 →
  单测 → 全量复验（构建 0 / 测试全绿 / demo 全过）→ 提交。

## C. 质量与可信

- **已完成 — 测试基线**：构建 0 错误、全量测试 1826/1826、46 个 demo
  脚本全过（2026-10-12 基线，每批复验后更新）。
- **已完成 — 独立复核**：未参与开发的审计员按规格原文抽查 Batch 1–10
  共 21 条已关闭项，21 条全部证实、0 假关闭
  （gap-audit/REAUDIT_BATCH_1_10.md）；复核提出的观察（如 intent 落盘
  时机）已在 Batch 12 修复。
- **已完成 — 编译后启动冒烟（F6，Batch 22）**：`npm run build` 之后必跑
  `npm run smoke:boot`——真实启动**编译后**的 `apps/server/dist`（临时
  DB + 临时 secrets 目录，不碰开发者本地 vault），`GET /api/health`
  返回 200 才算过；进程早退或 60s 超时即非零失败并把崩溃栈打到日志。
  来源：Batch 21 走查的 F6——部分包单独构建会让 dist 跨包不一致，真
  server 启动直接崩溃 exit 1，而根 `npm test` 不跑 server 套件、门禁抓不
  住"编译产物能启动"的问题。CI（`.github/workflows/ci.yml`，push/PR
  到 main）已接线：`npm ci` → `npm run build` → `npm run smoke:boot`。
  脚本见 `scripts/boot-smoke.mjs`。
- **进行中 — 文档一致性**：README 已按当前真实状态刷新、CHANGELOG 已
  建立（Batch 13-4）；KNOWN_LIMITATIONS 持续如实维护（包含 stub、潜伏
  与未接线能力的逐项标注），后续每批关闭缺口时同步更新。

## D. 商业化最小要件（多为待 Tan 决策）

- **已完成 — 版本号与发布说明备料**：版本号 0.1.0 线已定，CHANGELOG.md
  已按真实 git 历史建立（明确标注尚未正式发布）。
- **待 Tan 决策 — 许可证**：备料已齐（docs/release/LICENSING_OPTIONS.md：
  MIT / Apache-2.0 / 专有 EULA 三条路线的实测依赖基础、影响对比与推荐）。
  **需要你决定**：选哪条路线，以及版权署名主体（个人名还是公司名）。
  **决定后**助手落 LICENSE 文件并生成随附的第三方声明（THIRD-PARTY-NOTICES）。
- **待 Tan 决策 — 代码签名证书采购**：三平台当前均未签名。**需要你
  决定并采购**：Windows 代码签名证书（OV 或 EV；未签名时用户安装会遇到
  SmartScreen 警告）、如需发 macOS 则另需 Apple Developer 账号与
  Developer ID 证书（未签名/未公证会被 Gatekeeper 拦截）。**采购后**
  助手负责把证书接入 electron-builder 配置并复验产物签名。
- **待 Tan 决策 — 定价**：**需要你决定**：① 收费模式（一次性买断 /
  订阅 / 买断+年费升级）；② 计价单位（按席位 / 按设备 / 按项目）；
  ③ 价格带与版本分层（个人版与团队版的功能边界）；④ 是否提供试用期
  （时长与功能限制）。助手可在此之前提供同类产品价格带调研备料（需要
  时吩咐）。
- **待 Tan 决策 — 分发渠道**：**需要你决定**：官网直售（需支付通道，
  如 Stripe/Paddle，抽成低但要自建购买与授权发放流程）/ 平台代售
  （如 Gumroad 等，上手快、抽成较高）/ GitHub Releases 分发安装包 +
  独立授权发放（适合 EULA 路线起步）。渠道与许可证、定价三项互相
  联动，建议一并拍板。**决定后**助手负责把产物、校验和、发布说明
  按渠道要求备齐。
- **待 Tan 决策 — 发布时机与版本号定稿**：上述决策齐备且 Batch 13
  完成后，**需要你确认**：以 0.1.0 作为首个对外版本号发布，还是先
  小范围试发（如邀请制）再定正式版本号。

## 汇总：需要 Tan 拍板的事项（按阻塞程度排序）

1. **Codex 登录**（阻塞 A 组真回路验证）——亲自执行 `codex login --device-auth`。
2. **Windows 构建环境**（阻塞 Windows 安装包）——提供一台 Windows 机器或等效环境。
3. **许可证路线 + 署名主体**（阻塞 LICENSE 落地）——备料见 LICENSING_OPTIONS.md。
4. **代码签名证书**（阻塞无警告安装体验）——Windows 证书先行，Apple 视是否发 macOS 再定。
5. **定价 + 分发渠道**（阻塞开卖动作本身）——四项子问题见 D 组。
