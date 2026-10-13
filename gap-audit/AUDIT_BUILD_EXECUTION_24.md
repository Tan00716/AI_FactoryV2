# Batch 24-2 审计：在 merge 上下文中"执行一次真实构建"意味着什么

基线：`8d7c55f`。结论：**可行**，但只能按"显式配置"模型做——工厂无法凭空知道如何构建任意被合并的仓库。

## 1. 五个诚实问题与答案

| 问题 | 审计结论 |
|---|---|
| 构建命令从哪来 | 唯一诚实来源是显式运维配置 `FACTORY_BUILD_COMMAND`。仓库内容、HTTP 输入一律不接受为命令来源。未配置 = 功能关闭，记录诚实保持 `NOT_EXECUTED`（Batch 23 状态）。 |
| 在哪跑 / 隔离 | `git worktree add --detach <rev>` 的干净工作区，`FACTORY_BUILD_WORK_ROOT`（默认 `os.tmpdir()/factory-builds`），绝不碰 live 仓库工作区、绝不跟随移动的分支 tip。执行走与 `/api/exec` 完全相同的策略（deny patterns + 二进制白名单 + 控制面目录守卫）。**不是沙箱**：构建命令会执行仓库控制的代码（如 `npm run build` 跑 package.json scripts），与服务器同 OS 权限——只对信任的仓库启用，这是文档化的边界，不是隐藏的假设。 |
| 超时 | `FACTORY_BUILD_TIMEOUT_MS`（默认 10 分钟）；`runCommandPipe` 语义——超时杀整个进程树（SIGTERM→grace→SIGKILL），不是只杀直接子进程。 |
| 产物去哪 | 产物留在工作区；无论成功失败，工作区在运行后删除（`worktree remove --force` + `rm -rf`，清理失败大声审计 `BUILD_CLEANUP_FAILED`）。不复制、不发布产物——那是部署面的事。 |
| digest 算什么 | §40 的 digest 就是 `lockBuild(definition)`——锁定输入的摘要，不是输出字节的哈希。诚实要求：revision=真实 candidate SHA；lockfileHash=工作区真实 lockfile 的 sha256（找不到就是缺失）；toolchain=显式配置或**真实执行环境**（`node <ver> <platform>-<arch>`，文档化、可覆盖，绝不用仓库启发式猜测）；buildDefinitionHash=sha256(命令)；configHash=配置的真实文件哈希（未配置就是缺失）；dependencySources=真实找到的 lockfile 路径。任一必填输入缺失 → digest 保持 null 并点名缺失项——调 `lockBuild` 填编造输入等于伪造 digest。 |

## 2. 为什么"默认执行"不可行

- 工厂不知道任意仓库的构建方式；从仓库内容推断构建命令 = 执行不可信输入，是安全红线。
- merge 是同步 HTTP；构建可能耗时数分钟——必须后台化（进程内 FIFO 串行；重启后遗留的 `NOT_EXECUTED` 不补跑，避免意外重执行）。
- `lockBuild` 要求全部输入非空；merge 上下文天然缺 toolchain/config（Batch 22-3 已审计）——严格模式下 digest 经常为 null，这是诚实的代价，不是缺陷。

## 3. 实现（本批已做，未 commit）

- `packages/db`: `builds` 表状态机 `NOT_EXECUTED → SUCCEEDED | FAILED`（单向，终端行不可改写，缺失 id 大声拒绝）；`definition: string|null`（锁定的 JSON）；新增 `exit_code`/`failure_reason`/`completed_at` 列 + `migrateBuildsTable`（Batch 23 形状的老库原地迁移）。
- `packages/cicd/build.ts`: `detectLockfiles`/`sha256File`/`sha256String`/`assembleBuildDefinition`（缺失输入点名，不编造）。
- `packages/git`: `GitRepo.worktreeAddDetached`（`--detach` 钉住精确 revision）。
- `apps/server/src/build-runner.ts`（新建）: 后台 runner；成功→`markSucceeded`（真 digest 或点名缺失）+ 审计 `BUILD_SUCCEEDED`；失败/超时/策略拒绝→`markFailed` + `BUILD_FAILED`；digest 为真且 taskId 存在时，把 merge 证据的 `artifactDigest` 回填（`'no artifact'` 注记移除；sealed/缺失则审计跳过，不致命）。
- 接线：`RouteContext.buildRunner?`（可选）、`index.ts` 按 env 构造、两条 merge 路径 `enqueue`（fire-and-forget，merge 响应永不阻塞）。

## 4. 验证

- `packages/db` 全套 137/137（含新增流转/迁移测试 3+1）；`packages/cicd` 111/111（含新增组装测试 5）；`packages/git` 67/67。
- `apps/server/tests/build-runner.test.ts` 7/7：真 server + 真仓库——成功路径 digest 与独立 `lockBuild` 重算逐字一致、证据绑定、`'no artifact'` 移除、工作区清理；失败路径（exit 3）FAILED + 原因；策略拒绝（`rm`）FAILED 且未执行；未配置时记录保持 `NOT_EXECUTED`。
- 根 `npm test` 2194/2194，服务端全套 244/244，构建 0 TS 错误。
- 测试中真实踩中：workRoot 若设在 `dirname(DB_PATH)` 内会被控制面守卫正确拒绝（构建工作区不许进控制面数据目录）——这是策略按设计工作，不是 runner 缺陷。

## 5. 残留边界

- 多机/分布式构建未做（进程内 runner）。
- 产物不发布、不复制；SBOM/attestation 仍 null（无构建产物清单可引用）。
- 证据绑定要求证据未 sealed；`taskId` 为 null 的合并跳过绑定（审计留痕）。
- 构建执行仓库代码——仅对信任仓库启用（见 runner 头注释的安全边界）。
