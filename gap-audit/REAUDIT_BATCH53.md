# Batch 53 独立复核报告（Batch 54-1）

- 复核基线：`fc45007`（Batch 53 closeout commit）
- 方法：隔离 worktree（detached HEAD `fc45007`）亲读全部改动文件 + 亲跑测试；主树零干扰，worktree 复核后外部清理（清理前所有亲验数字已取得）。
- 结论：**Batch 53 的实质声明全部成立，偏差 0 处。**
- commit 文件清单亲验：恰好 10 个文件（CHANGELOG、auth.ts、index.ts、api.ts、OpsPanel.tsx、audit-chain-verify.test.ts、FIRST_RUN_WALKTHROUGH.md、backup-restore-guide.md、REAUDIT_BATCH52.md、SELLABLE_REVERIFY_BATCH52.md），无意外文件。SELLABLE_CHECKLIST.md 是 goals 工作区的仓库外文件，按 Batch 52–53 惯例不在 commit 内（与 Batch 53 commit message 一致）。

## (a) operator verify 端点——成立

亲读实现（隔离 worktree）：

- `apps/server/src/auth.ts:494`：`if (path === '/api/audit/verify') return 'operator';`——operator+ 面，viewer 不得；注释写明"verifying the chain is an operator control action, not passive metadata reading"。`GET /api/audit` 本身走默认 GET→viewer 规则，未变。
- `apps/server/src/index.ts:1621–1630`：`GET /api/audit/verify` 直接返回裸 `audit.verify()`（**不是 envelope**）；`?limit`/`?offset` 存在即 400 `{code:'AUDIT_VERIFY_NO_PAGINATION'}`，fail-closed；注释明确 F33 就是这个教训。
- 形状交叉验证：`packages/core/src/audit.ts` — `AuditLog.verify()` 调 `verifyAuditChain(this.store.list())`；store 的 `list()` 是 `SELECT * FROM audit_logs ORDER BY ts, rowid`（`packages/db/src/db.ts:552`）——确实是 genesis 锚定的追加序；`brokenAt` 是追加序下标，`legacyCount` 跳过计数。与报告一致，无修饰。
- 403 路径：auth.ts `requiredRoleFor` → `checkAuth` → outcome 'forbidden' → 403（`{error}` 最小 body，不泄露角色配置）。设计与 F21 契约测试同源。

亲跑（隔离 worktree，真实编译 server + 新鲜 temp DB + temp FACTORY_SECRETS_DIR）：

- `audit-chain-verify.test.ts`：**4/4，连续 3 次全绿**（intact chain ok:true / tamper ok:false + brokenAt 精确定位 / 分页 400 / viewer 403 + operator 200）
- F21 裸数组契约回归（`audit-list-contract.test.ts`）：在 main 树亲跑 **1/1**——verify 端点的加入没有破坏 GET /api/audit 契约
- 构建：0 `error TS`（`grep -c "error TS"` 输出 `0`；`dist/index.js` 落盘 84116 bytes；注：`grep -c` 0 匹配时退出码为 1 导致 `&&` 短路，这是我的命令构造问题，不是构建失败——已用 ls 确认产物在位）

## (b) 桌面 OpsPanel 审计链 Block——成立

亲读 `apps/desktop/src/api.ts`：`AuditChainVerification` 接口 `{ok, verifiedCount, legacyCount, brokenAt?}` 逐字段镜像端点返回，注释明确 brokenAt 是追加序下标非 API 序；`auditVerify: () => req<AuditChainVerification>('/audit/verify')`。

亲读 `apps/desktop/src/components/OpsPanel.tsx`：

- `<Block title="审计链完整性（§32）">` 放在 Watchdog 块之后
- 状态机 idle（"尚未验证"）→ loading（"正在从 genesis 拉取全链…"）→ ok（绿："已验证 N 条"，legacyCount>0 时注明 legacy 跳过不影响完整性）/ broken（红 banner：brokenAt 追加序下标定位 + "断裂前 N 条已验证，断裂后的记录不可信" + detection-not-prevention 边界文案）/ error（服务端原文呈现 + 403 权限不足注明）
- 按钮「拉取全链验证」，title 注明"从 genesis 锚定验证整条审计链，不分页（F33）。角色要求 operator+。"——**未暴露任何 limit 参数**（F33 教训执行到位）
- 亲跑：`npx tsc -p apps/desktop/tsconfig.json` → **0 错误**

## (c) 文档——成立

- `docs/FIRST_RUN_WALKTHROUGH.md`：audit-chain leg 下 **Batch 53 update** 块在位（端点、返回形状、分页拒绝、契约测试指针四要素齐全）；F33 追加 "**Closed by `GET /api/audit/verify` (Batch 53)**" 在位；F32/F34 描述未动；无产品代码逻辑变化。
- `docs/backup-restore-guide.md` §6：审计链自检小节在位（端点、分页拒绝、"恢复前后可用它确认审计链不断"）。

卫生注记（非偏差，cosmetic）：文档顶部总览表仍题为 "Walkthrough index (Batch 51)"（11 行，止于 escalation leg B51）和 "Findings index (F1–F31)"——**Batch 52 的 audit-chain leg（F32–F34）未进入总览表**。Batch 52–53 的 commit message 都没声称更新过总览表，所以这是文档滞后（pre-existing staleness），不是虚假声明。建议 Batch 54 把总览表和 findings 索引补到 Batch 53。

## (d) 可售清单第六轮复验——抽查成立

- `gap-audit/SELLABLE_REVERIFY_BATCH52.md`：复验方式（HEAD + ls-remote 双确认 7eadda6、14 个交付物存在性+内容亲读、审计链走查抽点亲跑）与报告一致；"翻绿 8 项"逐条对照仓库可定位；"新增真实缺口 0 项"成立（F28–F34 均为 Info 级）。
- 硬门槛抽查：仓库无 `LICENSE` 文件（亲验 `ls` 不存在）；`StubAdapter` 引用仍在（亲验 grep 命中 run-manifests/adapters）；`REAUDIT_BATCH21.md`–`REAUDIT_BATCH51.md` 连续在位（逐个亲验，无断档）；`.github/workflows/ci.yml` 在 worktree 中不存在、仅在 main 树未跟踪在位（与"GitHub CI 从未运行"结论一致）。
- 结论措辞"仍是'可运行的原型 + 持续收敛'，不是可交付产品；代码侧已无可代劳的路径"——与抽查证据一致，无夸大。

## 真实验证数字汇总

| 项 | 数字 |
|---|---|
| audit-chain-verify.test.ts | **4/4 × 3** 连续全绿（隔离 worktree） |
| audit-list-contract 回归 | **1/1**（main 树） |
| desktop tsc | **0 错误**（隔离 worktree） |
| root build | 0 `error TS`（隔离 worktree） |
| commit 文件清单 | 恰好 10 文件，零产品代码改动以外的意外 |

## 偏差

**0 处。** 一处卫生注记见 (c)（总览表滞后，建议 Batch 54 补）。
