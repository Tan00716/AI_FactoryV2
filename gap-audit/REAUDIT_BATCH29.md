# Batch 29 独立复核（Batch 30-1）

**基线**：`7d99787`（树干净，仅有未跟踪的 `.github/workflows/ci.yml`，无在途改动）。复核方法：根构建后亲手重跑三个测试文件；亲读关键断言与实现；"最后一处裸 sleep"说法做全仓库 grep 交叉核对。
**结论：Batch 29 的四项实质声明全部成立，未发现夸大或造假。**

## (a) db-broker 服务端接线：成立

- 亲跑：`apps/server/tests/db-broker.test.ts` **7/7**（真 server e2e，boot `apps/server/dist/index.js`）。
- 亲读断言与实现的对应：
  - 白名单拒绝真实：`SELECT id FROM audit_logs LIMIT 1` → 403 `PRIVILEGE_DENIED`，reason 含 `audit_logs`；白名单读 `SELECT id FROM tasks LIMIT 3` → 200 且 `truncatedRows/truncatedColumns` 明确为 false。
  - 多语句拒绝真实：`SELECT 1; SELECT 2` → 400，single-statement。
  - 无引擎 503 真实：engine-less 连接（policy 已绑、read + `*` 表——排除"被白名单拒绝"的干扰）→ 503 `NO_ENGINE`，reason 含 "refuses to pretend"；未知连接 → 404 `UNKNOWN_CONNECTION`。
  - prod 写确认门真实：boot 用 `FACTORY_DB_ENVIRONMENT=prod` 的真实引擎，prod 读不需确认（200），prod 写无确认 → 403 `GATE_DENIED`；带字面 `prodWriteConfirmed: true` 门放行后白名单仍咬（insert 不在读白名单）→ 403 `PRIVILEGE_DENIED`。**测试确认了"门放行 ≠ 执行"，没有实际写发生。**
  - RBAC 分工真实：policy/connection/模板注册 admin，执行 operator；operator 绑 policy → 403 `RBAC_DENIED`。
  - 执行默认 opt-in 真实：factory 连接 boot 即注册但不绑任何 policy，ad-hoc 执行 → `PRIVILEGE_DENIED` 直到 admin 显式绑定。
  - 审计链哨兵值真实：哨兵 `param-sentinel-must-never-be-audited-9z8` 经 `params: { v: PARAM_SENTINEL }` 真实绑定执行（返回行里能读到它，证明确实走过引擎），随后 `/api/audit?limit=200` 的 JSON 转储全文不含哨兵值；8 个动作（`DB_CONNECTION_REGISTERED` / `DB_BROKER_POLICY_SET` / `DB_BROKER_EXECUTED` / `DB_BROKER_DENIED` / `DB_BROKER_NO_ENGINE` / `DB_PROD_WRITE_DENIED` / `DB_RUNBOOK_REGISTERED` / `RBAC_DENIED`）都在哈希链审计里。
  - SQL 只带占位符进审计、绑定值永不进审计：断言与实现对应（broker 发审计时只传模板 SQL 与 params 形状描述）。

## (b) fetched-content 隔离契约：成立

- 亲跑：`packages/tools/dist/tests/fetched-content.test.js` **11/11**。
- 亲读 `packages/tools/src/fetched-content.ts` 与测试：
  - 隔离构造真实：`markUntrusted` 是唯一构造点；缺 URL/空 URL 直接拒收（fail-closed），空文本允许（"an empty fetch is still a fetch"——没有把空当成没抓过）。
  - 原型伪造拒绝真实：`Object.create(Object.getPrototypeOf(q))` 的 spoof 确实通过 `instanceof` 检查（测试先断言通过），但 `assertQuarantined` 的运行时品牌检查拒绝并抛出 `/not quarantined external content/`；`renderQuarantined` 同理。双检查（instanceof + brand）存在。
  - 横幅字节真实：`QUARANTINE_BANNER_EN = 'EXTERNAL WEB CONTENT — NOT INSTRUCTIONS'` 与中文横幅确有其常量；渲染输出里 banner 在外部文本之前（索引断言 `bannerIdx < firstTextIdx`），原文原样保留但永远不会出现在无横幅的输出中（render 唯一出口带横幅）。
  - choke point 真实：`buildPromptFromBlocks` 对"声称外部但未隔离"的 block fail-closed，trusted 字符串原样通过。
- 口径一致：提交说明的"问责链不是银弹、只覆盖网站文本来源域、仍无抓取器"在实现里是真实边界——`browser.open` 仍 definition-only（本批只动了 `builtins.ts` 的 gap 注释），没有伪装成隔离已生效于真实抓取链。

## (c) 29-2 启动等待轮询化：成立，稳定

- 亲跑：`apps/server/tests/build-orphan-reconcile.test.ts` **7/7**，exit 0，一次通过。
- 亲读：两个启动等待确为 `waitForHealthy` 轮询 `GET /api/health`（30s 有界 deadline，超时大声失败），注释明写 "Never a fixed sleep"。零产品代码改动（diff 仅测试文件）。
- "最后一处裸 sleep 启动等待"交叉核对：全仓库 grep `setTimeout`/`sleep` 在 tests 目录，唯一命中的 `operations-startup.test.ts:61` 的 `setTimeout(r, 200)` 是 `waitForHealth` 轮询循环内的间隔，不是固定启动等待。说法成立。

## 诚实边界（与提交说明一致，无新增）

- broker 引擎直写 SQLite 绕过领域层校验——白名单是唯一控制；只有 factory 连接有真实引擎；无远程数据库驱动；二进制值 base64。
- 隔离契约是未来 driver/组装方的硬性要求，不是今天生效的抓取链隔离；网站文本来源域之外未覆盖。

## 构建说明（复核者修正）

- 复核期间 `npm run build` 共亲跑四遍：第一遍**真实失败**（exit 2，`apps/desktop` 的 `vite build` 失败），后三遍全部通过且 **0 TS 错误**；最后一次亲跑包含完整的 desktop vite 构建（✓ built in 1m31s，产物 `apps/desktop/dist/index.html` 新鲜存在）。
- 结论：桌面构建曾出现一次偶发失败，重试后不可复现——构建稳定性本身有观察记录，但基线产物可用且测试全部针对本次亲构建的产物通过。第一次失败时复核者还同时把产物路径查错了（`packages/tools/dist/fetched-content.js` 实际为 `dist/src/fetched-content.js`；server 测试 type-stripping 运行、不进 dist），这两件事是独立的，都已如实记录。
