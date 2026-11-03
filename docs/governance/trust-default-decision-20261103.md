# 扩展信任默认语义决策记录（V3R4-#3）

- 决策人：Tan
- 决策日期：2026-11-03
- 决策：扩展信任默认语义 = **警告后确认**（warn-then-confirm）
- 被否决分支：fail-closed 拒绝分支已归档为“已否决”，不留双轨；审计原文中“未决策默认 fail-closed 拒绝”只是未决策期间的临时默认，本决策生效后即被覆盖。
- 适用范围：扩展的启用（enable）、命令执行（run）、提供器解析（resolve）三处门禁。
- 不适用范围：安装门禁不变——内联安装未签名扩展仍需显式 trust:true，否则 409 trust-required（安装不是执行）；签名验证失败仍 fail-closed。

## 语义（精确版）

1. 已信任扩展不受影响：Ed25519 签名有效（官方或任意有效签名），或 trust.json 中有覆盖当前 bundle 哈希的信任决定，执行时不提示、不审计。
2. 未信任扩展执行/启用时，服务端先回 409 trust-confirmation-required，附警告载荷：vm 沙盒非安全边界、签名状态、审核状态、声明权限、bundle 哈希。警告载荷不含代码内容。
3. 用户逐次确认（confirm:true）只放行本次操作，并记审计 EXT_TRUST_CONFIRMED（元数据：扩展名、动作、签名状态、结果 confirmed）；确认不写 trust.json，下次执行再次警告。
4. 用户显式拒绝（confirm:false）记审计 EXT_TRUST_REJECTED（元数据同上），操作不执行。
5. 无 confirm 字段的请求只得到警告提示，不记审计——提示不是决定。
6. 无效签名永不可被警告绕过：confirm:true 也回 409 trust-required。
7. 无全局开关：不存在“一律信任 / 全局放行”开关。持久信任仍是独立的显式动作（列表“信任”按钮、POST /trust、安装时 trust:true），与逐次确认互不混淆。
8. 启用时确认只放行本次启用，不授予执行信任：启用后首次执行仍需逐次确认。

## 落点

- 门禁实现：packages/extensions/src/trust.ts（checkTrustGate、TrustConfirmationRequiredError、buildTrustWarning）
- 路由：apps/server/src/routes/extensions.ts（gateExecution，审计 EXT_TRUST_CONFIRMED / EXT_TRUST_REJECTED）
- 桌面警告对话框：apps/desktop/src/components/ExtensionsPanel.tsx（确认仅执行一次 / 拒绝 / 取消；对话框内无“一律信任”控件）
- 文案：apps/desktop/src/i18n/{zh,en}.ts（extensions.trustConfirm* 键，中英对称）
- 测试：packages/extensions/tests/trust.test.ts（门禁四态 + 无效签名不可绕过 + 警告载荷）、apps/server/tests/extensions-trust.test.ts（篡改后逐次确认、拒绝审计、无效签名手动放置 bundle）
- 冒烟：~/workspace/v3r4-3-smoke.mjs、证据 ~/v3r4-3-shots/README.md

## 诚实边界

- 逐次确认不改变 vm 沙盒不是安全边界的事实；确认只代表用户在读过警告后接受当次风险。
- 声明式贡献（面板、检查器）不执行扩展代码，不走本门禁；启用后未信任扩展的声明式面板仍可见，面板本身只读。
- 本决策不改变沙盒接线门控（V3R4-#4，门控于 Windows 真机结论）与本地通道结论（R3 #8 不通过）。
