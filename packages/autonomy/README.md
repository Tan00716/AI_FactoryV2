# @ai-factory/autonomy

Autonomy Mode (spec §80) + production-policy checklist (§41) + human exception handling (§81).

## 四档 (modes)

| mode | 含义 | 决策规则 |
|---|---|---|
| `assisted` 辅助 | 人类确认主要动作 | low 自动；medium+ 需人类确认/审批 |
| `semi` 半自动 | AI 处理常规工程 | low/medium 自动；high+（部署类）需人类审批 |
| `autonomous` 自动 | 策略允许的全部自动 | low/medium 自动；high 经 AI 复核；critical 默认被策略拦下（可配 policy hook 放行） |
| `full` 全自动 | 连生产部署也可自动 | 全部自动；生产部署仍必须通过独立校验清单 |

## 关键 API

- `decide(action, mode, opts?)` — 动作分级决策。`action` 可以是字符串（`'deploy-prod'`）或 `{ kind, risk?, summary?, target? }`。风险可从 `ACTION_RISKS` 查表（如 `run-tests`=low, `deploy-prod`=critical），未知动作默认 medium。full 模式下生产部署返回 `outcome: 'auto'` 但 `requiresProdVerification: true`。
- `verifyProdReadiness(evidence)` — §41 独立校验：Build / Tests / Security / Rollback readiness / Health check / Deployment artifact / Environment status。任一缺失 → `ready: false` 并点名；`aiAssertedOnly: true` 且无 `evidenceId` 时**绝不信任 AI 断言**。
- `needsHuman(reason)` — §81 八种触发（需求歧义、策略违规、重复失败、预算超限、高风险部署、安全问题、不可恢复环境错误、AI 分歧）→ 生成升级记录；`evaluateEscalation(str)` 对未知原因返回 null（不打扰人类）。
- `requireApproval(action, mode)` — 是否需要审批 + 类型（`human` / `ai-review` / `auto`），宽松对应 `@ai-factory/approvals` 的 `HUMAN_APPROVAL` / `AI_REVIEW` / `AUTO`，无硬依赖。
- `ProjectAutonomyStore` — 项目级设置，默认 `assisted`。
- `registerAutonomyRoutes(router, deps)` — `GET/PUT /api/autonomy/mode`、`POST /api/autonomy/verify-prod`，router 只需实现 `get/put/post`，deps 全可选。

## 构建 / 测试 / 演示

```bash
npx tsc -p packages/autonomy/tsconfig.json
node --test packages/autonomy/dist/tests/*.test.js
node packages/autonomy/dist/demo/full-mode-blocked.demo.js
```
