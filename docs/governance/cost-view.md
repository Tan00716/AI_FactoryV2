# 治理层成本视图文案（文案先行版）

> 定位：本文件是第三轮 V3.0 审计 Top 10 第 9 项“治理单列一层”的文案三件套之一（成本视图文案）。
> 口径来源：V3.0 #8 成本治理策略层，packages/quota（budget.ts）。本文案只转述实现口径，不编造价格与用量。
> 诚实总声明：除非用量行标注 source 为 provider-reported，否则一切费用与 token 数字均为估算；换算表全部 measured: false。

## 一、成本视图应该展示什么（一屏文案结构）

```
成本视图（治理层）
├─ 预算一览：每个预算一行 —— 范围 / 单位 / 周期 / 上限 / 本窗口用量 / 状态
├─ 状态说明：ok / warned（80% 警告一次）/ tripped（100% 熔断）/ released（已放行）
├─ 熔断与放行记录：熔断时间、放行理由（放行只清本窗口，永不提高上限）
├─ 换算表：占位系数 + “待模型接通后实测填数”水印（全部 measured: false）
└─ 计量来源标注：每一行用量标注 simulated / manual / provider-reported
```

## 二、预算对象口径（与实现一致）

- 三级范围：task（任务）/ person（人）/ project（项目）。
- 三单位：usd-estimate（美元估算）/ calls（调用次数）/ tokens-estimate（token 估算）。
- 四周期：daily / weekly / monthly / all-time。
- 默认值（AI Factory 自有政策默认值，非厂商价格）：
  - 新项目默认月预算：10 美元估算（usd-estimate / monthly）。
  - 新任务默认预算：2 美元估算（usd-estimate / all-time）。
  - 上限默认开启（capEnabledByDefault: true），自动续期默认关闭（autoRenewDefault: false）。
  - 已存在同范围 + 同键 + 同单位 + 同周期的预算时，apply-defaults 不覆盖。
- 上限校验 fail-closed：上限必须为有限正数，零 / 负 / 无穷上限拒绝写入。

## 三、警告与熔断语义（演示时必须原样讲）

- 80%：每窗口警告一次（warned），不阻止调用。
- 100%：熔断（tripped），checkAllowed 拒绝**新调用**；已在运行的确定性工作不受影响。
- 放行：每窗口恰好可放行一次，放行理由必填并记审计；放行只清除熔断状态，**永不提高上限**。
- 熔断时项目级预算 best-effort 进影子检查点（label 形如 budget-breaker:<id>），作为事后可查的断点。

## 四、计量来源与诚实标注（不得混写）

| 来源标注 | 含义 | 演示时怎么说 |
|---|---|---|
| simulated | StubAdapter 验证路径记录的模拟用量 | “这行是模拟用量，只证明熔断逻辑走得通，不是真实账单。” |
| manual | 手动记录的用量 | “这行是人工登记的，不是厂商回执。” |
| provider-reported | 真实模型回执的用量 | 只有此标注的行可称为真实消耗；当前除 Codex 外适配器仍是 stub，Codex 本人亦未实证，故当前视图内不应出现 provider-reported 行 |

- 换算表：3 行全部 measured: false，附“占位系数：待模型接通后实测填数，不得当作真实价格”水印；未知单位估算为 null，永不编数字。
- 账本范围：只保留每个预算的当前窗口（写时修剪旧窗口）——这是策略账本，不是 billing 历史；不要把它讲成对账单。

## 五、持久化与存储口径

- 持久化文件：<DATA_DIR>/budgets.json，原子写；未知形状 fail-closed。
- 预算行与审计的关系：放行理由与熔断事件进审计；审计里只记事件与理由，不记密钥。
- 与 run 元数据持久化的关系：两者都是“只记元数据、不记敏感内容”的同一原则，但预算账本与 run 历史是两份独立存储，不得混为一份。

## 六、成本视图文案自查

- [x] 默认值（10 美元月 / 2 美元任务）与 DEFAULT_BUDGET_POLICY 一致，并注明是自有政策默认值、非厂商价格。
- [x] 80% 警告 / 100% 熔断 / 放行语义与 budget.ts 一致。
- [x] 换算表全部 measured: false，附占位水印文案。
- [x] 无 provider-reported 行的承诺：当前无真实模型回执，视图内不得出现真实消耗数字。
- [x] 无定价承诺：本层不标价；客群未定前不得为治理层编定价。
- [x] 无新增 tab、无视图承诺；视图部分门控于客群判定。
