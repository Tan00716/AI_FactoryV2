# 冷树构建门禁（V3.0 审计第 6 轮 #4）

## 落点（执行时定死，不再留二选一）

- 门禁形态：**本地门禁脚本**，不是 CI 接线。CI 在本仓库从未跑过
  （`.github/workflows/ci.yml` 未跟踪、token 缺 `workflow` scope），
  故门禁不以 CI 为落点；CI 恢复后可把同一命令接进流水线，
  但那是另一次变更，不在本项内。
- 门禁命令：`npm run gate:cold-build`（即 `node scripts/cold-build-gate.mjs`）。
- 主命令：`npm run build`（即 `node scripts/topo-build.mjs`）。
  旧 86 项手工 `&&` 顺序已删除，不存在新旧并存。
  回滚 = 恢复旧手工顺序并显性标注“冷树缺陷未修复”
  （旧串在 git 历史中，不另存副本）。

## 冷树的定义

冷 = checkout 中**没有任何 `dist/`**（`dist/` 在 `.gitignore` 中，
新克隆天然就是冷的）。`node_modules` 不属于冷的范畴：
`npm install` 或复制既有 `node_modules` 都会在 checkout 内生成
指向本 checkout 的 workspace 软链；构建失败与否只取决于
各依赖包的 `dist/` 是否已按依赖顺序建出来。

## 门禁的两种跑法

### 1. 静态顺序检查（默认，快，CI 可用）

```
npm run gate:cold-build
```

从各成员 `package.json` 的 `dependencies` + `devDependencies`
重算拓扑序，断言：无依赖环、全部 90 个成员在序中、
每个成员都有 `build` 脚本、每条声明边都指回前方、
审计四组顺序（employee-factory < qa、security < runtime、
codesearch < perfbench、runhistory < server）成立；
另扫描构建输入中的未声明导入，现值为 0。
任一断言失败即 exit 2，打印具体违反项。

### 2. 完整冷树构建（--cold，慢，发布前 / 改动构建脚本后跑）

```
npm run gate:cold-build -- --cold [--ref <git ref>] [--keep]
```

在 `$HOME/wt-gate-<时间戳>` 建隔离 worktree（绝不在共享主树上
checkout / stash），复制 `node_modules`（复制成功以
`.bin/tsc` 存在且 `@ai-factory/runhistory` 软链解析回 worktree 内
为准，`cp -a` 的属主警告不作为失败依据），校验 0 个 `dist/` 目录，
再跑 `npm run build`，最后删除 worktree（`--keep` 保留现场）。
`--ref` 默认 HEAD；验证未提交改动时，须先把改动文件拷进
worktree（门禁本身只构建指定 ref 的内容，不自动带未提交改动）。

## 失败如何判

- 静态检查 exit 2 = 顺序本身腐化（手工顺序回潮、边被删、
  成员丢 `build` 脚本、出现依赖环）。修顺序，不修包代码。
- 冷构建 exit 1 并打印 `FAILED: <包名>` = 该包编译失败；
  若失败包是 server 且报错为找不到 `@ai-factory/runhistory`，
  说明 runhistory 顺序保证（路径 (a)：server 声明依赖）已回归。
- 任何非 0 退出都是门禁失败；暖树通过不得冒充冷树通过。

## 本项定死的两个选择（审计 M12 / S9 要求）

- runhistory 顺序保证路径：**(a) 补声明**。`apps/server/package.json`
  已加 `"@ai-factory/runhistory": "0.1.0"`，拓扑边存在，
  runhistory 恒排在 server 之前。路径 (b) 两阶段构建被否决：
  它会把未声明的值导入继续留在原地。
- **同类推广**：反向验证时发现 server 还缺 `permissions`
  的构建覆盖（permissions 亦属 4 个漏建包之一，已声明，
  现随 90 成员全量构建覆盖），另经全树扫描发现 13 组
  未声明导入（server → coordination、debugger、depscan、
  mutation、profiler、recovery、refactor、resources、ssr、
  tasks、trojanscan；db → core；evaluation demo → memory），
  均按路径 (a) 补声明；`package-lock.json` 经
  `npm install --package-lock-only` 同步（并顺带补齐了
  提交时已滞后的 server 约 34 项、desktop 2 项等条目，
  改动全为新增，`npm ci --dry-run` exit 0）。
  门禁静态检查另含未声明导入扫描（`findUndeclaredImports`，
  构建输入为 packages 的 src/demo/tests、server 的 src、
  desktop 的 src/electron），现值为 0；该扫描有意不进
  构建路径（正则启发式不得让编译失败），由门禁与单测钉住。
- `npm test` 构建段：只修两处倒置（qa / employee-factory、
  runtime / security 均按全局拓扑序重排，perfbench 不在
  test 构建段中故第三处不影响）。test 构建段仍只建子集，
  其余测试包仍依赖暖树 dist——与改动前一致，不扩大本项范围；
  全量冷树正确性由主命令 `npm run build` 保证。

## 已知残留（不在本项范围，写清不藏）

- `demo:e2e*` 等演示脚本仍含手工 `npm run build -w` 顺序，
  它们不是文档化主命令，不在本项内；若未来成为主命令，
  须同样改走拓扑脚本。
- 每次全量构建 90 个成员，无增量跳过（与旧命令行为一致，
  仅多 4 个新覆盖成员）；增量缓存是未来优化，不是本项。
