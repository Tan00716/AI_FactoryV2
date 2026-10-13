# Batch 22 独立复核报告（REAUDIT_BATCH22）

基线：`72c8923`（Batch 22 提交）。复核人独立重跑/重算，未 commit。

**总结论**：Batch 22 的四项实质声明全部成立，未发现夸大或造假。另发现 1 处历史配置笔误的真相（desktop tsconfig 的 `"module":"Bundler"` 从来不是合法值——Batch 22 的修复正确，且此前各批"desktop tsc: 0"的报告是建立在从未真正跑起来的配置上的）。

## (a) 22-1 boot smoke：成立

- `scripts/boot-smoke.mjs` 亲读：spawn 的是 `apps/server/dist/index.js`（编译产物），无 ts-node、无 type-stripping；轮询 `GET /api/health` 到 200（60s 期限）；hermetic（临时 DB_PATH + 临时 FACTORY_SECRETS_DIR，日志实证 `vault=/tmp/factory-boot-smoke-*/secrets/vault.json`）；dist 不存在直接报错要求先 build。
- 亲跑通路：`npm run smoke:boot` → `[boot-smoke] OK`，exit 0。
- 亲跑失败路径：往 `apps/server/dist/index.js` 头部注入 `throw new Error("SIMULATED F6 CRASH")` → 崩溃栈打到 stderr、`[boot-smoke] FAIL: server exited early (code=1, signal=null)`，exit 1。注入能被冒烟捕获，证明它确实启动的是编译产物。随后 dist 已恢复（md5 与备份一致）。
- `package.json` 根 script `smoke:boot` 存在。未改产品代码语义（只新增脚本/工作流/文档 + 1 行 script），属实。

## (b) 22-4 F7 修复：成立

- `eventTypeOf` 在 `packages/db/src/outbox.ts:67` 导出，经 `packages/db/src/index.ts` 的 `export * from './outbox'` 对外暴露（运行时 `require` 验证为 function）。
- `apps/server/src/routes/v2-transitions.ts:513` 的 `outboxView` 用同一 `eventTypeOf(e)` 做投影，注释写明"确定性投影、不是第二个存储事实"。
- 独立重算：经 `SqliteOutboxStore.append` 写两条事件（intent COMMIT / REQUEST_COMPLETE），用 sqlite3 CLI 直接读 `outbox_events.event_type` 列 → `["WORKFLOW_TRANSITIONED","WORKFLOW_FINALIZED"]`，与 `eventTypeOf` 的返回值逐字一致。HTTP 值与 DB 列用同一函数，不可能漂移——"无法漂移"的说法成立。
- 测试：`packages/db` outbox 5/5（含新增 F7 条目），`apps/server/tests/v2-outbox.test.ts` 5/5（含 11×TRANSITIONED + 1×FINALIZED 的 HTTP 断言）。
- core 的 `OutboxEvent`/`StoredOutboxEvent` 接口确实未动（seam 稳定）。

## (c) 22-3 "不接线"审计：成立

抽查四项关键取证，全部复现：
1. `lockBuild` 生产调用方为零：全仓 grep（排除 tests/demo/dist）只有 `packages/cicd/src/build.ts` 的定义本身。
2. 无 builds 表：`packages/db/src` 无相关建表（唯一的 "builds" 命中是 AgentLoop 注释里的 route budgets，无关）。
3. 合并从不触发构建：`GitRepo.merge()` 两处（git.ts:283,463）与 `mergeQueue.ts:304` 全部硬编码 `artifactDigest: null`；`mergeQueue.ts:505` 的 `entry.artifactDigest = evidence?.artifactDigest ?? null` 只是把 merge 证据的 null 透传，无任何写入非 null 值的路径。
4. 因此 `artifactDigest` 保持 null + `'no artifact'` 注记是唯一诚实状态，"不接线"的决定正确——硬调 `lockBuild` 填 digest 会是编造。

## (d) desktop tsconfig 修正：成立，且挖出历史真相

- 旧值 `"module":"Bundler"`：用全新下载的 typescript-5.9.3 tarball 验证，`ts.ModuleKind` 枚举根本没有 Bundler（100 是 Node16），`tsc` 报 TS6046。**"Bundler"从来不是合法的 module 值**——旧配置从引入之日起就不可能 typecheck 通过。
- 新值 `module: "esnext"` + `moduleResolution: "bundler"`：`npx tsc -p apps/desktop/tsconfig.json` exit 0、0 错误；`--listFiles` 确认 42 个 `apps/desktop/src` 文件真实被检查，非空跑。
- 历史真相：此前各批报告的 "desktop tsc: 0" 是建立在一个从未真正跑起来的配置上的（TS6046 是配置级错误，exit code 在管道后被误读或未被察觉）。Batch 22 的修复让 desktop tsc 第一次真正跑起来且为 0——这一点比"修了个笔误"更重要，已建议记入仓库级 AGENTS.md。

## 口径修正核验

22-2 提出的 7/3/6 口径修正已在三处落地：`apps/server/tests/tools-execute.test.ts` 注释、`docs/KNOWN_LIMITATIONS.md`、`CHANGELOG.md`（各 1 处 "7/3/6"；残留的 "8/3/5" 均为修正注记中对旧口径的引用，正确）。

## 稳定树复验数字（本复核亲跑）

- `npm run smoke:boot`：通路 exit 0；注入崩溃 exit 1（大声失败）
- 服务端全套：**234/234**，fail 0（与 Batch 22 提交口径一致）
- `npx tsc -p apps/desktop/tsconfig.json`：0 错误（42 个 src 文件真实被检查）
- 根构建：Batch 22 提交时 0 TS 错误（本复核未重跑全量 build；dist 未被本复核污染——注入测试后已恢复 md5 一致）

## 残留边界（非缺陷，如实记录）

- `.github/workflows/ci.yml` 因 OAuth 缺 `workflow` scope 未能推送，CI 从未在 GitHub 上跑过——Batch 22 提交信息与 CHANGELOG 已如实说明，复核确认文件在本地 `~/workspace/ai-factory/.github/workflows/` 待 Tan 处理。
- F6 的 CI 冒烟只覆盖"编译产物能启动"，不覆盖"dist 跨包一致"的静态检查——这是设计取舍，不是缺口隐瞒。
