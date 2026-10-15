# Batch 62 独立复核（Batch 63-1）

基线：`0f27c30`（Batch 62）。复核在隔离 worktree（`~/reaudit-b62`，detached HEAD `0f27c30`，
`node_modules` + 各 `dist` 软链自同 commit 的主树），亲读 + 亲跑，主树零干扰；
复核后 worktree 已删除。

**结论：偏差 0 处。**

## (a) commit 文件清单 —— 成立

`git show --name-only --format='' 0f27c30` = **恰好 6 个文件**：

```
CHANGELOG.md
apps/desktop/src/api.ts
docs/FIRST_RUN_WALKTHROUGH.md
docs/KNOWN_LIMITATIONS.md
gap-audit/INV_COVERAGE_SWEEP.md
gap-audit/REAUDIT_BATCH61.md
```

`git diff 2bb5dfb 0f27c30 --stat -- 'apps/*.ts' 'apps/server/**/*.ts' 'packages/**/*.ts'`：
唯一 TS 改动是 `apps/desktop/src/api.ts`（+37/−2）。**零服务端产品代码改动**。

## (b) F48 修复 —— 成立

`git diff 2bb5dfb 0f27c30 -- apps/desktop/src/api.ts` 逐行亲读：

- 新增 `RawProject` 接口：文档化服务端完整 snake_case 原生形状（含 `[k: string]: unknown`
  兜底），注释写明"§6.1 原生契约，正确设计，不做服务端改名以免破坏 API 兼容性"。
- `Project` 接口扩展为显式 camelCase 契约：`id, name, description, path,
  status: 'active'|'archived', createdAt: string, updatedAt: string`（注释引用 F48 + F41 教训）。
- 新增 `toProject()`：snake_case→camelCase 映射。防御性 guards 逐项核对正确：
  - `id/name/description/path` 用 `String(raw.x ?? '')`（防 null/undefined）；
  - `status: raw.status === 'archived' ? 'archived' : 'active'`（未知值回退 active）；
  - `createdAt/updatedAt: typeof raw.created_at === 'string' ? raw.created_at : ''`
    （防未来形状漂移）。
- `projects: () => req<RawProject[]>('/projects').then((list) => list.map(toProject))`——
  全应用经同一归一化点。
- 服务端零改动（`apps/server/packages` 无改动）。服务端确实返回 snake_case 原生行：
  `apps/server/src/index.ts:998` 直接返回 `fdb.listProjects()` 的 `ProjectRow[]`
  （`packages/db/src/db.ts:1278` 亲验为 snake_case 裸行）。
- 消费者兼容性：`grep` 亲验全仓库只有三处调用 `api.projects()`
  （App.tsx:98、DispatchPanel.tsx:126、ManagerPanel.tsx:115），都只把结果装入 state，
  无任何手动构造 `Project` 的地方——接口增量 3 个字段是兼容变更，tsc 能通过的
  合理改动。F48 的回归场景（将来写 `project.createdAt`）不再静默 undefined。
- 修复决策正确（桌面端 58-5 模式）：服务端改名是破坏性 API 变更，今天没有真实 bug；
  snake_case 是 §6.1 原生契约，问题在面板端契约。

## (c) INV_COVERAGE_SWEEP.md —— 在位且内容实在

文件 19494 bytes（~19KB），未 commit。口径"**测试/走查钉死才算覆盖**，有代码没测试 = 未覆盖"——诚实。

- 覆盖 24 条（INV-01/02/04/06/12/13/14/16/17/18/19/20/21/22/23/24/25/27/29/31/32/33/34/35），
  每条列测试文件 + 一句话证据。
- 11 条真实缺口 G1–G11（INV-03/05/07/08/09/10/11/15/26/28/30）全部在位；
  优先级 G9 > G8 > G6 > G10。
- **抽点验证 G9（INV-26，最高优先级缺口）**：`packages/runtime/src/runner.ts:132-133`
  的 `adapter.invoke` 确实直接发送 prompt（`prompt: buildPrompt(agent, task)`），
  `scanForSecrets` 的唯一调用点在 `packages/memory/src/store.ts:165`
 （MemoryStore.write 路径）——报告声称成立，不是臆测。
- G10（INV-28 §45.4 自动治理）：抽点亲验 `packages/evaluation/src/loop.ts:268`
  的注释级承诺，"注释冒充实现"的反模式被报告点名，未冒充。

## 真实验证数字（隔离 worktree @0f27c30）

- desktop tsc：**0 错误**；electron tsc：**0 错误**
- 服务端全套：第一轮 **467/469**（2 fail）→ 第二轮 0 fail（grep 无 "not ok"，exit 0）→
  第三轮 **469/469，0 fail**。第一轮的 2 失败是环境侧抖动（后续两轮全绿；
  且本 commit 唯一产品代码改动是桌面 `api.ts`，不可能影响服务端测试）。

## 卫生注记（非偏差）

1. 主树有兄弟 Batch 63 任务在途工作（复核期间 AGENTS.md 已记录 63-3/63-4 的 stash 事故）
   ——复核全程在隔离 worktree，未碰主树，不受影响。
2. 报告写 REAUDIT_BATCH61.md 时 Batch 62 closeout 引用的"16/16 projects 测试"是
   62-2 收口人数字，本复核人未重跑该子集——全量 469/469 覆盖了它们。

**偏差：0 处。**
