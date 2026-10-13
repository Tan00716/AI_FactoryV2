# 独立复核报告：Batch 21 四个子批次（Batch 22-2）

> 复核基线：`cd47029`（Batch 21 提交，远端 main 已验证一致）。
> 复核方未参与 Batch 21 开发。证据标准：当前源码 + 复核方亲自运行的测试/命令/脚本输出。
> 注意：复核期间兄弟 Batch 22 子任务正在同一工作树上改动（F7 修复在途），
> 21-4 的验证因此在隔离 worktree（`cd47029` 纯净检出 + 仅 db/server 两个包重编）上另行复验，
> 以排除在途干扰。复核不改任何产品代码，未 commit。

## 总结论

四项实质声明**全部成立**，未发现夸大或造假。发现 **1 处计数口径偏差**
（21-1 报告与测试注释中的 "8 拒 / 5 失败" 应为 7/3/6，功能实质不受影响），
以及 1 次复核中观察到的**在途破坏**（兄弟 Batch 22 的 F7 中间态曾导致走查 404，
兄弟修复后已恢复——非 Batch 21 缺陷）。

---

## (a) 21-1 工具执行面统一 — 实质成立，计数口径有 ±1 偏差

**取证方法**：读 `apps/server/src/tool-runner.ts` 全文、`packages/tools/src/executor.ts`
接缝、`apps/server/src/routes/tools.ts` 接线；独立跑
`apps/server/tests/tools-execute.test.ts`（11/11）与
`packages/tools` 的 `implementation-gate`（7/7）；独立枚举 16 条内置定义的
`implementationStatus`。

**核实结论**：

1. **"(b) 契约分层"论证成立**。`tool-runner.ts` 头注释与 executor 头注释确实论证了
   不二合一的理由（Harness 是 name→Permission + throw-on-deny 的智能体执行面；
   ToolExecutor 是 capability grant + record-on-deny 的审计直调面；规格分属 §26/§33）。
   这是工程判断，不是"没做完"的包装——统一的是门禁与审计接缝，代码层面可验证。
2. **原型假成功 runner 已消除**。`routes/tools.ts:35-36` 接的是
   `createServerToolRunner()` + `createImplementationGate()`；旧的"所有工具回 exitCode 0"
   的 runner 在树中已不存在。`default:` 分支对未接线工具返回 exitCode 1 且 stderr
   写明 "no implementation is wired into this server's tool executor —
   refusing to fake execution"（测试 `implemented-but-unwired tool FAILS loudly` 钉住）。
3. **门禁语义如报告**：definition-only → DENIED（`UNSUPPORTED_CAPABILITY`）；
   runner 抛 `ToolDeniedError` → DENIED 记录（executor.ts:290），不再是 TIMED_OUT；
   DENIED/FAILED 转发服务端审计 `TOOL_EXEC_DENIED`/`TOOL_EXEC_FAILED`（tools.ts:109）。
   测试钉住：`runtime.echo/add` 真执行（SUCCEEDED 带真实 payload）、
   `shell.execute` 走共享命令策略（whitelist 拒绝 → DENIED `POLICY_DENIED`）。
4. **计数偏差（建议主线修正措辞）**：16 条内置 = 8 条 definition-only（含 `shell.execute`）
   + 8 条 implemented（含 `runtime.echo/add`）。服务端接线 3 条
   （`shell.execute`、`runtime.echo`、`runtime.add`）。因此真实矩阵是：
   **7 条经 gate 拒绝**（`shell.execute` 虽在目录中标 definition-only，
   但被服务端接线因而通过 gate）+ **3 条服务端实装** + **6 条 runner 响亮失败**
   （git.commit/push/pull_request、test.run、ci.pipeline、deploy.run）。
   报告写的"8 条 definition-only 全部 DENIED"与"其余 5 条响亮失败"各差 1；
   测试注释 "the other 5 implemented-but-unwired FAIL loudly" 同样差 1；
   KNOWN_LIMITATIONS 的"8 条定义-only 全拒、3 条服务端实装全通、其余 5 条响亮失败"
   沿用了该口径。**功能实质无影响**（没有任何一条能静默成功——这是测试真正钉住的），
   但建议把三处措辞改为 7/3/6。
5. `shell.execute` 经此面在真实服务端仍 fail-closed DENIED（目录策略 HUMAN_APPROVAL、
   服务端未接 approval checker，§23.4 规定行为）——代码与注释一致，口径诚实。

## (b) 21-2 MCP 注册表 + 信任状态落库 — 成立

**取证方法**：读 `apps/server/src/mcp-persistence.ts`（234 行）全文；
独立跑 `apps/server/tests/mcp-registry-persistence.test.ts`（3/3）、
`packages/mcp` durability（4 条）+ `packages/db` mcp-servers（3 条）共 7/7；
核对测试确为真 SIGKILL（`child.kill('SIGKILL')` 后同 DB 文件重开）。

**核实结论**：

1. **真 SIGKILL e2e 成立**：测试启动真 server 二进制，注册→trust approve（HIGH/AUTO）
   →install→launch **201**→SIGKILL→同 DB 重开→trust 视图仍 HIGH/AUTO（非 BLOCKED）
   →launch **201**（非 403）。复核方独立重跑 3/3 全绿。
2. **健康标 stale、不继承**：`hydrateMcpRegistry` 对有 health 的行只调
   `store.markHealthStale`，不装入 live 注册表（mcp-persistence.ts:148-152）。如报告。
3. **机密剥离**：`stripSecretValues` 把 `runtimePolicy.stdioEnvFixed` 的值逐键置 null
   （键保留），`credentialRefs` 本来就是引用名。落库前调用点在 `serverToRow`。
   哨兵字节扫描测试在 3/3 内。
4. **水合不产生新事件**：`hydrateInstall`/`hydrateAssessment` 直接设状态；
   `registeredAt` 与 append-only history 逐字恢复（mcp-persistence.ts:143-146）。
   腐坏行跳过并 loud log（:117-123），不炸启动。
5. 报告中"规格 §34/§46 无重启保持信任的明文 MUST，按可售耐久做缺口关闭"的
   自我限定已写入 KNOWN_LIMITATIONS，口径诚实。
6. 边界"多进程同写一 DB 文件未做（单实例假设）"如实保留。

## (c) 21-3 §36 git evidence 五字段 — 成立，独立重算逐字一致

**取证方法**：独立跑 `packages/git` git-evidence-36（4 条）+
   `apps/server` git-merge-evidence-36（1 条），5/5 全绿；自建真 git 仓库，
   调包的 `GitRepo.merge()`，独立重算五字段；核对两条路由接线；
   通读 `gap-audit/REAUDIT_GIT_EVIDENCE_36.md`。

**核实结论**：

1. **五字段是真值**（复核方独立重算）：
   - `baseSha`/`candidateSha` 与独立 `git rev-parse` 逐字一致；
   - `diffHash` 与 `git diff base..candidate` 原始 stdout 的 sha256 逐字一致
     （`261a8eb0…`；复核中复现了报告所述陷阱：`printf '%s'` 去掉末尾换行会得到
     不同哈希 `69407870…`，必须 hash 未 trim 的原始字节——报告的方法论注记属实）；
   - `targetSha` = 合并后 target tip（与 candidate 同值，快照语义在注释中写明）；
   - `artifactDigest` = null，如实记录缺失而非占位。
2. **"最后一公里丢失"的诊断成立**：两条路由现均传入字段
   （git.ts:484 `mergeEvidencePayload(merged, result.evidence)`；
   git.ts:554 `mergeEvidencePayload(mergedPr, mergedEntry)`）。
3. REAUDIT 报告诚实：先审计后改码、取证方法写清、残留边界
   （artifactDigest 恒 null、外部工具合并走 null 路径、旧证据不回填、
   code_change 的 targetSha 是读取时刻 HEAD）全部如实列出，无美化。

## (d) 21-4 首次运行走查重跑 — 成立

**取证方法**：在 `cd47029` 纯净 worktree（db/server 两包重编，其余 dist 原样拷贝）
   独立跑 `apps/server/tests/first-run-walkthrough-b21.test.ts`：**1/1 全绿**；
   在当前主树（兄弟修好在途破坏后）再跑一次：**1/1 全绿**。
   通读 `docs/FIRST_RUN_WALKTHROUGH.md` 第二版与
   `SELLABLE_CHECKLIST.md` 的 A 项注记。

**核实结论**：

1. 走查是真链路：真 server 二进制 + 临时 DB，两 boot 中间真 SIGKILL；
   W1–W19（派发轴 403、v2-transition、outbox、Secret Broker 注入+脱敏、
   交互式 PTY SSE、备份计划、真 git worktree、MCP 注册→信任审批→安装→人工评审
   →launch 201→停服、PROD 部署 park→杀进程→重启→approve SUCCEEDED、
   审计哈希链跨 boot 验证）全部真实断言，非自证。
2. **复核中观察到的在途破坏**（非 Batch 21 缺陷）：复核中段兄弟 Batch 22 的 F7
   修复曾把 `apps/server/dist` 重编为中间态，走查在主树上两次 404
  （`GET /api/tasks/:id/outbox`，ensureSeeded 路径）；兄弟推进修复后主树走查
   恢复 1/1。纯净基线 worktree 上始终 1/1。结论：Batch 21 交付的走查本身是绿的；
   并行改树期间的瞬时失败不应计入 Batch 21（Batch 21 主线收口时全套 233/233
   已是稳定树数字）。
3. 文档口径诚实：`FIRST_RUN_WALKTHROUGH.md` 第二版如实记录 F6（部分构建 dist
   不一致，CI 应加启动冒烟）与 F7（outbox 词汇未对齐——Batch 22 正在修，
   文档已标注）；`SELLABLE_CHECKLIST.md` 的 A 项注记列出已验证项与
   环境/外部 BLOCKED（Codex 登录、Windows 安装包与签名、真机 UI 点验），
   未把走查说成"可售"。

---

## 残留问题与建议（非阻塞）

1. **21-1 计数措辞**：报告、测试注释（tools-execute.test.ts:230）、
   KNOWN_LIMITATIONS 三处 "8 拒 / 5 失败" 建议改为 7/3/6（`shell.execute`
   是目录 definition-only 但服务端接线）。功能无影响。
2. **F6 仍在**：`npm run build` 全量是走查与 server 套件的前置要求；
   Batch 22 在途的 `scripts/boot-smoke.mjs`（复核中观察到已新建）正是对症下药，
   待其落地。
3. **并行改树纪律**：本次复核再次证明——子批次自测数字只有稳定树复验才算数
   （Batch 21 主线收口已因此修了 3 个真接缝问题；本次复核又撞上一次在途破坏）。
   仓库级 AGENTS.md 的双模式 import 规则与 hermetic 测试要求已记入，
   建议后续批次开工前先确认树上无在途 dist 重编。

## 复核方独立运行的真实数字

| 项 | 复核运行 |
|---|---|
| tools-execute.test.ts | 11/11 |
| tools implementation-gate | 7/7 |
| mcp-registry-persistence.test.ts | 3/3（含真 SIGKILL e2e）|
| mcp durability + db mcp-servers | 7/7 |
| git-evidence-36 + git-merge-evidence-36 | 5/5 |
| §36 五字段独立重算（真仓库） | base/candidate/diffHash 逐字一致 |
| first-run-walkthrough-b21（纯净 cd47029 worktree） | 1/1 |
| first-run-walkthrough-b21（当前主树，兄弟修复后） | 1/1 |
| db/server 在纯净基线重编 | 0 TS 错误 |
