# Batch 48 独立复核报告

- 复核基线：`52b8413`（Batch 48 commit）
- 复核方式：隔离 worktree（detached HEAD `52b8413`，`node_modules` 软链主树）亲读代码 + 亲跑测试，主树零干扰，worktree 已删。
- 零产品代码改动（复核人只读、只跑、只写本报告）。

## 结论：Batch 48 的实质声明全部成立，未发现夸大或造假。偏差 0 处。

## (a) terminal 跨块脱敏——成立

**亲读 `packages/secrets/src/broker.ts`（`createCrossChunkRedactor`）：**

- **气密阈值**：每个 push 在 `pending + chunk` 合并文本上 longest-first 匹配，只提交满足 `match.end <= len - carryLen`（`carryLen = 最长密钥长度 - 1`，码点计）的匹配。注释中的证明复核人独立验证成立：任何能推翻已提交匹配的更长值长度 ≤ carryLen+1；它若与已提交匹配 `[s,e]` 重叠且延伸到合并文本之外，则其起点 s' > len − carryLen − 1 ≥ e − 1，即 s' ≥ e——不可能与已提交匹配重叠。而完全落在合并文本内的更长值，longest-first 匹配当时已优先选中它（`claimed` 数组保证不重叠），短匹配根本不会被创建。证明成立。
- **前缀重叠修复**：`AB`/`ABCDEF` 切成 `xxAB`|`CDEFyy` 场景，复核人手动推演确认"AB"匹配被正确延迟（第一块阈值为负，全 hold），第二块合并后 `ABCDEF` 获胜，输出 `xx***yy`，无泄漏。简单版（脱敏后丢尾）在此场景会泄出 `CD`——测试文件第 123 行即为该泄漏复现用例，注释写明了被否决的方案。
- **emitEnd 负值钳住**：`let emitEnd = commitAll ? cps.length : Math.max(0, cps.length - carryLen)`——下界 0 钳住在位（fuzz 抓到的 `combined.length < carryLen` 时 `slice(0, 负数)` 泄漏的修复）。复核人确认逻辑：combined 短于 carry 时全部 hold，pending = 全部，无输出。
- **其他性质亲验**：carry 按码点切割（`[...s]`，astral-plane 不断裂）；未提交字节 raw 留 pending 尾；`flush()` 提交一切；hits 只在提交时计数（延迟匹配下一 push 重算，恰好计数一次）；空值过滤；长度 ≤ 1 的值 carryLen = 0 透明直通。
- **honest boundaries**：Batch 48 的报告声明了三条边界——(1) 尾部 ≤ carryLen 码点滞后一个块/到 flush 才发出；(2) carryLen = 最长密钥 − 1，10KB 级密钥则滞后同量级，当前均为短 token 可接受；(3) 密钥值本身含 `***` 的病态构造未处理（随机 token 不成立）。三条均在代码注释与测试假设中一致，无美化。

**亲读 `apps/server/src/routes/terminal.ts` 接线：**

- 会话创建时改存 `createStreamRedactor` 工厂（捕获 `secretValues` + `actor` + `session.id`）；hit 上报仍走 `recordRedactionHit` → `SECRET_REDACTED_HIT`，语义未变。
- 每个 SSE 订阅建独立实例；**backlog 和 live chunk 走同一实例**（backlog/实时边界覆盖）；chunk 全被 hold → 返回 `''` 跳过发送（非写失败，注释明示）；`onClose` 与"订阅时已死"路径都在 `close` 事件**之前** flush 尾部。
- `createTerminalStreamRedactor` 导出为测试缝；在途前（Batch 48 前）创建的会话无 factory，降级为 identity——注释写明"会话永不跨重启"，降级路径诚实。

**亲跑（隔离 worktree，root build 后）：**

- `packages/secrets/dist/tests/cross-chunk-redaction.test.js`：**13/13**，0 fail（含 50 轮随机切分 fuzz，逐字节 + hit 数对比整流 `redactSecretValuesCounted`）。
- `apps/server/tests/terminal-cross-chunk-redaction.test.ts`：**5/5**，0 fail（dist import，按 dual-mode 铁律）。

## (b) 走查 v8——成立

- 亲读 `apps/server/tests/first-run-walkthrough-b48.test.ts`：单 test、纯 HTTP、零 mock，两次真实 server 启动。P1 四项拒绝码断言在位（`PROJECT_PATH_OUTSIDE_ROOT` / `NOT_ABSOLUTE` / `NOT_FOUND`，含 `<root>/../etc` 转义）；P1(c) 的 live DB plant 威胁模型是**服务运行时直接写 DB**（绕过 HTTP 门控），断言 `/etc` 从未被 walk 且被 plant 行记入 `manifest.skippedProjects`；M1(on) 断言 202 + `drainPending: true` + entry 保持 QUEUED，M1(off) 断言 201 + entry MERGED（老行为）。链路真实。
- F24–F25 已写入 `docs/FIRST_RUN_WALKTHROUGH.md`（Batch 48 一节，行 443/453）：F24（live DB plant 依赖请求间无打开事务，timing-adjacent，flake 替代方案 stop-plant-restart）、F25（24xxx–44xxx 随机端口池共享，冲突报成响亮的启动失败）。复核人确认两条为 Info 级走查卫生，无产品含义冒充。
- 亲跑 `npm run demo:e2e-v8`（隔离 worktree，11 包构建链）：**1/1**，0 fail。

## (c) KNOWN_LIMITATIONS 扫荡——成立（5 处逐项亲验）

1. **结论基线过期**：第 110 行已更新为 `8004764`（构建 0、npm test 2504/2504、服务端 432/432、desktop tsc 0、smoke OK）——与 Batch 47 主线亲验数字一致。
2. **§81 边界追加 Batch 44/45 实测口径**：narrative 持久化 8/8（走查 v7 N1 钉住"活过持久化"）；env-error HTTP 阳性路径不存在（三重证据 + 负向对照 + 走查 v7 E1(b) 钉住）；Batch 45 窄版放行"只是让发射在 tool 层原则上可达，没有伪造可达性"——口径诚实，在位。
3. **两处旧句 `` `POST /api/runtime/run` ``**：`grep -c "api/runtime/run'"` = 0（已全部改为 `/api/runtime/runs`）；复核人抽查 `apps/server/src/routes/runtime.ts:1815` 确认实际路由为 `/api/runtime/runs`。
4. **走查章节加指针**：第 68 行新增摘要块——F5–F23 详见走查文档；F19（Batch 44）、F21（Batch 46，`audit-list-contract.test.ts` tripwire）、F22（Batch 47，已修）已关闭；走查第七版 `demo:e2e-v7` 1/1×3——在位。
5. **Database 条目双 ③**：第 40 行 Database 条目边界列表已为 ①②③④⑤——在位。
6. （附带）terminal 脱敏条目（第 45 行边界 ④）已改写为"已跨块安全（Batch 48）"，机制与代价（尾部延迟、pending 内存有界）表述准确。

## 真实验证数字（隔离 worktree @52b8413，亲跑）

- 构建：**0 TS 错误**
- cross-chunk-redaction：**13/13**，0 fail
- terminal-cross-chunk-redaction：**5/5**，0 fail
- demo:e2e-v8：**1/1**，0 fail

## 偏差：0 处。
