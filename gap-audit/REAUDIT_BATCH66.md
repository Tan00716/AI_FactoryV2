# Batch 66 独立复核（REAUDIT_BATCH66）

基线：`9aadfd5`（Batch 66 收口，本地）。复核在隔离 worktree（detached HEAD `9aadfd5`，`~/reaudit-b66`，`node_modules` 软链自主树，各包 `dist` 在 worktree 内实建）亲读+亲跑；主树零干扰，全程未运行 `git stash`；worktree 已删除。

结论：**偏差 0 处**。

## (c) commit 文件清单 —— 成立

`git show --name-only 9aadfd5` = **恰好 26 个文件**，与 Batch 66 收口口径一致，无意外文件：

- CHANGELOG.md
- apps/server/src/{index.ts, routes/{context,evaluation,qa,workforce}.ts}（5 个产品代码文件）
- apps/server/tests/{evaluation-profiles-gate, qa-creation-gate-wiring}.test.ts（2 个新回归测试）
- docs/{FIRST_RUN_WALKTHROUGH, KNOWN_LIMITATIONS}.md（走查总览补到 Batch 64–65）
- gap-audit/REAUDIT_BATCH65.md + 9 张 walkthrough-b66-3-*.png（真机截图）
- packages/employee-factory/src/{index.ts, project-policy.ts}（新建 project-policy.ts）
- packages/runtime/{package.json, src/{harness,loop}.ts, tests/runner-trace-redaction.test.ts}

## (a) /api/profiles 门禁修复 —— 成立

- 逐行亲读 diff：只加了 `PROFILE_PREFIX = '/api/profiles'` 常量 + `inScope` 追加一行（`path === PROFILE_PREFIX || path.startsWith(PROFILE_PREFIX + '/')`），零契约变更。
- 确认"服务端自己的文档+handler 定义了契约、门禁是 bug"：文件头部文档第 7–8 行写着 `GET /api/profiles`（leaderboard）和 `GET /api/profiles/:agentId`（agent profile）；handler（141–146 行附近）实现了两者；只有 `inScope` 门禁遗漏了它们，导致请求被通用路由回 404。**不是 58-5 式的"桌面端映射"场景**（58-5 是服务端返回原生 snake_case 正确、面板端契约虚构；这里是服务端自己的契约没被自己的门禁放行）。
- 亲跑：`evaluation-profiles-gate.test.ts` **2/2**（A `/api/profiles` → 200 且 body 有 profiles 数组；B `/api/profiles/does-not-exist` → handler 的 404 文案而非通用 "Not found"）。

## (b) trace 脱敏 + project-policy.ts —— 成立

- **trace 脱敏**：`packages/runtime/src/loop.ts` 的 `recordTrace` 和 `packages/runtime/src/harness.ts` 的 `trace()` 两个 choke 点都接入 `redactText`（`@ai-factory/events`，bare-specifier，dual-mode 合规）；注释把残余边界写清楚了（无 key 前缀的裸高熵字符串抓不到——best-effort，不冒充）。
- **project-policy.ts**：亲读全文——`DEFAULT_FACTORY_POLICY` 与旧 `workforce.ts` 的 `FACTORY_POLICY` 逐值一致（maxChildren 6、maxDepth 3、maxConcurrentAgents 8、maxTotalAgents 64、maxRuntimeMs 1800000、maxBudget 1000、roles/models/tools/permissions 列表相同），确为字节级搬移；`QA_CREATION_POLICY` 的三项扩展（`allowedTools += 'filesystem'`、`allowedModels += 'default'`、`maxChildren` 6→16）每项都有文档化原因（否则接门会打断现有 QA 流）；`FactoryPolicyStore`（按 project key 内存存储、未配置回退默认、set/get/clear）语义清楚。
- **qa.ts 接线**：`GET /api/qa/org`（ensureQaLead）和 `POST /api/qa/specialists`（createQaSpecialist）两个创建点都经 `qaCreationGate(ctx)`，`GovernanceError → 403 {governance:true}`（沿用 workforce.ts 映射）；`RouteContext.factoryPolicyStore?` optional wiring（沿用 backupAccess 模式）；`index.ts` 构造实例注入。`workforce.ts` 改用 bare-specifier import（dual-mode 合规，`needs-human-policy-violation.test.ts` 的注释声称依然成立）。
- 亲跑：`runner-trace-redaction.test.js`（编译产物）**4/4**；`qa-creation-gate-wiring.test.ts` **5/5**。

## (d) 走查文档数字抽点 —— 成立

- Walkthrough index：表头 `(Batch 65)`；数据行 **30 行**（v1–v8 共 8 行 + 22 个 legs，逐行数过；66-2 的"22 + 8"口径一致）。注：脚本直接数 `|` 行会得到 31（含表头行），表头行除外才是 30。
- Findings index：表头 `(F1–F62)`；F1–F62 **序号连续无断号**（62 个数据行，逐项亲验）；**F48 = closed (B62)**。
- KNOWN_LIMITATIONS 第 68 行：`Walkthrough index 30 行` + `Findings index（F1–F62）`，口径一致。

## 真实验证数字（隔离 worktree @9aadfd5）

- 根构建：**0 错误**（`npm run build`，`grep -c "error TS"` = 0）
- desktop tsc：**0**；electron tsc：**0**
- 服务端全套：**490/490，0 fail**（第一轮即全绿，无环境抖动；`FACTORY_SECRETS_DIR=~/b67-1-secrets`，避开 /tmp tmpfs）
- npm test 全量（2567）未在 worktree 重跑——scope 内相关包新测试已逐项亲跑（runtime trace-redaction 4/4），server 侧 7 条新测试被 490/490 覆盖

## 卫生注记（非偏差）

1. 首轮目标测试曾失败（evaluation-profiles-gate + qa-creation-gate-wiring：pass 0 fail 3；runner-trace-redaction：`Could not find 'dist/tests/runner-trace-redaction.test.js'`）——原因是 worktree 里各包没有 dist（我只软链了根 node_modules 和根 dist）。在 worktree 内跑 `npm run build`（0 错误）后全部通过。环境搭建问题，非代码偏差。
2. 本轮 worktree 的各包 dist 是在 worktree 内实建的（只软链了根 node_modules + 根 dist），**没有**回写主树 dist——比 64-1 的 round 更干净（64-1 曾通过 dist 软链回写主树 dist，gitignored 同源码无污染）。
3. 复核期间主树无兄弟任务在途改动（66-1 时代的 `gap-audit/SELLABLE_REVERIFY_BATCH64.md` 已提交）；`/dev/null` 缺失状态无变化（625 bytes 普通文件，容器/mknod 权限问题这边修不了；复核期间 git 命令工作正常）。
