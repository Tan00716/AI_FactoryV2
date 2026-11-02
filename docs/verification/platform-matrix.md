# 跨平台验证矩阵（V3 审计 #2，P0-2）

> 本文档是“Windows/macOS 是否验证过”的唯一可信记录口径。
> 规则：一个平台只有在该平台本机上跑通整条验证流水线
> （`node scripts/verify-platform.mjs`，含 build、packaged-smoke、
> platform-check 三阶段）且流水线报告落盘到
> `docs/verification/reports/<platform>-pipeline.json` 之后，才从 NOT_RUN 毕业；
> 信任 verdict（签名 + 人工双击记录）随报告一并记录，但永不并入流水线 verdict。
> 在此之前，任何“应该能跑”的说法都是未验证，不得写入发布材料。

## 验证状态

| 平台 | 流水线报告 | pipeline verdict | trust verdict | 状态 |
|---|---|---|---|---|
| Linux x64（本 VM） | `docs/verification/reports/linux-pipeline.json`（2026-11-02，V3R2-#7） | PASS（build 为 SKIP：构建可复现性由同日全量跑 `~/workspace/v3r2-7-pipeline-full.json` 的 build PASS 证明；本次运行冒烟 14/14、平台检查 6/6） | TRUST_NOT_VERIFIED：Linux AppImage 按政策未签名（直接分发可接受），且未附人工双击记录 | 流水线已验证（Linux 侧）；信任门未过，不得据此宣称可信分发 |
| Windows x64 | — | NOT_RUN | NOT_RUN | 未验证（需目标机 + Tan 侧证书采购） |
| macOS arm64/x64 | — | NOT_RUN | NOT_RUN | 未验证（需目标机 + Tan 侧证书采购） |

历史：2026-10-30 Linux 侧 cross-platform-check 6/6、packaged-smoke 14/14（见 ~/v3w1-2-shots/）；
2026-11-02 流水线化后复测：新构建（65 tab）冒烟 14/14、平台检查 6/6，见本表报告。

## 验证流水线定义（V3R2-#7）

一句话：**流水线绿 ≠ 可分发**。流水线回答“这个构建能不能在目标机上重复跑通”，
信任门回答“这个构建能不能作为可信软件发给用户”。两者是两个 verdict，写进同一份报告、
永不合并；把流水线绿说成“可分发”是本次审计明令禁止的说法。

```
node scripts/verify-platform.mjs --dir <unpacked> [--trust-manual <json>] [--out <json>]
# 默认报告：docs/verification/reports/<platform>-pipeline.json
```

| 阶段 | 通过标准 | 失败标准 | 说明 |
|---|---|---|---|
| build | `npm run dist:<platform>` exit 0 且 `release/<linux-unpacked\|win-unpacked\|mac>` 存在 | 任一不满足 | `--skip-build` 时本阶段为 SKIP（本次运行不证明可复现构建）；目标平台 ≠ 本机平台时本阶段为 SKIP（跨平台构建永不记 PASS，必须在目标机上跑） |
| packaged-smoke | `scripts/packaged-smoke.mjs` exit 0（全部非 SKIP 检查 PASS） | 任一检查 FAIL | 同一脚本跑三平台：Linux 用 Xvfb，Win/mac 直接启动；macOS 直接启动二进制会绕过 Gatekeeper，双击检查属于信任门，不属于冒烟 |
| platform-check | `scripts/cross-platform-check.mjs` exit 0（全部 live 检查 PASS） | 任一 live 检查 FAIL | NOT_RUN 条目不使本阶段失败——它们是工作队列，不是失败 |
| trust-gate（独立 verdict） | TRUST_PASSED：平台签名工具验证通过（macOS：codesign + spctl；Windows：signtool verify；Linux：未签名 AppImage 属直接分发可接受，需显性 ack）**且**附上人工双击记录（见下） | 其他一切情况均为 TRUST_NOT_VERIFIED，并写明原因 | 信任门不改变流水线 verdict；无签名时流水线再绿也只能写“已验证、未可信分发” |

流水线 exit 0 当且仅当 build / packaged-smoke / platform-check 三阶段无 FAIL
（SKIP 不计失败，但报告中必须写明哪个阶段被跳过以及为什么）。
信任门单独输出 TRUST_PASSED 或 TRUST_NOT_VERIFIED + 原因。

### 人工双击记录（--trust-manual 附件格式）

无头运行看不到用户双击时 OS 弹什么，所以这一项只能人工记录，不得由脚本伪造：

```json
{
  "launchedVia": "Finder double-click on AI Factory.app",
  "promptObserved": "Gatekeeper: 'AI Factory' cannot be opened because the developer cannot be verified.",
  "osVersion": "macOS 15.x",
  "build": "AI Factory-0.2.0.dmg",
  "recordedBy": "Tan",
  "recordedAt": "2026-11-xx"
}
```

必填字段：`launchedVia`、`promptObserved`（原样记录 OS 弹出的文字，不得绕过后写“无提示”）。
未附此文件时，即使签名验证通过，信任 verdict 仍为 TRUST_NOT_VERIFIED。

### 一个平台何时从 NOT_RUN 毕业

同时满足三点才改矩阵状态，缺一不可：

1. 该平台本机上的流水线报告（`docs/verification/reports/<platform>-pipeline.json`）pipeline 为 PASS；
2. 报告中的 trust verdict 如实记录（TRUST_PASSED 或 TRUST_NOT_VERIFIED + 原因）；
3. 双击结果与警告状态分别有记录（第 2 点的附件或矩阵备注栏），不得只写“跑通”。

## 平台差异清单

| 领域 | Linux | Windows | macOS | 严重度与备注 |
|---|---|---|---|---|
| 沙盒 | bwrap 用户命名空间（装了才可用；探针是真实调用，不是版本号） | 无 bwrap：降级路径——构建以非沙盒方式跑，但审计 SANDBOX_UNAVAILABLE，绝不静默谎称已隔离 | 同 Windows | P0-3：边界不对称已明示，非隐藏。Windows 上必须实测降级路径：高危 exec 应被拒绝或审计，不得静默放行 |
| 进程组 kill（任务取消） | 杀整个 POSIX 进程组 | 退化为只杀直接子进程，孙进程可能残留 | POSIX 进程组 kill，同 Linux | P1：已在任务队列文档中明示；Windows 上需实测确认残留行为 |
| 路径 | POSIX 分隔符，无盘符 | 盘符 + 反斜杠；jail 解析必须拒绝盘符逃逸 | POSIX 分隔符；默认大小写不敏感文件系统，有碰撞风险 | P1：jail 测试应覆盖盘符与大小写折叠用例 |
| 换行 | LF | CRLF：.env 往返写保留源文件换行风格（V3-#2 修：此前保存会把 CRLF 整文件转 LF，见 packages/dotenv） | LF | P2：已修并有测试；git autocrlf 仍是检出侧风险 |
| 签名 / 公证 | AppImage 未签名（直接分发可接受） | 未签名：SmartScreen 警告；需 OV/EV 证书 | 未签名未公证：Gatekeeper 拦截双击；需 Apple Developer ID | P0-2：证书采购是 Tan 侧动作，不是代码任务；未采购前不得宣称“可信分发” |
| 安装包格式 | AppImage + linux-unpacked | NSIS Setup + portable exe（配置已就绪；`release/` 里 189KB 的 exe 是未合入载荷的模板，**不可用、不可发**） | DMG（配置已就绪；Linux 上无法构建，sips 为 macOS 独占） | P0-2：模板 exe 绝不能当作成品发 |

## 在各平台上跑验证（逐条命令）

**首选：跑整条流水线**（一次命令出 pipeline + trust 两个 verdict，报告落盘即毕业证据）：

```sh
# Linux（本机可跑；dist:linux 自带全量 build，约需数分钟）
npm run pipeline:verify
# 等价显式版：
node scripts/verify-platform.mjs --out docs/verification/reports/linux-pipeline.json

# Windows（在 Windows 机器上，PowerShell）：
npm run pipeline:verify
# 预期输出尾段：
#   PASS  build  ... release\win-unpacked exists
#   PASS  packaged-smoke  ... exit 0
#   PASS  platform-check  ... exit 0
#   TRUST_NOT_VERIFIED  trust-gate  TRUST_NOT_VERIFIED: no verified code signature ...
#   PIPELINE verdict: PASS
#   TRUST verdict: TRUST_NOT_VERIFIED
# 附上人工双击记录后信任门才可能变（见上节格式）：
node scripts/verify-platform.mjs --trust-manual docs/verification/reports/win32-doubleclick.json

# macOS（在 Mac 上）：
npm run pipeline:verify
# 预期输出与 Windows 同构，trust-gate 原因首选 codesign/spctl 结果；
# 注意：直接启动 Contents/MacOS/AI Factory 会绕过 Gatekeeper，双击检查必须
# 用 Finder 双击 .app（或 open "AI Factory.app"），并把原样提示文字记入附件。
```

**分步跑（调试某一步时用，与流水线等价，报告需自行汇总）：**

```sh
# 任意平台：平台检查（生成报告）
node scripts/cross-platform-check.mjs --out docs/verification/reports/<linux|win32|darwin>.json

# 打包后冒烟（同一脚本，三平台通用；--platform 可省略，脚本按目录结构识别）
node scripts/packaged-smoke.mjs --dir release/linux-unpacked --out docs/verification/reports/linux-packaged.json
node scripts/packaged-smoke.mjs --dir release/win-unpacked --out docs/verification/reports/win32-packaged.json
node scripts/packaged-smoke.mjs --dir release/mac --out docs/verification/reports/darwin-packaged.json
```

**在 Linux 本机上能验证什么、不能验证什么：**

- 能：流水线编排本身、跨平台布局识别（win/mac 假目录单测 11 项）、Linux 全流程、
  跨平台检查 live 项、信任门的“未验证”分支（无签名 + 无人工记录 → TRUST_NOT_VERIFIED）。
- 不能：Win/mac 的 build、冒烟、双击提示、签名验证——这些只能在目标机上跑，
  本机任何输出都不得写成 Win/mac 结果。矩阵里两平台保持 NOT_RUN，直到目标机报告落盘。

## 打包后冒烟覆盖（scripts/packaged-smoke.mjs）

布局（可执行文件、app.asar、后端入口、≥40 个工作区包）→ Xvfb 下启动
→ `GET /api/health` 200 → `GET /api/stats` → `GET /api/projects` →
bwrap 探针结果上报（不可用是预期结果，不判失败）→ CDP 窗口检查
（file:// 页面、标题非空、≥20 个中心 tab、主区域内容非空、0 页面错误）
→ 恰好一个后端进程 → SIGTERM 干净退出且无后端残留。

与验收的关系：冒烟复用验收的断言口径（健康、面板渲染、JS 零错误），
但验收（`npm run test:acceptance`，138 项逻辑层）测的是包 API 语义，
冒烟测的是打包产物本身——两者互补，不互相替代。

## 本 VM 的已知限制（不得掩饰）

- 本 VM 无 bwrap：沙盒探针恒为不可用，打包后冒烟只能验证“降级可审计”，
  不能验证“沙盒内构建”。
- 本 VM 无法构建 Windows/macOS 安装包，无法运行 Win/mac 冒烟；
  上述两平台的 NOT_RUN 状态是事实，不是待清理的文案。
- 签名/公证证书未采购：即使 Win/mac 冒烟跑通，分发信任仍缺一环。
