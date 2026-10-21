# 可复现开发环境（devcontainer + Copilot Setup Steps）

> 第三轮加强 R3-T7+8。确定性内核：零外部依赖、零真实模型依赖。
> setup 步骤只声明、不自执行；任何执行都走现有 sandbox/exec 审批语义。

## 文件清单

| 文件 | 说明 |
|---|---|
| `.devcontainer/devcontainer.json` | 主格式：VS Code Dev Containers / GitHub Codespaces 可复现环境（node 22 镜像、扩展、post-create 命令） |
| `.devcontainer/copilot-setup-steps.yml` | 兼容导出视图：Copilot Setup Steps 模板，内容与 devcontainer.json 同源 |

## 单一数据源（防漂移）

两份文件都由 `@ai-factory/qa` 的 `DevEnvSpec` 渲染，**改 spec、不改文件**：

- `defaultDevEnvSpec()` — 本仓库实际采用的 spec（node 22、`npm ci`、`npm run build`，与根 `package.json` 的 `engines >=22`、已提交的 `package-lock.json` 对齐）
- `renderDevcontainer(spec)` → `.devcontainer/devcontainer.json`
- `renderSetupStepsYaml(spec)` → `.devcontainer/copilot-setup-steps.yml`
- `packages/qa/tests/devenv.test.ts` 有一致性单测：签入文件必须与渲染结果字节一致，漂移即失败

## 校验器

- `validateDevcontainer(doc, { repoRoot, packageScripts })`：schema 形状（name/image 必填其一）、`build.dockerfile` 引用路径存在性、扩展 ID 格式、`npm run <script>` 在 `package.json` scripts 中存在、workspaceFolder 合法性。不可解析的输入 fail-closed。
- `checkSetupStepsYaml(text, { nodeVersion })`：job 名必须为 `copilot-setup-steps`（且唯一）、action 必须带版本 pin、`timeout-minutes ≤ 59`、node-version 与 spec 一致（防漂移）。

## 启用 Copilot Setup Steps

按 GitHub 官方文档，setup-steps 文件必须位于 `.github/workflows/copilot-setup-steps.yml`
且只含一个名为 `copilot-setup-steps` 的 job。启用步骤：

```sh
mkdir -p .github/workflows
cp .devcontainer/copilot-setup-steps.yml .github/workflows/copilot-setup-steps.yml
```

**现在不要做这一步**：`.github/` 不进入本地 commit（ci.yml 的 workflow scope 问题），等 Tan 决定是否启用 Copilot 云端 agent 再说。模板放在 `.devcontainer/` 下即是为此。

## 诚实边界

- **只声明、不自执行**：setup 步骤是声明式清单；在不可信环境自动执行 setup 是不做的。真要执行，走现有审批语义（`apps/server/src/exec-sandbox.ts`、`sandbox-modes.ts`），与 exec 工具同一套 allow/ask/deny。
- **未做真实容器拉起验证**：开发 VM 上只验证了文件正确性（schema 校验、引用路径存在、YAML 结构、双格式一致），没有实际 `devcontainer up`。镜像 tag（`mcr.microsoft.com/devcontainers/typescript-node:22`）遵循 devcontainers 主版本 tag 约定，首次实际拉取时以 registry 为准。
- **不替用户项目自动改环境**：校验器/渲染器是库能力，供将来用户项目使用；本任务只交付了本仓库的这份环境 + 校验器本身。
