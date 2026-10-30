# 跨平台验证矩阵（V3 审计 #2，P0-2）

> 本文档是“Windows/macOS 是否验证过”的唯一可信记录口径。
> 规则：一个平台只有在该平台本机上跑通
> `node scripts/cross-platform-check.mjs` 和
> `node scripts/packaged-smoke.mjs --dir <unpacked>` 且报告落盘到
> `docs/verification/reports/<platform>.json` 之后，才从 NOT_RUN 毕业。
> 在此之前，任何“应该能跑”的说法都是未验证，不得写入发布材料。

## 验证状态（2026-10-30 实测）

| 平台 | cross-platform-check | packaged-smoke | 状态 |
|---|---|---|---|
| Linux x64（本 VM） | 6/6 PASS | 14/14 PASS（2026-10-30，release/linux-unpacked，见 ~/v3w1-2-shots/） | 已验证（Linux 侧） |
| Windows x64 | NOT_RUN | NOT_RUN | 未验证 |
| macOS arm64/x64 | NOT_RUN | NOT_RUN | 未验证 |

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

```sh
# 任意平台：平台检查（生成报告）
node scripts/cross-platform-check.mjs --out docs/verification/reports/<linux|win32|darwin>.json

# Linux：先打包成 unpacked 目录，再跑打包后冒烟
npm run dist:linux -- --dir   # 产物 release/linux-unpacked（注意：dist:linux 脚本自带全量 build）
node scripts/packaged-smoke.mjs --dir release/linux-unpacked --out docs/verification/reports/linux-packaged.json

# Windows（在 Windows 机器上）：
npm run dist:win
node scripts/packaged-smoke.mjs --dir release/win-unpacked --out docs/verification/reports/win32-packaged.json

# macOS（在 Mac 上）：
npm run dist:mac
node scripts/packaged-smoke.mjs --dir <解压后的 .app 所在目录> --out docs/verification/reports/darwin-packaged.json
```

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
