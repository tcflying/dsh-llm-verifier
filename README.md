# dsh-llm-verifier

DeepSeek Harness 开发者预览插件：让 3 个或 5 个相互隔离的 Harness 候选完成同一项编码任务，先执行项目测试，再使用 `llm-verifier` 选择最佳补丁。原项目只会在用户第二次明确授权后被修改。

本项目是独立插件，不依赖、不修改，也不适配 iPolloWork。

## 当前状态

- DeepSeek Harness：固定 `0.1.0-rc.7`
- Node.js：固定 24 LTS
- Python：由 `uv` 管理
- `llm-verifier`：固定 `0.2.0`
- 平台：macOS / Linux
- 候选数量：只支持 3 或 5，默认 3
- 安装方式：本地路径插件，不发布 npm

## 已实现的工具

### `verified_best_of`

输入：

```json
{
  "task": "修复用户登录失败的问题并补充测试",
  "candidateCount": 3,
  "validationCommands": ["pnpm test"]
}
```

- `candidateCount` 只能为 `3` 或 `5`，省略时为 `3`。
- `validationCommands` 可省略。插件只在仓库根目录自动识别一种项目类型。
- 第一次授权后创建 detached Git worktree 并并行运行候选。
- 测试失败的候选不会进入模型排名。
- 一个候选通过时直接胜出；两个候选使用一个 pivot；三个至五个使用两个 pivots。
- 返回报告路径、运行编号和获胜补丁路径，但不修改原项目。

### `apply_verified_winner`

输入：

```json
{
  "runId": "verified_best_of 返回的运行编号"
}
```

应用前会重新检查仓库路径、HEAD、清洁状态和补丁 SHA-256，并要求第二次授权。应用后重新执行原验证命令，但不会暂存、提交、推送、stash 或 reset。

## 安装

本机安装使用 Node.js 24：

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
node --version
dsh --version
pnpm --version
```

当前开发基线分别为 Node.js `24.19.0`（也写入 `.node-version`）、DSH `0.1.0-rc.7` 和 pnpm `11.7.0`。

安装依赖并构建：

```bash
cd /path/to/dsh-llm-verifier
pnpm install --frozen-lockfile
uv sync --frozen --project python
pnpm run check
```

加入 Web profile：

```bash
dsh plugin --profile web add "$(pwd)"
dsh plugin --profile web list
```

启动 Harness：

```bash
cd 需要处理的干净 Git 仓库
dsh --profile web
```

在对话中要求 Harness 调用 `verified_best_of`。看到报告后，只有确认要采用获胜方案时才调用 `apply_verified_winner`。

卸载插件：

```bash
dsh plugin --profile web remove dsh-llm-verifier
```

## 配置

默认配置：

| 配置 | 默认值 |
|---|---:|
| `defaultCandidateCount` | `3` |
| `candidateProfile` | `headless` |
| `credentialRef` | `DEEPSEEK_API_KEY` |
| `verifierModel` | `deepseek-v4-flash` |
| `nEvaluations` | `2` |
| `maxVerifierWorkers` | `8` |
| `verifierEffort` | `high` |
| `verifierMaxTokens` | `32768` |
| `candidateTimeoutMs` | `1200000` |
| `validationTimeoutMs` | `600000` |
| `runTimeoutMs` | `2700000` |
| `maxVerifierTraceBytes` | `524288` |
| `stateDirectory` | `$DSH_HOME/llm-verifier` |

可在 Web profile 的 `cordis.patch.yml` 覆盖整段配置：

```yaml
- id: llm-verifier
  config:
    defaultCandidateCount: 3
    candidateProfile: headless
    credentialRef: DEEPSEEK_API_KEY
    verifierModel: deepseek-v4-flash
    nEvaluations: 2
    maxVerifierWorkers: 8
    verifierEffort: high
    verifierMaxTokens: 32768
    candidateTimeoutMs: 1200000
    validationTimeoutMs: 600000
    runTimeoutMs: 2700000
    maxVerifierTraceBytes: 524288
    stateDirectory: $DSH_HOME/llm-verifier
```

`nEvaluations` 允许 1–4，`maxVerifierWorkers` 允许 1–16，`verifierEffort` 允许 `low`、`high` 或 `max`。`verifierModel` 必须以 `deepseek-` 开头，其他提供商会在输入边界直接被拒绝。

## 自动验证规则

显式命令优先。没有显式命令时：

| 根目录标识 | 命令 |
|---|---|
| `package.json` + 唯一包管理器 + `test` script | 对应包管理器的 `test` |
| `pyproject.toml` | `uv run pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| 带 `test` target 的 `Makefile` | `make test` |

同时匹配多个类型、存在多个 JavaScript 包管理器或无法识别时，插件会立即报错，要求显式提供命令。

## 安全行为

- 只接受普通、干净的 Git 仓库根目录。
- 拒绝子模块、稀疏检出、linked worktree 和未提交修改。
- 候选工作区位于 `$DSH_HOME/llm-verifier/runs/<runId>`。
- DeepSeek 凭据通过 `ctx.credentials` 每次操作重新解析。
- 候选 Harness 会显式固定为 `workspace-write`，不继承宿主的 `DSH_PERMISSION_MODE`。
- 测试进程不会收到 API Key。
- 候选日志、错误、验证输出和文本 diff 会做精确密钥脱敏。
- 如果候选把密钥写进文本、二进制文件或符号链接目标，整个候选立即失效。
- 二进制内容不发送给 verifier；完整 binary patch 只保存在本地。
- 取消和超时会终止整个候选进程组并清理插件创建的 worktree。
- 应用失败后不会用 `reset` 自动回滚；现场会保留给用户检查。

Git worktree 用于隔离候选改动，不等同于独立容器。候选工具依赖 DeepSeek Harness 的 `workspace-write` 沙箱；验证命令仍会执行仓库中的项目代码，因此只应在可信仓库中使用，并应仔细检查首次授权展示的命令。

Best-of-3 在默认三项标准、两次重复下约产生 36 个 verifier 请求；Best-of-5 约产生 72 个。实际请求数受合格候选和缓存影响，并记录在报告中。

## 运行产物

每次运行保留：

```text
$DSH_HOME/llm-verifier/runs/<runId>/
├── artifacts/
├── manifest.json
├── report.md
├── winner.patch
└── apply-result.json        # 仅在应用后存在
```

临时 worktree 在候选阶段结束后删除。清理失败会在报告中列出残留路径。

报告和清单会记录插件版本、候选启动/完成/通过/排名数量、明确名次、进程退出码、耗时、diff stat、补丁路径与 SHA-256、完整日志路径、二进制文件的路径/大小/哈希、Verifier 实际请求数和 Token 用量。发送给 Verifier 的单候选材料超过上限时，报告会标记截断，并指向未截断的本地文件。

## 开发验证

```bash
pnpm run typecheck
pnpm test
pnpm run build
python3 -m py_compile python/verifier_bridge.py
```

自动测试不调用真实 DeepSeek API。真实 Best-of-3 / Best-of-5 会产生费用，应由用户在明确知情后手动执行。

测试覆盖 Best-of-3 的 3/2/1/0 个合格候选和 Best-of-5 的 5/4/3/2/1/0 个合格候选，以及补丁篡改、凭据脱敏、Verifier 故障、应用后测试失败、二进制补丁、输入截断和残留进程清理。

## v1 限制

- 不支持 Windows、脏工作区、子模块或稀疏检出。
- 不支持 3 和 5 之外的候选数量。
- 不支持自动 commit、push 或自动应用。
- 不支持 OpenAI、Vertex、vLLM 等其他 verifier 后端。
- 不包含 Web 自定义界面、ProgressTracker 或提前停止。
