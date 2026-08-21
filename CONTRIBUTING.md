# Contributing to dsh-llm-verifier

Thank you for helping improve `dsh-llm-verifier`. The project is currently a developer preview pinned to DeepSeek Harness `0.1.0-rc.7`, Node.js 24, pnpm `11.7.0`, and `llm-verifier==0.2.0`.

## Before opening a change

Open an issue before starting a large feature, dependency change, provider integration, or architectural refactor. Small bug fixes, tests, documentation corrections, and narrowly scoped reliability improvements can go directly to a pull request.

Keep proposals consistent with these project properties:

- Candidate generation and winner application remain separate operations.
- Applying a patch requires an explicit second approval.
- The plugin does not commit, push, stash, reset, or merge user repositories.
- Validation failures exclude candidates from model ranking.
- Credentials and private repository content must not appear in issues, fixtures, logs, or test snapshots.
- New behavior should fail closed when repository identity, integrity, or process state cannot be established.

## Development setup

Requirements:

- macOS or Linux
- Node.js 24
- pnpm `11.7.0`
- `uv`
- Git

```bash
pnpm install --frozen-lockfile
uv sync --frozen --project python
pnpm run check
```

Run individual checks with:

```bash
pnpm run typecheck
pnpm test
pnpm run build
python3 -m py_compile python/verifier_bridge.py
```

Automated tests must not call a live model API or require real credentials.

## Issues

Before reporting a bug:

1. Confirm the target is a normal, clean Git repository root.
2. Confirm the project uses DeepSeek Harness `0.1.0-rc.7` and Node.js 24.
3. Reproduce with the smallest safe task and validation command possible.
4. Remove credentials, private source code, prompts, absolute paths, and proprietary logs.

A useful report contains:

- operating system and architecture;
- Node.js, pnpm, `uv`, Python, and DSH versions;
- candidate count;
- explicit validation commands, when safe to disclose;
- expected and actual behavior;
- sanitized error text;
- whether cleanup left a plugin-created worktree or process.

For a potential vulnerability, follow [SECURITY.md](SECURITY.md) and do not publish exploit details in a normal issue.

## Pull requests

Keep each pull request focused. Include:

- the user-visible problem;
- the smallest implementation that solves it;
- tests covering success and failure paths;
- exact validation commands and results;
- any change to security boundaries, approvals, credentials, process isolation, repository mutation, or artifact retention.

Avoid unrelated formatting, dependency, lockfile, or refactor changes.

### Test expectations

Changes to orchestration, Git handling, validation, process cleanup, verifier input, or patch application should include regression tests for the relevant failure modes. Tests should use synthetic repositories, synthetic credentials, and deterministic verifier stubs.

### Documentation expectations

Update both `README.md` and `README.zh-CN.md` when a user-visible capability, requirement, default, limitation, or security boundary changes.

## Commit and review hygiene

- Do not include generated run artifacts, credentials, local paths, or private repository material.
- Do not weaken a safety check only to make a test pass.
- Prefer explicit, narrow changes over speculative abstractions.
- Preserve pinned runtime and dependency versions unless the pull request is specifically about a reviewed upgrade.

By contributing, you agree that your contribution will be licensed under the repository's [MIT License](LICENSE).
