---
name: llm-verifier
description: >-
  MUST USE whenever the user wants multiple competing solution attempts, best-of-N
  candidates, a "多方案/多候选/择优/best-of-N/评审后采纳" workflow, or verification-backed
  code changes. Provides verified_best_of (N isolated candidates in git worktrees,
  each validated by a command), review routing (parent review or mcode_model
  machine review), then select_verified_candidate and apply_verified_winner
  (with rollback_verified_winner safety). Also use verifier_configure to change
  settings such as candidate count, review mode, validation command and timeouts.
displayNames:
  zh-Hans: 'LLM 验证器（多候选择优）'
descriptions:
  zh-Hans: >-
    当用户要求"多候选/多方案择优/best-of-N/评审后采纳/验证后修改代码"时必须使用。
    verified_best_of 在隔离 git worktree 里并行生成 N 个候选并各自验证，
    返回 review_pending 或 winner_selected；随后 select_verified_candidate 与
    apply_verified_winner 采纳优胜补丁，rollback_verified_winner 可安全回滚。
---

# LLM Verifier (best-of-N with review routing)

## When to use
- User asks for several competing solutions and picking the best ("best-of-N", "多候选择优", "评审后采纳").
- User wants code changes validated by a command before landing.

## Workflow contract (follow exactly)
1. Call `verified_best_of` with:
   - `repoPath`: the ABSOLUTE path of the git repository you are working in (always pass it).
   - `task`: the full coding task text.
   - Optional: `candidateCount` (1-5), `validationCommand`, `reviewMode`.
2. The tool returns one of:
   - `winner_selected` → proceed to step 4 (auto-selected single survivor or model review).
   - `review_pending` → read `reportPath` (and each `candidate-N.patch` listed in the
     response), judge the candidates yourself, then call `select_verified_candidate`
     with your `candidateId` and a short `reason`. Never skip the review.
3. `apply_verified_winner` applies the winner patch to `repoPath`.
4. If the user rejects the result, `rollback_verified_winner` reverses the patch
   (it refuses automatically if files were edited after apply).

## Settings
Read or change settings with `verifier_get_config` / `verifier_configure`:
`defaultCandidateCount`, `maxConcurrent`, `validationCommand` (empty = auto `npm test`),
`reviewMode` (`parent_agent` = you review diffs; `mcode_model` = a machine reviewer scores
candidates), `reviewerModel`, `candidateModel`, `candidateTimeoutMin`, `totalTimeoutMin`.
State lives under the plugin `data/runs/<runId>/` (manifest.json, report.md, candidate patches, worktrees).

## Boundaries
- Candidates are strongly isolated (git worktrees + contract prompt); never bypass by editing the origin repo yourself during a run.
- One run per repository at a time. The tool returns structured JSON; surface `status`, `winnerId`, `reportPath` to the user.
