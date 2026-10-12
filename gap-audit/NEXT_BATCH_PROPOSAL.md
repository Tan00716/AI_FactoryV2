# 下一批补强提案（Batch 2）— 待 Tan 批准

> 生成：2026-10-12（周一）后台整理。来源：`gap-audit/group-a~d` 四份审计报告（199 条缺口），已剔除 07efce4 中已修复的 24 条。
> 本文件只是提案，未动任何代码。批准后按「开发完了才报告」的节奏执行。

## 先行事项：待推提交（2 个，不止 1 个）

本地 `main` 领先 `origin/main` **2 个提交**（本地跟踪引用核对，2026-10-12）：

| 提交 | 内容 | 状态 |
|---|---|---|
| `47856d7` | DEF-002/003 修复 | 已在远端 |
| `ee355f2` | docs: 在 TEST_REPORT_2026-10-11 中记录 DEF-002/003 已修复（附录） | **未推** |
| `07efce4` | 24 项缺口补强（安全/工作流/注册表），1538/1538 测试 | **未推** |

昨晚报告只提了 `07efce4`；`ee355f2` 是更早的文档附录提交，一直没推。推的话两个一起快进，无冲突风险（远端自 47856d7 后无新提交——此点以本地 origin/main 跟踪引用为准，后台环境无法实时连 GitHub 复验）。

## Batch 2 候选（按「小而关键」优先，均为审计原文条目）

1. **§16 G-05 PromotionHold 无强制力** — `analyzeImpact()` 生成了 hold，但门控路径从不查 `listHolds()`，需求变更后受影响晋级照常放行。小改、高完整性价值。
2. **§2/INV-29 模型路由无视 availability** — `satisfiesHardConstraints` 不查 `availability`，`offline` 模型仍可被选为 primary，且无「供应商不可用」报告分支，违反 INV-29「不模拟成功」。
3. **§20 G-27/G-28 进度锁定与团队聚合缺失** — Planning 完成后锁定 `weight_plan_version` 无实现；团队进度按目标权重聚合函数不存在。
4. **§1.2 主指标缺失** — Authorized Outcome Completion Rate 全仓无符号，Dashboard 只有 7 项辅助指标；这是 §1 定义的产品主指标。
5. **§18.2 G-18 v2 工作流引擎未接线** — Board 拖拽仍走 v1 transition API，`WorkflowEngineV2` 在 core 之外零引用（死代码）。接线后 v2 的三态/里程碑/审批门才真正生效。中等工作量，但这是「已建未通」的关键一环。
6. **§25 G-51/G-52 运行时限额未执行** — `BudgetTracker` 定义了 8 项限额，默认路径只传 3 个；防绕过守卫与 jitter 重试是零调用死代码。

## 明确不进 Batch 2（大功能，单独立项）

Dispatch 流程（§1.1/§3.2/§17.2 整块）、Git Broker/Merge Queue（§22）、真实 PTY、完整 RBAC、OS Secret Broker、备份/恢复与 Retention（§47）、Final Report 生成器（§1.1）、e2e 验收套件（§54）、远程项目/Host（§3.1/§4.2）、server 认证。

## 战略优先级提醒（此前已建议、待 Tan 定）

真实模型接入（一个真端到端回路）+ 打包 .exe 安装包，仍是把原型变产品的最短路径；Batch 2 是在此之前的完整性补强，两者不冲突，但顺序由 Tan 定。
