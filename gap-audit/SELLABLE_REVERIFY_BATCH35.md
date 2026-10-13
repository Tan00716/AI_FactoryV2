# 可售清单增量复验报告（Batch 35）

> 复验基线：`8ae723e`（Batch 34，已推送）。上次全面复验：Batch 30（基线 `d81857a`，`gap-audit/SELLABLE_REVERIFY_BATCH30.md`），中间走了 Batch 31–34。
> 本报告为增量：只记录相对 Batch 30 的变化，不重复 Batch 30 全文。复验方式：亲读 CHANGELOG（Batch 31–34）、KNOWN_LIMITATIONS、相关代码 grep；零产品代码改动。本批亲跑全量验证数字见"主线验证"节（亲跑）。

## 主线验证数字（Batch 35 亲跑，基线 8ae723e）

- 根 `npm run build`：0 TS 错误
- `npm test`：**2411/2411**，0 失败（基线 2375 → +36：management-reports 14、comms report-loadsnapshot 4、organization-relationships 7、policy-versions 11）
- `node --test apps/server/tests/*.test.ts`：**307/307**，0 失败（基线 304 → +3：reports-restart 1、org-graph-restart 1、policy-versions-restart 1）
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误
- `npm run smoke:boot`：OK（编译产物启动，`/api/health` → 200）

## A. 真实可用

| 条目 | Batch 30 状态 | 本次状态 | 说明 |
|---|---|---|---|
| 真实模型端到端回路 | BLOCKED（卡 Codex 登录） | **仍 BLOCKED** | 卡点未变：需 Tan 本人在开发机执行 `codex login --device-auth`（Tan 2026-10-12 明确推迟，不催）。CodexAdapter 本体已真实实现（未登录时 turn 被真实 401 拒绝）；Codex 以外适配器仍 stub。 |
| 桌面应用可分发 | 部分（Linux 验证过） | **部分，无变化** | Batch 25 亲验：Linux `dist:linux` exit 0，124MB AppImage，无头启动真实服务。Windows：本机无构建环境，exe 仍是未合入载荷的模板不可用，需 Windows 机器跑 `dist:win`。macOS：需 Mac 本机。代码签名：零配置，证书待 Tan 采购。 |
| 首次运行体验 | 走查第三版 1/1（基线 d81857a） | **保持** | Batch 30 起 `first-run-walkthrough-b30.test.ts`（`npm run demo:e2e-v3`）连续 1/1。Batch 31 关闭了 F9：`/api/builds` + `/api/builds/:id` 只读面已上线（viewer 可读），纯 HTTP 消费者可观察构建落地——走查原先的 DB 直读绕路正式成为可选路径。走查仍只覆盖 API 层，无真机桌面点验（诚实边界不变）。 |
| 关键数据可持久 | ✅ 保持勾选，覆盖扩大 | **保持勾选，覆盖再扩大** | Batch 31–34 新增持久化面全部有跨重启测试钉住：pipeline 记录+stage 定义（INTERRUPTED 诚实语义，Batch 31）、delegations/gates（Batch 32）、escalations/proposals（Batch 33）、management_reports/organization_relationships/policy_versions（Batch 34）、projects 13 字段/模板/知识（Batch 33）。§48.2 实体集合至此**全部落库**。 |

## B. 规格完整度

### Batch 31–34 新关闭的真实缺口（CHANGELOG 可查，均有独立复核背书）

- **pipeline stage 记录+定义落库（Batch 31）**：`pipeline_records`/`pipeline_stages` 表；重启后 `/run` 对重建记录仍诚实 409（落盘的是记录不是执行）。
- **/api/builds 只读面（Batch 31）**：关闭 walkthrough F9。
- **AUTHORITY_CONFLICT 仲裁（Batch 32）**：关闭 INV-31 缺口；同级冲突暂停+人工升级，registry 内存（重启丢暂停状态）。
- **§5 相对权限上限（Batch 32）**：§8.2 "委托不能超过委托者可授予集合"维度；**任务范围维度仍只在 scope.ts，未并入本检查**（诚实未做）。
- **gates/delegations（Batch 32）、escalations/proposals（Batch 33）、management_reports/organization_relationships/policy_versions（Batch 34）**：§48.2 实体集合全部落库。
- **§6.1 项目记录 13 字段 + Clone Repository 入口（Batch 33）**：全 nullable 迁移（升级不编造）；`POST /api/projects/clone` 真 git clone。
- **模板扩展注册 + §6.4 项目知识 9 类（Batch 33）**：5 内置模板钉死，注册模板可真实脚手架。
- **SPEC 59 章扫荡（Batch 31）**：已落地 27、部分 32、整章未做 0；7 个新缺口全部记录→**其中 5 个已被 Batch 32–34 关闭**（AUTHORITY_CONFLICT、相对上限、项目字段/Clone/模板、知识 9 类、§48.2 落库）；剩余：§81 needsHuman 升级形状。

### 剩余真实缺口（诚实边界，非遗漏）

1. **§81 `needsHuman` 升级形状**：`packages/autonomy` 的 `needsHuman()` 存在且有测试，但**没有任何服务端发射点、全库无存储**（disputes.ts:22、escalations.ts:26-27、index.ts:500 均已明确声明未覆盖）。三者（§81 needsHuman、dispute escalation、AUTHORITY_CONFLICT）是独立形状，无连线。
2. §8.2 "任务范围"维度未并入 `enforcePolicy`（只在 scope.ts）。
3. 真实隔离 Host 未验证；Windows 工具探测未在 Windows 验证；Browser 隔离 Host 未做（Profile 目录隔离已做）。
4. MCP 未连真实第三方服务器做协议握手（环境项）。
5. 真实模型回路：卡 Codex 登录（Tan）；其余适配器 stub。
6. merge queue 多机并发未做（只覆盖同一 DB 文件多进程）。
7. SBOM attestation 仍 null（待 Tan 密钥决策）。
8. 真机三平台安装包 + 代码签名（环境/采购项）；桌面真人点击验收未做。
9. CI：`.github/workflows/ci.yml` 因 OAuth 缺 `workflow` scope 仍无法推送，**GitHub CI 从未运行过**，待 Tan 处理。

## C. 质量与可信

- **全量测试持续全绿**：✅ 保持勾选。本轮亲跑数字见上（2411/2411、307/307、tsc 0、smoke OK）。
- **文档与实现一致**：✅ 保持勾选。Batch 31–34 的 CHANGELOG 小节全部在位；KNOWN_LIMITATIONS 逐条标注批次与边界；34-1 纠正过 3 处计数/列名偏差后不再累积。
- **独立复核**：✅ 保持勾选，追加：Batch 30（REAUDIT_BATCH30.md，纠正 58/54 口径）、Batch 31（REAUDIT_BATCH31.md，纠正 27/32 计数+projects 列名）、Batch 32（REAUDIT_BATCH32.md，§8.1 行号漂移）、Batch 33（REAUDIT_BATCH33.md，偏差 0 处）。全部实质声明成立，0 假关闭。Batch 34 复核在 Batch 35 在途进行。

## D. 商业化最小要件

- **版本号与 CHANGELOG**：✅ 保持勾选。版本仍 0.1.0；CHANGELOG 按批维护（"在途"小节在 Batch 31–34 仍为标题残留，未改为正式版本号——收口时可整体落版本，属流程小项）。
- **许可证**：**仍待 Tan 拍板**（无变化）。备料完成；仓库无 LICENSE 文件是刻意状态。
- **定价/分发渠道**：**仍待 Tan 拍板**（无变化）。

## 建议翻绿的清单勾选（相对 Batch 30 的变化）

1. B-剩余缺口列表：删掉"pipeline stage 未落盘"（Batch 31 已关闭）与"§48.2 实体内存"（Batch 32–34 全部关闭）；加上"§81 needsHuman 升级形状无服务端发射点"。
2. A-关键数据可持久：标注§48.2 全落库。

## 总结论

- **翻绿项（5）**：B-剩余缺口大幅收敛——Batch 31–34 关闭了 pipeline 记录落库、/api/builds 读面、AUTHORITY_CONFLICT 仲裁、§5 相对上限、§48.2 实体集合全落库、§6.1 项目记录/Clone/模板/知识。A-走查 F9 关闭。
- **仍卡项**：A-真实模型回路（卡 Codex 登录，Tan 本人动作）；A-桌面分发 Windows/macOS + 代码签名（环境/采购）；D-许可证/定价/渠道（Tan 决策）；B-剩余环境项（needsHuman 发射点、真实隔离 Host、MCP 真服务器握手、Windows 工具探测、多机并发、SBOM attestation）；CI 在 GitHub 从未运行过。
- **当前仍是"可运行的原型 + 持续收敛"，不是可交付产品**：测试全绿且文档诚实，但硬卡点全在 Tan 一侧（Codex 登录、证书、许可证/定价），B 剩余以环境依赖项为主。
