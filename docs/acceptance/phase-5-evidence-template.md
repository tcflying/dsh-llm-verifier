# Phase 5 Local Evidence Template

This template records offline evidence only. Do not paste credentials, proxy URLs with userinfo, model prompts, full candidate trajectories, or live-model responses.

## Baseline

- Date (UTC):
- Commit / baseline `HEAD`:
- Pre-existing dirty files preserved:
- Node:
- pnpm:
- uv:
- Python:
- DeepSeek Harness:
- Loader:

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `pnpm run typecheck` | pending | |
| `pnpm run build` | pending | |
| `pnpm test` | pending | |
| `git diff --check` | pending | |

## Offline matrix

| Area | Cases | Result | Evidence |
|---|---|---|---|
| Best-of-3 / Best-of-5 | every eligible count | pending | |
| Candidate lifecycle | start, launch failure, non-zero, timeout, cancel | pending | |
| Verifier | success, error, malformed, timeout | pending | |
| Approval | first denial, second denial | pending | |
| Git integrity | changed HEAD, dirty tree, patch tamper | pending | |
| Apply | pre-apply failure, post-apply validation failure | pending | |
| Cleanup | process, container, worktree, temporary artifacts | pending | |

## Privacy and cost

- CI secret references: none expected
- Live DeepSeek requests: `approval required`
- Estimated live request count and budget shown to user: not yet authorized
- Credential-like values found in tracked diff:
- Privacy warnings:

## Changed files

- `git diff --stat`:
- `git diff --name-only`:
- New files:
- Remaining limitations:
