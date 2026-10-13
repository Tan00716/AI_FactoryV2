# Batch 37 独立复核报告（REAUDIT_BATCH37）

- 基线：`bd08f4f`（= `0103709` + CHANGELOG 恢复；bd08f4f 只动 CHANGELOG.md，产品代码与 0103709 一字不差）
- 复核方式：干净主工作树亲读代码 + 亲跑测试 + 亲手复现真握手/真沙箱
- 结论：**三项实质声明全部成立，未发现夸大或造假。偏差 0 处。** 另有 2 处文档小注（非功能偏差，见 §4）。

## 1. MCP 真实握手（37-2）：成立

亲读 `packages/mcp/src/stdio-connector.ts`（388 行）：真实 `node:child_process.spawn`，newline-delimited JSON-RPC 2.0，request/notification 分发，逐请求超时，`notifications/initialized` 生命周期，`initialize()` 只接受调用方列出的协议版本（否则抛协议 `McpConnectionError` 不伪装可用）。不是 mock。

亲跑（`MCP_TEST_REAL_SERVER=/tmp/mcp-servers/.../server-filesystem/dist/index.js`，npm 官方包）：
- `real handshake` 2/2：`server='secure-filesystem-server' version='1.0.0' protocol='2025-11-25'`，`tools/list` → 14 个真实工具，`tools/call read_text_file` 读到真实 probe 文件内容
- `no fake session` 1/1：提议虚构版本 `2099-01-01` 被如实拒绝
- 大声 skip 合同亲验：`MCP_TEST_REAL_SERVER=/nonexistent/server.js` → 2 skipped、0 fail（不伪装通过）

`2025-11-25` 声明成立：`handshake.ts:35` `CLIENT_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']`，注释如实记录"Batch 37 真握手后加入，提议顺序不变（首选仍是 2026-07-28）"。

## 2. build-sandbox（37-4）：成立

亲读 `apps/server/src/build-sandbox.ts`（290 行）：`sandboxConfigFromEnv`（`FACTORY_BUILD_SANDBOX` 默认开/`0` 关、`FACTORY_BUILD_SANDBOX_NETWORK` 默认隔离、`FACTORY_BUILD_SANDBOX_RO_BINDS`、`FACTORY_BWRAP_BIN`）、`probeSandbox`（真实 bwrap 调用探针，按 binary 缓存）、`buildSandboxArgv`（`--unshare-user/ipc/pid/uts/cgroup-try`，网络默认 `--unshare-net`，只读 `/usr`/`/opt`/`/bin`/`/lib`/`/lib64`，`--dev /dev`，`--tmpfs /tmp`，`HOME=/tmp`，唯一可写绑定工作区→`/work`，`--die-with-parent`）、`runBuildCommand` 决策树（关闭→旧行为无审计；探针成功→沙箱+`BUILD_SANDBOXED`；探针失败→`SANDBOX_UNAVAILABLE` 审计+诚实回退）。

`build-runner.ts:633` 真实接入（`this.config.sandbox ?? sandboxConfigFromEnv()`），执行策略检查仍在沙箱之前。

亲跑 `apps/server/tests/build-sandbox.test.ts`：**15/15**（配置解析、argv 形状、探针、沙箱内构建成功+落盘主机可见、写 `/etc` 失败且宿主 `/tmp` 不可见、宿主 loopback 不可达、回退审计+仍执行、关闭无审计、`BUILD_SANDBOXED` 审计）。

bwrap 真实可用性亲验：root 下 `bwrap 0.9.0` 在 PATH；手动复现了报告中的 `/lib64` 坑（缺 `/lib64` 绑定→动态链接器缺失→`execvp: No such file or directory`），完整绑定集探针 `PROBE-FULL-OK`。报告诚实。

## 3. CHANGELOG 恢复事故（bd08f4f）：成立

- `git diff 05a19e6 HEAD -- CHANGELOG.md`：**8 行新增、0 删除**，全部集中在文件头部的 Batch 37 一节；Batch ≤36 内容与 05a19e6 **一字不差**。
- Batch 37 一节 5 条内容与各子任务报告逐条对上：37-1（偏差 0 处）、37-2（握手细节）、37-4（沙箱细节）、37-3（清单纠偏两条）、测试基线（2449/2449、311→326（+15 build-sandbox）、tsc 0、smoke OK）。
- 37-3 的清单改动真实存在：`SELLABLE_CHECKLIST.md` 基线已是 `05a19e6`（2449/2449、311/311），独立复核口径 Batch 22–35；`gap-audit/REAUDIT_BATCH21.md`…`REAUDIT_BATCH36.md` 全在库。
- 根因复核：`open(p,'w').write(抛异常表达式)` —— open 先截断、后求值参数，参数抛异常时文件剩 0 字节；已在 /tmp 复现，教训记入 `~/AGENTS.md`。

## 4. 文档小注（非偏差）

1. `build-sandbox.ts` 头注释写 "SPEC v2 §40 (Batch 37)"——§40 是 CI/CD 章节，sandboxing 在该章无明确 MUST；更贴切的归属是 §7 的 SANDBOX STRATEGY（"升级为真实可验收隔离，禁止仅凭cwd/提示词"）。功能无影响，建议后批改注释归属。
2. `SELLABLE_CHECKLIST.md` 独立复核条目的 glob `REAUDIT_BATCH2[2-8].md` + `REAUDIT_BATCH3[0-5].md` 漏掉了真实存在的 `REAUDIT_BATCH29.md`（落在两个 glob 之间）。建议改成显式列举或 `REAUDIT_BATCH2[2-9].md`。

## 5. 测试基线（本复核亲跑）

- `real-handshake.test.js`（真服务器）：2/2；skip 合同：2 skipped / 0 fail
- `build-sandbox.test.ts`：15/15
- 全树数字沿用主线收口亲验（代码与 0103709 一致）：构建 0 错误；包套件 2449/2449；服务端全套 326/326；desktop tsc 0；smoke:boot OK
