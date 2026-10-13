# Batch 30 独立复核报告（Batch 31-1）

> 复核基线：`d81857a`（Batch 30，已推送）。复核方式：在基线 commit 的干净 worktree（`git worktree add d81857a`，与主工作树隔离）上亲跑构建与测试 + 逐条亲读代码。
> 说明：复核期间主工作树上有 Batch 31 在途改动（含未跟踪的 `apps/server/src/routes/builds.ts`，即 `/api/builds` 只读路由——那是 Batch 31 的后续工作，不是 Batch 30 的内容）。本报告所有数字均来自干净基线 worktree。

## 主线验证数字（基线亲跑）

- 根 `npm run build`：**0 TS 错误**（注：`grep -c` 计数为 0 时退出码为 1 属正常现象，非构建失败）
- `npm test`：**2304/2304**，0 失败
- `node --test apps/server/tests/*.test.ts`：**275/275**，0 失败
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误
- `npm run smoke:boot`：**OK**（编译产物启动，`/api/health` → 200）

与 Batch 30 报告声称的基线数字逐字一致。

## (a) 可售清单复验报告（SELLABLE_REVERIFY_BATCH30.md）诚实性抽查

1. **A-真实模型回路"仍 BLOCKED"**：成立。`apps/server/src/routes/model-router.ts`（基线亲读）：`GET /api/router/account` 先经 `defaultLiveAccountQuery()` 问真实 Codex app-server（CodexAdapter，5s 超时），失败 → null → stub；live 结果经 `getAccountStatus({ live, liveSource: 'codex-app-server' })` 注入并标注来源，stub 形状的 usageNote 自标 STUB（INV-29 永不伪装 live 数据）。接线真实，接线完成度与"缺登录本身"的边界表述诚实。`git log` 确认接线 commit `6b55110`（"live Codex account status in router account route"）真实存在。
2. **F9"后台构建落地无 /api/builds 只读端点"**：在基线 `d81857a` 下成立——干净基线树中 `apps/server/src/` 无任何 `/api/builds` 路由（grep 确认）。走查 b30 用 DB 直读轮询而非 HTTP 面，与现状一致。在途的 `routes/builds.ts` 是 Batch 31 的后续工作，恰好说明 F9 被当作真实缺口接走了，不构成 Batch 30 的虚假陈述。
3. **C"文档与实现一致翻绿"**：成立。`git show d81857a -- docs/KNOWN_LIMITATIONS.md` 确认四处过时条目确被改写为"已关闭"并注明复验证据与诚实边界：账号状态接线、§40→§36 构建↔证据绑定、Git Broker drain 并发、Linux 安装包/桌面壳。CHANGELOG Batch 20 小节存在（Batch 24 已补，Batch 30 未动）。
4. **"独立复核追加 Batch 25–28"**：成立。`gap-audit/REAUDIT_BATCH25.md`～`REAUDIT_BATCH28.md` 均在树上。
5. **"KNOWN_LIMITATIONS 现共 58 条目"**：轻微口径偏差——按顶层加粗条目数实际为 **54** 条（`grep -cE "^\s*- \*\*"`）。报告人可能把子条目或章节标题计入。属计数口径问题，非实质性夸大，特此纠偏。

## (b) walkthrough 第三版（first-run-walkthrough-b30.test.ts）

- 基线亲跑：**1/1 全绿**（真 server 双 boot、临时 DB、中途真 SIGKILL）。
- 亲读断言确认真链路：D1–D5 db broker 全链（403 PRIVILEGE_DENIED 失败链、503 NO_ENGINE 失败链、白名单执行、runbook 模板执行、绑定参数值不进审计——PARAM_SENTINEL 全审计 dump 缺席）；B1 真实 merge → 真实构建（`node -e` 写文件）→ 64-hex 真 digest → CycloneDX 1.5 SBOM 落盘（含 `left-pad@1.3.0` / `@scope/right-pad@2.0.1` 与 `ai-factory:sbom:provenance` 诚实属性）；R1 保留 evaluate 纯 dry-run（0 候选、无策略=永久保留）；M1 MCP register→approve→install→launch；SIGKILL 后 boot B：live 表诚实为空、sleeper 为 ORPHANED 且 note 含 "fate is unknown"、信任保持 approved、构建记录与 SBOM 跨重启存活、审计 hash 链 verify 通过。
- 报告声称"连续三次 1/1"——本复核在基线亲跑一次为 1/1；另亲跑走查第二版（first-run-walkthrough-b21.test.ts）同样 **1/1**，与报告的"demo:e2e-new 1/1"口径一致。
- F8/F9 Low findings 如实：F9 的"无 /api/builds 读端点"在基线成立（见上）；`demo:e2e-v3` 脚本在基线 package.json 中存在且定义正确。

## (c) 缺口扫荡报告（GAP_SWEEP_BATCH30.md）三个"早已关闭"候选

基线亲跑全部成立：

1. **账号状态真实接线**：`apps/server/tests/model-router-account.test.ts` **7/7**（命中/不可达/抛错三路）。Batch 3 接线 commit 真实。
2. **§40→§36 构建↔证据绑定**：`apps/server/tests/build-runner.test.ts` **9/9**（真实构建 e2e：成功 digest 与独立 lockBuild 重算一致、失败/超时/策略拒绝、SBOM 生成）。"文档滞后于实现"的诊断成立——旧文档断言的"无 builds 表"前提确已被 Batch 23/24/25 推翻。
3. **Merge Queue 跨进程 drain 并发**：`packages/git/dist/tests/merge-queue-drain.test.js` **4/4**（含双真进程竞速、每 entry 恰好一次）。

## 结论

**Batch 30 的实质声明全部成立，未发现夸大或造假。** 测试基线数字（2304/2304、275/275、tsc 0、smoke OK）在干净基线 worktree 上逐字复现；可售复验的 BLOCKED/翻绿条目均有代码依据；走查第三版真链路 1/1；扫荡报告的三个候选确为"文档过时、功能早已落地"。

两处如实记录（非造假）：① "58 条目"实为 54 顶层条目（计数口径偏差）；② 主工作树在途的 `/api/builds` 只读路由是 Batch 31 后续工作，不在 Batch 30 基线内，F9 在基线下的表述成立。
