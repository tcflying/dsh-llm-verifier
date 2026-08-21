# dsh-llm-verifier Promotion Kit

This document contains factual, reusable launch material for the current developer-preview release. Keep every post aligned with the repository's actual capabilities and limitations.

## Positioning

### One-line English description

Run 3 or 5 DeepSeek Harness coding candidates in separate Git worktrees, reject patches that fail project tests, and rank the verified remainder before an approval-gated apply.

### 一句话中文介绍

让 3 个或 5 个 DeepSeek Harness 候选在独立 Git worktree 中完成同一项编码任务，先用项目测试淘汰失败补丁，再对合格方案排名，并在二次授权后应用获胜补丁。

### Short English description

`dsh-llm-verifier` is a developer-preview plugin for DeepSeek Harness. It orchestrates independent coding candidates, validates every patch with the target project's tests, ranks only the passing candidates with `llm-verifier`, and leaves the original checkout unchanged until a separate approval applies the winner.

### 中文短介绍

`dsh-llm-verifier` 是一个 DeepSeek Harness 开发者预览插件。它会编排多个独立 Coding Agent 候选，逐个执行目标项目测试，只对验证通过的补丁进行排名；原工作区在候选阶段保持不变，获胜补丁需要第二次授权后才会应用。

## Audience

Primary users:

- developers already using DeepSeek Harness for coding tasks;
- maintainers who want several independent candidate patches for high-value changes;
- agent engineers studying validation-first selection and approval-gated patch application;
- teams evaluating LLM-as-a-Verifier workflows on trusted repositories.

Do not position the current version as:

- a general-purpose CI service;
- a secure sandbox for untrusted repositories;
- an automatic merge or deployment bot;
- an npm-installed production release;
- a benchmark proving that one model or verifier is universally better.

## Proof points

Use these concrete claims:

- 3 or 5 independent candidates receive the same task.
- Candidate edits are separated with detached Git worktrees.
- Project validation runs before model ranking.
- Failed candidates are excluded from ranking.
- One passing candidate can win through validation alone.
- Applying the winner requires a second approval.
- Repository path, base `HEAD`, clean state, and patch SHA-256 are checked before apply.
- Reports retain ranking, changed files, process status, validation results, hashes, verifier request counts, and token usage.
- The current release supports macOS and Linux and is pinned to DeepSeek Harness `0.1.0-rc.7`.

Always disclose:

- validation commands execute target-repository code on the host;
- the public version is for trusted repositories;
- installation currently requires cloning and building from source;
- real candidate and verifier runs consume paid model requests.

## Recommended repository metadata

### Description

DeepSeek Harness plugin that validates and ranks 3/5 independent coding-agent patches before approval-gated apply.

### Topics

Keep the topic set focused:

```text
deepseek-harness
dsh-plugin
coding-agent
ai-agents
agent-evaluation
llm-as-a-verifier
llm-as-judge
patch-verification
git-worktree
developer-tools
typescript
```

Remove topics that imply unrelated capabilities, especially `llm-as-a-service`.

### Social preview

Create a 1280×640 image containing only:

```text
dsh-llm-verifier
Generate → Validate → Rank → Approve
Best-of-3/5 patch selection for DeepSeek Harness
```

Use a clean dark-on-light or DeepSeek-blue visual. Do not imply container isolation until the implementation provides it.

## Demo asset checklist

Before broad promotion, record one synthetic, reproducible run in a small public fixture repository:

1. Start from a clean repository containing one intentional bug and a deterministic test suite.
2. Show the original failing test.
3. Call `verified_best_of` with three candidates and an explicit validation command.
4. Show that candidates use separate worktrees.
5. Show one candidate failing validation and being excluded.
6. Open the generated `report.md` and summarize the ranking.
7. Inspect `winner.patch`.
8. Stop before apply and explain the second approval.
9. Call `apply_verified_winner`.
10. Show the final passing test and clean, reviewable diff.

Produce:

- one 45–60 second silent GIF for the README;
- one 2–4 minute narrated video;
- one sanitized `report.md` excerpt;
- one architecture diagram;
- one table comparing a single run with Best-of-3.

Never record a real credential, absolute home path, private repository name, private source, or full model trace.

## Channel sequence

### Gate 1 — repository conversion

Complete before posting outside GitHub:

- bilingual README merged;
- security policy and contribution guide merged;
- issue and pull-request templates merged;
- focused repository description and topics set;
- demo GIF added;
- one tagged developer-preview release with accurate notes;
- installation instructions verified in a fresh environment.

### Gate 2 — DeepSeek Harness ecosystem

Prioritize the ecosystem where users can immediately install or evaluate the plugin:

1. Submit to `awesome-dsh-plugin/awesome-dsh-plugin` after every stated eligibility rule is met on the default branch. Its current rules require a `dsh.bundle` manifest, the `dsh-plugin` topic, a repository at least one day old, and at least ten commits.
2. Submit a factual entry to one suitable DeepSeek Harness curated list.
3. Share the demo in relevant DeepSeek Harness community channels.
4. Ask for two specific forms of feedback: installation failures and cases where the verifier selected a weaker passing patch.

Do not submit duplicate entries to many lists on the same day.

### Gate 3 — Chinese developer communities

Suggested order:

1. V2EX `分享创造`;
2. 掘金 technical deep dive;
3. 即刻 or a personal WeChat post with the demo;
4. HelloGitHub submission after the repository has a stable tagged release and a polished demo.

### Gate 4 — English developer communities

Suggested order:

1. Show HN;
2. one relevant Reddit community;
3. DEV or Hashnode technical article;
4. X / LinkedIn thread.

Product Hunt should wait until installation is simpler and the repository has a polished visual demo.

## Ready-to-post copy

### V2EX

**Title**

```text
[开源] 给 DeepSeek Harness 做了一个 Best-of-3/5 补丁验证器：先跑测试，再让 LLM 排名
```

**Body**

```text
最近在用 Coding Agent 改项目时，我反复遇到一个问题：同一个任务多跑几次，经常能得到质量差异很大的补丁，但手动创建隔离环境、逐个测试、比较 diff，再决定采用哪一个，成本很高。

所以我做了 dsh-llm-verifier，一个 DeepSeek Harness 的开发者预览插件。

它当前会：

1. 让 3 个或 5 个候选接收同一项编码任务；
2. 把候选修改放到独立的 detached Git worktree；
3. 先执行项目测试，失败候选直接淘汰；
4. 只把通过测试的补丁交给 llm-verifier 排名；
5. 生成 report.md 和 winner.patch；
6. 只有第二次明确授权后才应用获胜补丁，并重新执行验证。

当前固定支持 DeepSeek Harness 0.1.0-rc.7、Node.js 24、macOS/Linux，需要从源码构建。验证命令仍会在宿主机执行仓库代码，所以当前版本只适合可信仓库。

项目地址：
https://github.com/Web0926/dsh-llm-verifier?utm_source=v2ex&utm_medium=community&utm_campaign=developer_preview

我现在最希望验证两个问题：

- 安装和首次跑通过程中，哪些步骤最容易失败？
- 多个候选都通过测试时，Verifier 有没有选出明显更差补丁的 case？

欢迎直接提 Issue，报告里请勿放凭据或私有代码。
```

### Show HN

**Title**

```text
Show HN: dsh-llm-verifier – Validate and rank multiple DeepSeek Harness patches
```

**Body**

```text
I built dsh-llm-verifier after repeatedly finding that independent coding-agent runs produced very different patches for the same task.

The plugin runs 3 or 5 DeepSeek Harness candidates in detached Git worktrees, gives each candidate the same task, runs the target project's validation commands, excludes every failing patch, and uses llm-verifier only when multiple passing candidates still need comparison.

The original checkout is unchanged during candidate generation. The selected patch is written to a local artifact and requires a separate approval before it is applied; the plugin then reruns the original validation commands.

The current version is intentionally narrow: DeepSeek Harness 0.1.0-rc.7, Node.js 24, macOS/Linux, source installation, and trusted repositories only. Validation commands still execute repository code on the host, so detached worktrees should not be read as a security sandbox.

Repository and setup:
https://github.com/Web0926/dsh-llm-verifier?utm_source=hackernews&utm_medium=community&utm_campaign=developer_preview

I would especially value examples where all candidates pass deterministic tests but the verifier chooses a clearly weaker patch. Those cases are useful for improving both the ranking criteria and the regression set.
```

### Reddit

**Title**

```text
I built a validation-first Best-of-3/5 patch selector for DeepSeek Harness
```

**Body**

```text
I have been experimenting with a workflow where the same coding task is given to several independent agent runs, then deterministic project tests filter the candidates before an LLM judge compares the remaining patches.

I packaged the workflow as a developer-preview DeepSeek Harness plugin: dsh-llm-verifier.

Current flow:
- 3 or 5 candidates in detached Git worktrees
- identical task for every candidate
- explicit or auto-detected project validation
- failed patches excluded before LLM ranking
- report plus winner.patch generated locally
- separate approval required before apply
- validation rerun after apply

Important limitation: validation commands still run repository code on the host, so this version is for trusted repositories. It is source-installed and pinned to DSH 0.1.0-rc.7 / Node 24.

Repo:
https://github.com/Web0926/dsh-llm-verifier?utm_source=reddit&utm_medium=community&utm_campaign=developer_preview

Feedback I am looking for: ranking failures where several patches pass the tests, plus friction in the first-run setup.
```

### X / LinkedIn

```text
I open-sourced dsh-llm-verifier, a validation-first Best-of-3/5 workflow for DeepSeek Harness.

→ independent candidates in detached Git worktrees
→ project tests before LLM ranking
→ failing patches excluded
→ auditable report + winner.patch
→ separate approval before apply
→ validation rerun after apply

Developer preview: DSH 0.1.0-rc.7, Node 24, macOS/Linux, trusted repositories, source install.

https://github.com/Web0926/dsh-llm-verifier?utm_source=social&utm_medium=post&utm_campaign=developer_preview
```

## Technical article angles

Choose one argument per article:

1. **Why Best-of-N needs validation before judging:** deterministic project signals should filter obvious failures before model-based comparison.
2. **Detached worktrees as orchestration isolation:** what they isolate, what they do not isolate, and why host execution remains a security boundary.
3. **Two approval gates for coding agents:** separating expensive candidate execution from repository mutation.
4. **When an LLM verifier adds value:** compare zero, one, two, three, and five passing-candidate paths.
5. **How to turn ranking mistakes into a regression set:** preserve synthetic failure cases and improve criteria over time.

Every article should include a runnable example, an explicit limitation section, and a link to one relevant source file or test.

## Launch measurements

Track a small activation funnel rather than stars alone:

| Stage | Metric |
|---|---|
| Discovery | Unique repository visitors by UTM source |
| Intent | README-to-install-section engagement or documentation clicks |
| Activation | Fresh-environment installation succeeds |
| First value | One `verified_best_of` run reaches `winner_selected` |
| Trust | User inspects `report.md` or `winner.patch` before apply |
| Adoption | One `apply_verified_winner` run completes validation |
| Learning | Reproducible issue, ranking counterexample, or contribution |
| Retention | A user runs the plugin again on a second task |

For the first launch cycle, a useful outcome is five independent successful installs, three real completed runs, and at least one high-quality ranking counterexample or contribution.

## Response templates

### Installation failure response

```text
Thanks for trying it. Please share the operating system/architecture, DSH/Node/pnpm/uv/Python versions, the failed step, and sanitized error text. Remove credentials, private source, prompts, absolute paths, and proprietary logs. A minimal synthetic repository is ideal.
```

### Ranking-quality response

```text
This is exactly the kind of case that can improve the project. Please reduce it to synthetic candidate patches and the validation result, explain why the selected patch is weaker, and remove all private repository material. I will treat it as a ranking regression case rather than relying on the original private trace.
```

## Maintenance cadence

- Reply to reproducible issues within the next active maintenance window.
- Publish release notes for every tagged version.
- Post only when there is a meaningful demo, capability, reliability improvement, or learning.
- Convert recurring installation failures into Quick Start fixes.
- Convert ranking counterexamples into synthetic tests or evaluator fixtures.
- Keep all channel descriptions synchronized with the README's current security boundary.
