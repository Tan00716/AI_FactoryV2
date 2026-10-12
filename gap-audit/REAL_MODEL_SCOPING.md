# 真实模型接入 — 范围核查（供决策 B 参考）

> 状态更新（2026-10-12）：路线已定 B（Codex app-server）；CodexAdapter 已实现并提交（`18fce3c`），真 turn 验证待 `codex login`（device-auth）完成。
> 生成：2026-10-12 后台核查，未动代码。核查对象：`packages/runtime`、`packages/model-router`、根目录 `electron-builder.yml`。
> 目的：把「先做真实模型端到端」这条战略选项的真实工作量说清，避免按「接个 key 就行」估算。

## 好消息：回路骨架已经通了，只差一个真适配器

- `packages/runtime/src/runner.ts:95` — `runAgent()` 已经在调用 `adapter.invoke({ prompt, tools })`，prompt 由 `buildPrompt(agent, task)` 组装（runner.ts:44）。Agent Loop、预算、重试守卫都在这条路径上。
- `packages/runtime/src/adapters.ts` — `RuntimeAdapter` 接口（§27）已定义：`invoke(input: {prompt, tools}) → {text, toolCalls}`。供应商无关，新适配器只需实现这一个接口。
- 现有实现只有两个：`StubAdapter`（脚本回放，全部测试/demo 都在用它）和 `CodexAdapter`（占位，`invoke()` 直接抛 `AdapterNotImplemented`）。

## 所以「真实模型接入」的实际工作清单（一个真回路，不铺开）

1. **实现 1 个真适配器**（二选一，见下方待定项）：
   - A. HTTP API-key 适配器：对 OpenAI 兼容端点发请求，映射 `AdapterOutput.toolCalls`。工作量最小、最好测（HTTP 层可 mock）。
   - B. 按原设计接 Codex app-server（`CodexAdapterConfig.appServerUrl` + §28 的 ChatGPT OAuth / 授权计划）：更贴 spec §27–§28，但依赖本机 Codex app-server 可用，联调面更大。
2. **密钥/凭证落位**：走现有 profile/config 形状，不硬编码；key 由 Tan 提供并只存本地配置（不进 git）。
3. **账号状态去桩**：`packages/model-router/src/profile.ts` 的 `getAccountStatus()` 目前是 stub（返回占位 usage 字段），真接入后至少把所选供应商这一路换成真实查询或明确标注不可用（配合 INV-29「不模拟成功」——这正是 Batch 2 第 2 条 availability 的一部分，两边可合并做）。
4. **一条真端到端验证**：用 `runAgent` 跑一个真实小任务（真 prompt 进、真回复出、工具调用映射正确），留存运行证据；原 StubAdapter 测试保持全绿。
5. **失败语义**：供应商不可用/限额时 fail-closed 报错，不回退到 stub 假装成功。

## 待 Tan 定的只有两点

- 选 A（API key，OpenAI 兼容）还是 B（Codex app-server + OAuth）？
- 用哪家供应商/哪个模型作首个真回路（其余供应商后补，不进首批）。

## 对比：安装包选项在本环境的硬限制

- `electron-builder.yml` 已备好（NSIS x64、`npm run dist`），但文件头注明须在 Windows 上构建且从未执行过；本开发机是 Linux，无 Windows 环境（ENV-L）——安装包可以做配置和预检，但在拿到 Windows 机器前无法真正产出并验证 .exe。这一点与此前报告的 blocked 状态一致，不是努力问题。

## 结论（一句话）

真实模型接入是「一个接口 + 一条验证路径」的封闭小范围工作，不是重构；安装包则卡在 Windows 环境。决策 B 若选真实模型，建议顺序：先推 2 个待推提交 → 实现首个真适配器 → 真回路验证 → 再回 Batch 2。
