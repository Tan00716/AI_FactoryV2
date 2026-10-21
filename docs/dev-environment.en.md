# Reproducible Dev Environment (devcontainer + Copilot Setup Steps)

> Round-3 strengthening R3-T7+8. Deterministic kernel: zero external
> dependencies, zero real-model dependency. Setup steps are declared, never
> auto-executed; any execution goes through the existing sandbox/exec
> approval semantics.

## Files

| File | Description |
|---|---|
| `.devcontainer/devcontainer.json` | Primary format: VS Code Dev Containers / GitHub Codespaces reproducible environment (Node 22 image, extensions, post-create command) |
| `.devcontainer/copilot-setup-steps.yml` | Compatible export view: Copilot Setup Steps template, rendered from the same source as devcontainer.json |

## Single source of truth (drift-proof)

Both files are rendered from one `DevEnvSpec` in `@ai-factory/qa` — **edit the spec, not the files**:

- `defaultDevEnvSpec()` — the spec this repo ships (Node 22, `npm ci`, `npm run build`, aligned with root `package.json` `engines >=22` and the committed `package-lock.json`)
- `renderDevcontainer(spec)` → `.devcontainer/devcontainer.json`
- `renderSetupStepsYaml(spec)` → `.devcontainer/copilot-setup-steps.yml`
- `packages/qa/tests/devenv.test.ts` has consistency tests: checked-in files must be byte-identical to the rendered output; drift fails the suite

## Validators

- `validateDevcontainer(doc, { repoRoot, packageScripts })`: schema shape (name/image required), referenced `build.dockerfile` path existence, extension ID format, `npm run <script>` existence in `package.json` scripts, workspaceFolder sanity. Unparseable input fails closed.
- `checkSetupStepsYaml(text, { nodeVersion })`: the job must be named `copilot-setup-steps` (and be the only job), actions must be version-pinned, `timeout-minutes ≤ 59`, node-version matches the spec (drift check).

## Enabling Copilot Setup Steps

Per GitHub's official docs, the setup-steps file must live at
`.github/workflows/copilot-setup-steps.yml` with a single job named
`copilot-setup-steps`. To enable:

```sh
mkdir -p .github/workflows
cp .devcontainer/copilot-setup-steps.yml .github/workflows/copilot-setup-steps.yml
```

**Do not do this yet**: `.github/` is never committed from this workspace
(the ci.yml workflow-scope issue) — wait for Tan's decision on whether to
enable the Copilot cloud agent. The template lives under `.devcontainer/`
precisely for this reason.

## Honest boundaries

- **Declared, never auto-executed**: setup steps are a declarative list; auto-executing setup in untrusted environments is out of scope. Real execution goes through the existing approval semantics (`apps/server/src/exec-sandbox.ts`, `sandbox-modes.ts`) — the same allow/ask/deny as the exec tool.
- **No real container launch verified**: on the dev VM only file-level correctness was verified (schema validation, referenced-path existence, YAML structure, dual-format consistency); no actual `devcontainer up` was run. The image tag (`mcr.microsoft.com/devcontainers/typescript-node:22`) follows the devcontainers major-version tag convention; the registry is authoritative on first real pull.
- **Never auto-modifies user projects**: the validator/renderer is library capability for future user-project use; this task ships this repo's environment plus the validator itself.
