# Batch 42 独立复核报告（REAUDIT_BATCH42）

复核基线：`795d508`（Batch 42 提交，已推送）。复核人亲读代码 + 亲跑测试。
**结论：Batch 42 的实质声明全部成立，未发现夸大或造假。偏差 0 处。**

注：复核期间主树出现 Batch 43 兄弟在途工作（`routes/runtime.ts`、`packages/runtime/*`、
`first-run-walkthrough-b43.test.ts`、`needs-human-irrecoverable-env-error.test.ts`），
复核对象为已提交的 `795d508`，兄弟工作与本复核无关、复核人未动其文件。
另注：42-4 曾报告 `needs-human-brute-force.test.ts` 1 失败（detail 短语不匹配），
42-2 后续已修复——复核人亲跑时四个文件 29/29 全过。

## (a) brute-force 接线：成立

- **亲读 `packages/security/src/brute-force.ts`**：滑窗计数是确定性计数——
  `noteDenial` 按 `now() - windowMs` 修剪后 `count >= threshold` 即 `crossed`，
  无正则、无启发式。阈值 10 / 窗口 5 分钟为显式导出常量（`BRUTE_FORCE_THRESHOLD` /
  `BRUTE_FORCE_WINDOW_MS`），构造函数校验。`tokenPrefixHash` 只存
  sha256（presented 前 4 字符）截断 16 hex，不存 token 明文。
  进程内存计数器的理由诚实写进文件头（落库每 401 一写=攻击者决定写盘量；
  告警行本身落库持久）。`noteSuccess` 清零该来源计数；文件头如实注记
  共享 IP（NAT/loopback）下一客户端合法请求会清零整 IP 计数器——
  是 IP-keyed 检测的固有属性，非规则缺陷。
- **亲读 `apps/server/src/brute-force-emission.ts`**：阈值 crossing →
  `needsHuman('security-issue', …)`，`source: auth-bruteforce:<ip>`，
  recipient null，requiredDeciderLevel 'admin'（注释写明是映射选择），
  severity critical（autonomy 映射）。去重：`list('open')` 为准，
  每来源至多一条 OPEN，消解后继续攻击→下一次 401 自然重发。
  写透失败审计 `NEEDS_HUMAN_PERSIST_FAILED` 永不抛。
  `handleBruteForceDenial` 整体 try/catch：抛错→`BRUTE_FORCE_DETECTOR_FAILED`
  审计且不发射（检测器故障既不能误报也不能放行）。
- **亲读接线（`auth.ts` / `index.ts`）**：
  - hook 在 401 写完**之后**触发（`enforceApiAuth` 先 `deps.json(res, 401)` 再
    `fireAuthHook`），`fireAuthHook` 吞异常→`AUTH_CALLBACK_FAILED` 审计——
    401 门在上游独立，检测器 bug 不能扰动拒绝。✓
  - `onAuthenticatedAllow` 只在 `outcome === 'allow'` 且
    `access.mode !== 'open'` 且 `access.role !== null` 时触发：
    health 豁免（role null，auth.ts:428）、open 模式（mode 'open'）、
    非 /api 路径（required null → role null）永不 clearing——
    攻击者不能用 GET /api/health 洗计数。✓
  - 403 RBAC 分支只审计 `RBAC_DENIED` 写 403，不触发 `onAuthDenied`。✓
  - 单次 401：count=1 < 10，不发射。✓
- **亲跑**：`needs-human-brute-force.test.ts` **10/10**、
  `needs-human-brute-force-e2e.test.ts` **1/1**；
  `packages/security` 全包 **91/91**。

## (b) redaction-monitor：成立

- **亲读 `packages/secrets/src/broker.ts`**：`redactSecretValues` 在
  `redactSecretValuesCounted` 之上实现、返回 `.text`——老函数行为逐字节不变，
  向后兼容成立。计数是 `split` 精确替换数（longest-first），确定性。
- **三处消费点亲读**：exec（routes/exec.ts:305）、terminal
  （routes/terminal.ts:195）、MCP（mcp-launcher.ts:301 → routes/mcp.ts:505
  经 `onRedactionHit` 回调用长生命 ctx 接 `recordRedactionHit`）——
  均为 `hits > 0` 才记事件。✓
- **`SECRET_REDACTED_HIT` 审计**：`ctx.audit.record(actor, 'SECRET_REDACTED_HIT',
  sourceType, source, { hits })`——只带命中数与来源，不记 secret 内容。✓
- **亲读 `redaction-monitor.ts`**：聚合阈值 3 / 窗口 5min 显式
  （`REDACTION_ESCALATION_THRESHOLD` / `REDACTION_ESCALATION_WINDOW_MS`）；
  单次命中永不发射（只有聚合 crossing 才发射）；`escalated` 集合去重，
  窗口完全排空后新 pattern 可重发（不因人工消解自动清计数——与 doc 口径一致）；
  聚合器进程内单例（与 authority-conflict registry 同姿态），检测事件本身在
  审计链持久。`security-issue` 第二发射点，source
  `redaction-monitor:<type>:<source>`，operator，critical。
- **亲跑**：`redaction-monitor.test.ts` **13/13**；`packages/secrets` 全包 **48/48**。

## (c) requirement-ambiguity：成立

- **亲读 `packages/requirements/src/manager.ts:315`**：
  `countConsecutiveAcRefinements` 尾部连续 `changeKind==='AC_REFINEMENT'` 计数，
  `SCOPE_CHANGE`/`TARGET_CHANGE`/`CORRECTION` 打断 streak——确定性计数，
  不是 QA 正则启发式（Batch 38-4 的拒绝标准得到遵守）。✓
- **亲读 `routes/requirements.ts`**：阈值
  `REQUIREMENT_REFINEMENT_ESCALATION_THRESHOLD = 3` 显式导出；
  达标且无 OPEN 时 `needsHuman('requirement-ambiguity', …)`（recipient null，
  'manager'——注释写明是映射选择，severity medium 来自 autonomy 映射，
  detail 明文"AC 集未稳定…may be ambiguous"不宣称已证实歧义）；
  409 熔断器（`REQUIREMENT_REFINEMENT_PAUSED`）在 OPEN 期间拒绝同需求
  autonomous refinement；消解后下一轮 refinement（streak 仍在）开启新 episode；
  写透失败审计 `NEEDS_HUMAN_PERSIST_FAILED` 永不抛（201 照常返回）；
  dual-mode 合规（emit 函数复制非 import，注释写明前例）。✓
- **亲跑**：`needs-human-requirement-ambiguity.test.ts` **5/5**；
  `packages/requirements` 全包 **50/50**（与 42-4 自述一致）。

## (d) §81 7/8 口径一致性：成立

- `docs/needs-human-triggers.md`：`## 已发射（7/8）` 下 7 行触发器
  （ai-disagreement、budget-exceeded、repeated-failure、high-risk-deployment、
  policy-violation、security-issue、requirement-ambiguity），
  `## 未发射（1/8）` 仅 `irrecoverable-env-error`（Batch 39 三条理由维持，
  Batch 40 信号已落地但 loop 仍无 server 生产调用点）。✓
- `docs/KNOWN_LIMITATIONS.md` §81 条目：三个 Batch 42 发射点（暴力破解、
  脱敏聚合第二发射点、需求歧义）全部列入，"仅剩一个"口径正确。✓
- `SELLABLE_CHECKLIST.md`：翻绿口径 4/8→7/8，仅剩 irrecoverable-env-error。✓

## 真实验证数字（复核人亲跑，基线 795d508）

- 构建：0 错误（`npm run build`，grep "error TS" 计 0）
- 新测试文件：10/10 + 1/1 + 13/13 + 5/5 = **29/29**，0 fail
- 包级：security 91/91、secrets 48/48、requirements 50/50
- auth.test.ts：25/25（hook 豁免逻辑相关）

**偏差：0 处。**
