# Batch 25 独立复核报告（REAUDIT_BATCH25）

基线：`48bdf18`（Batch 25 提交）。复核方式：独立重跑关键测试 + 独立复现脚本（不依赖被复核批次的自述）。

## 总结论

Batch 25 的实质声明全部成立，未发现夸大或造假。核心竞态（过期写静默撤销信任批准）经独立复现确认为真 bug，修复为实质修复；SBOM 为真实 lockfile 派生；25-1 指出的 taskId-null 审计补线已在树上。

## (a) MCP op 协议：成立

**独立复现（`node:sqlite` 双连接到同一 DB 文件 = 双进程）：**
- 新 op 路径：进程 A 注册 `demo@1.0.0` → 批准（HIGH/AUTO）→ 进程 B（过期内存，仍以为 BLOCKED）经 `applyServerOp` 做健康写 → 读回 `trustLevel: HIGH, approvalPolicy: AUTO, rowVersion: 3`。**过期写未撤销批准。**
- 旧路径对照：同一脚本改用 `saveServer` 全行 upsert（Batch 25 之前的写法）→ 读回 `trustLevel: UNKNOWN, approvalPolicy: BLOCKED`。**旧 bug 真实存在，修复是实质性的。**
- `applyMcpServerOp` 的 `register` 合并：对已有 HIGH/AUTO 记录做过期重注册 → 信任/策略保留、history 保留（2 条）。"过期重注册不再撤销批准"成立。
- 服务端接线确认：`apps/server/src/mcp-persistence.ts` 的 `attachMcpPersistence` 经 `applyOpToStore`（行 206–275）走 op 协议，不再走全行 upsert。

**亲跑测试数字：**
- `packages/db` mcp-servers + mcp-server-ops：6/6
- `packages/mcp` 全套：70/70
- `apps/server/tests/mcp-cross-process.test.ts`：4/4
- `apps/server/tests/mcp-registry-persistence.test.ts`：3/3

诚实边界与报告一致：install 表仍是单语句 upsert；读视图仍可能过期；只覆盖同一 DB 文件多进程。

## (b) SBOM：成立

- `packages/cicd` sbom.test.ts：6/6（v1/v2/v3、yarn、pnpm、cargo、去重、排序、坏文件 skip、无 lockfile、超 cap 截断）
- `apps/server/tests/build-runner.test.ts`：9/9（含 SBOM e2e）
- **独立验证**：用仓库自身的 `package-lock.json` 调 `generateSbom` → 386 个真实组件（首个 `@babel/code-frame@7.29.7`，含 `typescript`），provenance 标记如实声明"声明/解析依赖清单，非安装树扫描"。非编造。

## (c) taskId-null 审计补线：在树上

`apps/server/src/build-runner.ts:404`（`reason: 'build record has no taskId — cannot locate merge evidence to bind'`），编译产物 `apps/server/dist/build-runner.js:339` 同步。25-1 指出的措辞偏差已关闭。

## 方法论注记

旧路径对照实验（saveServer 全行 upsert 丢失批准）证明了复核的一个原则：只跑新测试的绿灯不够，必须同时证明旧写法在同样场景下会红，否则无法区分"修了真 bug"和"测了个本来就对的东西"。
