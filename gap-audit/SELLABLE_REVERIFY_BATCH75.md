# 可售清单第十二轮全面复验（基线 `848d71c`，Batch 75 收口，本地）

> 复验日期：2026-10-15。复验方式：`git rev-parse HEAD` 确认基线 `848d71c`（"Batch 75: Tan 产品决策 A A A 落地（F61/F28/F12 全部 closed）"）；工作树亲验（`git status` 干净，仅 `?? .github/` 未跟踪，与历轮一致）；
> 对第十一轮（Batch 71，`SELLABLE_REVERIFY_BATCH71.md`，基线 `6618b36`）以来全部新增交付物（Batch 74–75）做文件存在性 + 内容亲读；
> 全量测试数字**引用 Batch 75 收口人主线亲验数字**（同基线 `848d71c`，见其 commit message）；受影响子集（F61/F28/F12 新测试 + 被改动的旧测试）为**本轮复验人亲跑**（TMPDIR wrapper 下）；
> 零产品代码改动（本轮未改任何 tracked 文件，未 commit）。
> **特别说明**：Tan 2026-10-15 指令——开发本地进行、先不上传 GitHub，完成后报告再问是否上架。所以本轮基线 `848d71c` 是**本地 commit**，远端 main 仍为 `7e96bfe`（Batch 54；远端确认沿用既定结论，本轮未重复跑 ls-remote）。

## 复验方式与基线

- HEAD：`848d71c`（Batch 75）；链：`6618b36`（Batch 71）→ `5b3f224`（Batch 74）→ `848d71c`（Batch 75），本地三连 commit 连续无断档；远端 main 仍 `7e96bfe`（沿用既定结论，未重复跑 ls-remote）。
- 本轮亲跑数字（基线 `848d71c`，本地，受影响子集）：根 build **0** 错误（真实 exit code，约 10.6 分钟）；electron tsconfig tsc **0**；
  - 服务端受影响子集（`node scripts/run-tests-tmp.mjs --test`，4 文件）：`v1-transition-authorization.test.ts`（F61）+ `needs-human-irrecoverable-env-error-http.test.ts`（F28）+ `authority-conflict-persistence.test.ts`（F12）+ `product-authority-default.test.ts`（被改动）= **13/13**，0 fail；
  - 包级受影响子集：`packages/db/dist/tests/authority-conflicts.test.js` **16/16**（10 个 `it` 调用点，其中 6 个在 InMemory/Sqlite 双实现上各跑一次 = 12 + 4 独立 = 16；与 Batch 75 口径一致），`packages/policy/dist/tests/authority-hydrate.test.js` **6/6**，0 fail。
- 引用 Batch 75 收口人主线亲验数字（同基线，commit message 记录）：包套件 **2589 pass / 0 fail**（2591 tests，其中 2 skipped 合法跳过）；服务端全套 **500/500**（490 旧 + 10 新）；desktop tsc 0；electron tsc 0；`smoke:boot` OK。
- 复核链：`REAUDIT_BATCH73.md` 在位（Batch 74 产出，结论偏差 0 处）；**REAUDIT_BATCH21–73 连续无断档**；卫生注记：`REAUDIT_BATCH74.md` 尚不存在（Batch 75 未产出对 Batch 74 的独立复核报告——索引扫荡已覆盖其内容，记为待办 hygiene，非偏差）。

## 翻绿项（相对第十一轮，Batch 74–75）

### Batch 75：Tan 决策 "A A A" 全部落地（F61 / F28 / F12 → closed）

1. **F61 → closed (B75)：v1 `POST /transition` 查 §17.2 授权轴**（Tan 2026-10-15 21:15 +08 决策卡 "A A A" 全做）。
   - 代码亲读：`apps/server/src/index.ts`（v1 transition handler）——`to` 校验之后、引擎流转之前插入门禁：`effectiveAuthorizationStatus(tasks.get(id)) !== 'AUTHORIZED'` → 403 `TASK_NOT_AUTHORIZED`（复用 G5 门形状；无轴值历史行默认 AUTHORIZED；未知轴值 fail-closed）。`Board.tsx`：拖拽加了 403 专用分支，未授权任务拖拽弹专用提示"⛔ 未授权（§17.2）…请先在 Dispatch 页签完成派发"（之前是通用"流转失败"）。
   - 测试亲跑：`v1-transition-authorization.test.ts` **4/4**（真编译 server + 纯 HTTP：legacy 默认 200 / WAITING → 403 行不动 / REVOKED → 403 / human dispatch 重授权 → 200）。
   - 文档同步：`docs/KNOWN_LIMITATIONS.md` §17.2 条目追加 Board 拖拽 UX 变化；`product-authority-default.test.ts` 头注释同步更新（原"v1 不查轴"的声明已过时）。
   - 边界如实：Board 拖拽未授权任务现在多一步派发动作（产品决策代价，Tan 已知）。

2. **F28 → closed (B75)：S8 翻转点——HTTP 可达的环境错误信号落地**（同上决策卡）。
   - 代码亲读：`apps/server/src/routes/runtime.ts`——`POST /api/runtime/runs` 新增可选 body 参数 `envErrorSignal`（`ENV_SANDBOX_UNAVAILABLE` | `ENV_BINARY_MISSING`）；声明后该 run 的 stepFn 每步抛对应 env FactoryError → 同一签名连续 3 次 → `LoopStagnation(env)` → escalate → 'irrecoverable-env-error' 发射。`resolveEnvErrorSignal` fail-closed：非法码 → 400 `INVALID_ENV_ERROR_SIGNAL`（校验在 run 记录创建之前）；resume 路由不接受此参数。footgun 防护四层亲验在位：route→role 表（viewer 403 / 匿名 401）、每次使用审计 `RUNTIME_ENV_ERROR_SIGNAL_USED`、manifest driver 双留痕、记录 narrative 限定 declared-not-observed（"DECLARED … NOT observed by probing a real host"）。无 signal 时负向对照仍成立（`RUNTIME_TOOL_NAMES` tripwire 未动）。
   - 测试亲跑：`needs-human-irrecoverable-env-error-http.test.ts` **7/7**（负向对照 + 正向路径 + tripwire）。
   - 文档同步：`docs/FIRST_RUN_WALKTHROUGH.md` S8 走查行（第 23 行）与 F28 小节更新为"Batch 75: now HTTP-reachable via the operator-gated `envErrorSignal`"；`docs/needs-human-triggers.md` 的 `irrecoverable-env-error` 表格行追加 Batch 75 段落（含 footgun 风险已告知 Tan 的记录）。
   - 边界如实：阳性路径是"声明式注入"不是"真实 host 探测"——narrative 限定语如实写明；真正的环境故障仍需 Tan 的生产环境。

3. **F12 → closed (B75)：authority-conflict registry 跨重启持久化**（同上决策卡）。
   - 代码亲读：`packages/db/src/authority-conflicts.ts`（245 行）——`AuthorityConflictStore` 接口 + InMemory/Sqlite 实现，saveDirective/saveConflict upsert 写透语义，每次读返回深拷贝，腐坏行大声抛错不猜测；`packages/db/src/schema.ts` 新增 `authority_directives` / `authority_conflicts` 两表（`CREATE TABLE IF NOT EXISTS`，老库自动建表）；`packages/policy/src/authority.ts` 新增 `AuthorityConflictRegistry.hydrate`（静默、不重发 §81 升级、boot-only、id 续接防碰撞）；`apps/server/src/routes/authority.ts`——`initAuthorityRoutes(fdb, audit)`：registerDirective/resolveConflict 成功后写透（失败审计 `AUTHORITY_CONFLICT_PERSIST_FAILED`，永不回滚响应），boot 时水合（成功审计 `AUTHORITY_CONFLICT_HYDRATED`，失败审计 `AUTHORITY_CONFLICT_HYDRATE_FAILED` 并降级纯内存）。API 契约零变化（diff 亲验：只加参数/内部接线，无端点增删）。
   - 测试亲跑：db **16/16**（双实现 round-trip + upsert + 深拷贝 + 空店 + corrupt 大声失败 + 老库建表重开存活）、policy hydrate **6/6**、`authority-conflict-persistence.test.ts` **1/1**（三次 boot + 两次 SIGKILL，§81 升级仍恰好 1 条——水合不重发）。
   - 边界如实：这是三个决策里代价最大的一个（21 文件、2011 insertions），Tan 明确选了 A；水合失败降级纯内存（审计留痕，不静默）。

### Batch 74（5b3f224，B74 收口数字引用）

4. **桌面打包图标真实缺口修复**（74-2）：`BrowserWindow` 没设 `icon` 且 `apps/desktop/build/icon.png` 不在打包 `files` 列表——diff 亲验两处修复（`electron-builder.yml` files 新增 icon.png；`main.ts` createWindow 加 `icon: path.join(__dirname, '..', 'build', 'icon.png')`，dev/打包后相对布局相同）。electron tsc 本轮亲跑 **0**。未跑完整打包（标准 files 行为）。
5. **Batch 73 独立复核**：`REAUDIT_BATCH73.md` 在位，结论偏差 0 处（commit `be15336` 恰好 6 文件；wrapper 逐行亲读；490/490 第一轮全绿）。
6. **文档滞后修复**（74-3）：KNOWN_LIMITATIONS 桌面真机 PNG 累计 33→39；SELLABLE_CHECKLIST 补"当前状态（2026-10-15，Batch 71 收口）"小节。
7. **打包元数据审计**（74-2）：appId/productName/version/description/author/copyright/desktopName/NSIS shortcutName/linux executableName+maintainer/mac category 全一致，license 刻意无（Tan 的决定）。

## 新增真实缺口

**0 项**。Batch 74–75 挖出的 1 个真缺口（桌面打包图标）**已修复**；F61/F28/F12 是 Tan 拍板后落地的功能实现，不是新缺口。§58 migration-map 结论不变（Batch 71 已钉 0 偏差；B74/B75 未动迁移面）。

## A/B/C/D verdict

- **A 真实可用**：
  - [ ] 真实模型端到端回路：仍 BLOCKED——`~/.codex/auth.json` **不存在**（本轮亲验）→ device login 仍需 Tan 本人执行（2026-10-12 推迟至今无变化；走查仍用 StubAdapter）。**非 Codex 模型适配器仍 stub**（`packages/runtime/src/adapters.ts:101` 的 `class StubAdapter` grep 亲验仍在）。
  - [ ] 桌面应用可分发：Linux 路径继续硬化——图标缺口已修（74-2；electron tsc 本轮亲跑 0）；其余结论不变（AppImage 125MB 带 68/69 修复、27/27 面板 bug-hunt 0 真 bug、39 张真机 PNG）。**Windows 最终 exe 仍未验证**（71-3 真实复现：缺 wine，最终 Setup exe 不可用；必须 Windows 实机或 wine 环境；`dist:win` 仍缺 `--publish never`，F67 open）；**macOS 仍完全未动**；**三平台全部未签名、零证书配置**（证书采购主体/类型/Apple ID 都是 Tan 的决定）。
  - [ ] 首次运行体验：走查继续累积（index **30 行**：v1–v8 + 22 legs；Findings **F1–F68**，68 行连续无断号，本轮脚本亲验）——但**仍只覆盖 API 层**，桌面走查是 CDP 驱动的点击/截图，**不是真人点击验收**；也不是 AppImage 双击体验（无 FUSE，本机从未执行过 `.AppImage` 本体）。F61 的 Board 拖拽 UX 变化（未授权→专用提示）是本轮新增的桌面行为面变化。
  - [x] 关键数据可持久：**本轮有实质进展**——authority-conflict registry 落库（F12，见上）；§48.2 实体集合落库结论不变（§81 narrative 持久化结论不变）。
- **B 规格完整度**：
  - [x] Batch 1–7、Batch 8–23 关闭项无回退迹象（本轮未动该层）。
  - [x] **SPEC_V2 35 条 invariants 全部有测试/走查证据**（结论不变；G1–G11 逐条边界如实记录）。
  - [x] **SPEC_V2 §58 migration-map 合规**（Batch 71 结论不变；B74/B75 未动迁移面）。
  - [ ] 剩余缺口：**13 项硬阻塞亲验全部仍在 Tan/环境侧，一项没动**——
    1. Codex 登录→真实模型 turn（需 Tan 本人：`~/.codex/auth.json` 不存在，无变化）；
    2. 非 Codex 模型适配器仍 stub（StubAdapter grep 亲验仍在）；
    3. Windows/macOS 安装包+代码签名（71-3 结论不变；三平台签名零配置，证书待 Tan 采购）；
    4. 桌面真人点击验收（CDP 驱动交互仍不是真人点击；Batch 57 的"好用"审计是代码审计，诚实边界仍在）；
    5. 许可证/定价/渠道待 Tan 拍板（备料完成；仓库刻意无 LICENSE 文件，`ls` 亲验不存在）；
    6. CI workflow scope（`.github/` 亲验仍本地未跟踪 `??`；GitHub CI 从未运行；本轮未碰 `.github/`）；
    7. MCP SSE/HTTP/OAuth（routes 目录 grep 亲验：无 sse/oauth 路由文件）；
    8. 无真实隔离 Host（G8 的诚实边界：`verifyConfinement()` 恒 `verified:false`，是拒绝不是假装有 OS 边界）；
    9. 生产 attestation 签名待 Tan 密钥决策；
    10. Windows 工具探测未真机验证；
    11. 远程数据库驱动 / merge queue 多机 M2（待 Tan 拍板；M1 单写者开关在位，无变化）；
    12. 无测试生产环境；
    13. AT-001–AT-064 正式验收（正式验收资产不存在，仍 NOT_RUN；F66 行亲验在位）。
    **代码侧刻意不做**清单无动摇（F28 落地后该清单减一项：env-error HTTP 阳性路径已从"不伪造"变为"Tan 拍板后声明式实现"——口径变化已在 F28 行和 triggers 文档中如实记录）。
  - [x] 每批口径不变：实现 → 单测 → 全量复验（build 0 / 全量测试 / demos）→ 本地提交（主线稳定树亲验数字）。
- **C 质量与可信**：
  - [x] 全量测试持续全绿（Batch 75 收口人主线亲验数字，同基线：构建 0 错误；包套件 **2589/2589 pass**（2591 tests，2 skipped 合法跳过）；服务端全套 **500/500**；desktop tsc 0；electron tsc 0；smoke:boot OK）+ 本轮复验人亲跑受影响子集（服务端 13/13、db 16/16、policy 6/6，TMPDIR wrapper 下，0 fail）。
  - [x] README/文档与实现一致：走查文档总览（30 行 + Findings F1–F68，亲验连续）；KNOWN_LIMITATIONS 的 F61/F28/F12 三处同步（亲读 diff）；CHANGELOG Batch 74–75 小节在位。
  - [x] 独立复核：REAUDIT_BATCH21–73 连续无断档（`ls` 亲验）；Batch 73 复核 0 偏差（亲读结论）；卫生注记：REAUDIT_BATCH74 尚未产出（待收口人安排，非偏差）。
- **D 商业化最小要件**：
  - [x] 版本号与发布说明（CHANGELOG）：版本 0.1.0；Batch 74–75 小节已补（亲验）。
  - [ ] 许可证与第三方声明：备料完成；仓库**刻意无 LICENSE 文件**（默认保留所有权利，拍板前锁住）；**待 Tan 拍板**。
  - [ ] 定价/分发渠道：**待 Tan 拍板**（助手只备料）。

## 卫生注记（非偏差）

1. 本轮复验时主树干净、无兄弟在途改动：复验人亲跑了 build（0 错误，真实 exit code，约 10.6 分钟）+ electron tsc（0）+ 受影响子集（13/13、16/16、6/6）；全量数字引用 Batch 75 收口人同基线主线亲验（口径已在上文注明）。
2. 复验期间观察到兄弟任务在 `~/aifactory-re75` 跑自己的 build——未干扰、未触碰。
3. Batch 63 的 `git stash -u` 工作树事故的教训仍有效：本轮复验全程未运行 `git stash`；`git status` 干净（仅 `?? .github/` 未跟踪，为既定状态）。
4. 本机 `/dev/null` 状态：Batch 73 记录已于 2026-10-15 08:22 UTC 恢复为字符设备（环境改善）；本轮未重复亲验。
5. `/tmp` 是 512MB tmpfs；本轮所有测试走 `scripts/run-tests-tmp.mjs` wrapper（TMPDIR 指向 $HOME 下临时根），`/tmp` 零新增。
6. 无 FUSE 环境：`.AppImage` 本体从未被执行（历轮同款边界）。

## 总结论

**仍是"可运行的原型 + 持续收敛"，不是可交付产品。** 相对第十一轮翻绿 4 项：**F61**（v1 transition §17.2 授权轴检查落地，Board 拖拽 UX 变化如实记录）、**F28**（S8 经 operator-gated `envErrorSignal` 从负向对照翻为正向触发，declared-not-observed 限定如实）、**F12**（authority-conflict registry 落库，OPEN 冲突跨重启存活）、**桌面打包图标缺口修复**（BrowserWindow icon + files 列表）；Findings index **F1–F68 连续**，F61/F28/F12 均为 `closed (B75)`。**新增真实缺口 0 项**。13 项硬门槛亲验全部仍在 Tan/环境侧，一项没动——真实模型回路（Codex 登录）、三平台分发+代码签名、许可证/定价/渠道——这些决定"卖"的硬门槛，全部需要 Tan 本人动作或外部环境；代码侧已无可代劳的路径。**补充**：本轮基线是本地 commit（`848d71c`），按 Tan 2026-10-15 指令先不推送 GitHub；远端 main 仍为 `7e96bfe`（沿用既定结论，未重复跑 ls-remote）。
