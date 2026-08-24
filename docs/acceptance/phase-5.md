# Phase 5 Acceptance

## Round 1 scope

Round 1 establishes the zero-cost local and CI baseline. It does not call DeepSeek, run live Best-of-3/5, run Terminal-Bench bridge comparisons, install new project dependencies, or modify production code under `src/`.

The workflow pins Ubuntu 24.04, Node 24.14.0, pnpm 11.7.0, uv 0.11.6, Python 3.13.13, DeepSeek Harness 0.1.0-rc.7, and immutable action commits. Dependency preparation may access package registries in CI; the test gate itself sets `UV_OFFLINE=1` and does not receive or reference a DeepSeek credential.

## Round 1 local evidence

Recorded on 2026-08-23 against the existing Phase 0–4 working tree:

| Check | Result |
|---|---|
| `node -v` | `v24.14.0` |
| `pnpm -v` | `11.7.0` |
| `uv --version` | `0.11.6` |
| `uv run --frozen --offline --project python python --version` | `Python 3.13.13` |
| `dsh --version` | `0.1.0-rc.7` |
| `pnpm run typecheck` | pass |
| `pnpm run build` | pass |
| `pnpm test` | 136 passed, 0 failed |
| `git diff --check` | pass |
| Phase 5 tracked-file privacy pattern scan | no match |

No live model, API credential, Docker daemon, publish operation, Git staging, commit, push, or deployment was used to obtain this evidence.

## Deterministic matrix

| Requirement | Deterministic evidence |
|---|---|
| Best-of-3 eligible counts 0–3 | `tests/core.integration.test.ts` — “handles every Best-of-3 and Best-of-5 eligible-candidate count” |
| Best-of-5 eligible counts 0–5 | `tests/core.integration.test.ts` — same matrix test |
| Stable validation-only and verifier selection | `tests/core.integration.test.ts` — eligible-count matrix and five-candidate pivot test |
| Candidate starts and completes | `tests/core.integration.test.ts` — “keeps the source unchanged until a second approval applies the validated winner” |
| Candidate launch failure | `tests/process-lifecycle-contract.test.ts` — “returns a launch_failed result without exposing the environment” |
| Candidate non-zero exit / validation exclusion | `tests/core.integration.test.ts` — eligible-count matrix and false-success validation test |
| Candidate timeout and cancellation | `tests/process.test.ts`, `tests/process-lifecycle-contract.test.ts`, and `tests/core.integration.test.ts` cancellation test |
| Container cleanup after timeout / abort | `tests/docker-lifecycle-contract.test.ts` — independent stop and force-remove test |
| Verifier success | `tests/verifier-bridge.test.ts` and `tests/verifier-protocol-contract.test.ts` success tests |
| Verifier error | `tests/core.integration.test.ts` — verifier API failure test |
| Malformed verifier result | `tests/verifier-protocol-contract.test.ts` and `tests/verifier-bridge-contract.test.ts` |
| Verifier timeout | `tests/verifier-deadline-contract.test.ts` |
| First approval denial | `tests/phase-5-approval-denial-contract.test.ts` |
| Second approval denial | `tests/phase-5-approval-denial-contract.test.ts` |
| Changed `HEAD` | `tests/phase-5-approval-denial-contract.test.ts` |
| Dirty repository | `tests/git.test.ts` and `tests/core.integration.test.ts` |
| Patch tamper | `tests/core.integration.test.ts` and `tests/artifact-integrity-contract.test.ts` |
| Failure before apply mutation | `tests/apply-deadline-contract.test.ts` |
| Failure after apply | `tests/core.integration.test.ts` — post-apply validation failure test |
| Process, worktree, container, and cache cleanup | `tests/process-lifecycle-contract.test.ts`, `tests/git-lifecycle-contract.test.ts`, `tests/docker-lifecycle-contract.test.ts`, and `tests/verifier-bridge-contract.test.ts` |
| CI has no live credential or model invocation | `tests/phase-5-ci-contract.test.ts` |

All fixtures use synthetic credentials and fake executors or offline caches. No deterministic test invokes `verified_best_of` through a live Harness session or sends a request to a model provider.

### Round 2 matrix extension

`tests/phase-5-deterministic-matrix.test.ts` adds six auditable top-level cases covering:

1. Best-of-3 eligible counts 0–3 and Best-of-5 counts 0, 3, 4, and 5, including input-order invariance in the synthetic ranking fixture.
2. Candidate startup success/failure, non-zero exit, timeout, cancellation before start, and cancellation during execution.
3. Verifier success, timeout, error, invalid output, and partial output, with stable codes and redaction.
4. Clean, dirty, moved-`HEAD`, missing-patch, valid-patch, and tampered-patch states.
5. Failure before apply authorization/mutation and post-apply validation failure.
6. Synthetic process, temporary-directory, worktree-marker, timeout, cancellation, and failure cleanup.

The post-apply failure expectation deliberately preserves the inherited Phase 4 contract: the applied patch remains available for inspection and no automatic `git reset` rollback is attempted. Cleanup still completes. Changing that behavior would require a separately authorized production-code change and is outside Round 2.

Round 2 test-count accounting starts from the verified Round 1 total of 136 and adds six top-level tests. The complete local suite passed 142/142 with no failures, skips, cancellations, or todo cases. Live evaluation remains excluded from this matrix.

## Phase 5 status matrix

| Goal | Status |
|---|---|
| CI baseline | COMPLETE LOCALLY; HOSTED RUN PENDING |
| Approval denial contracts | COMPLETE |
| Deterministic execution matrix | COMPLETE LOCALLY — 142/142 FULL SUITE |
| Complete security and privacy scan | PENDING |
| Bilingual README completion | PENDING |
| Image digest, stage timing, cleanup, and privacy report fields | PENDING |
| Live native Best-of-3/5 and at least five Terminal-Bench comparisons | APPROVAL REQUIRED |

### Round 3 security status

- Deterministic matrix: PASS (offline synthetic only)
- Security scan: COMPLETE LOCALLY (ROUND 3); HOSTED/EXTERNAL SCANS NOT EXECUTED
- Hosted CI: PENDING
- Native Best-of-N: APPROVAL REQUIRED
- Terminal-Bench: APPROVAL REQUIRED

Round 3 adds a local CI-isolation, credential-output, and privacy-pattern contract plus a separate security report. It does not claim hosted-CI execution, production readiness, or Phase 5 completion.

### Round 4 documentation status

- Documentation contract: COMPLETE LOCALLY
- Hosted CI static source contract: COMPLETE LOCALLY
- Hosted CI execution: NOT EXECUTED
- Report metadata: COMPLETE LOCALLY for non-executed evaluation fields

The bilingual README now distinguishes the offline CI path, credential boundary, paid-evaluation approval gate, Git worktree isolation, Docker/container isolation, model execution data, and safe troubleshooting. The dedicated documentation contract passed together with the complete 154/154 local suite.

### Round 5 final gate status

The local release evidence is frozen with the following status values:

| Goal | Status | Evidence |
|---|---|---|
| CI baseline | COMPLETE LOCALLY | Immutable workflow-source and offline-entry contracts |
| Deterministic matrix | COMPLETE LOCALLY | Best-of-3/5, process, verifier, Git, approval, failure, and cleanup fixtures |
| Security/privacy | COMPLETE LOCALLY | Credential, CI-isolation, redaction, and privacy-pattern contracts |
| Documentation | COMPLETE LOCALLY | Equivalent bilingual boundaries and safe troubleshooting contracts |
| Final evidence contract | COMPLETE LOCALLY | Six final-gate contract cases and the complete local gate |
| Hosted CI | NOT EXECUTED | A hosted workflow run remains external work |
| Native Best-of-N | APPROVAL REQUIRED | Real model execution remains gated |
| Terminal-Bench bridge | APPROVAL REQUIRED | Real bridge comparison remains gated |

Current real-evaluation accounting is fixed:

- DeepSeek requests: 0
- Native Best-of-N executions: 0
- Terminal-Bench executions: 0
- Cost: 0
- Status: approval required

Isolation claims remain deliberately narrow. A Git worktree isolates code changes, Docker/container execution isolates the process environment, and model execution data requires a separate data boundary. These mechanisms cannot prove model quality; real model and bridge runs require evaluation approval.

The frozen local evidence contains runtime versions (Node 24.14.0, pnpm 11.7.0, uv 0.11.6, Python 3.13.13, and DeepSeek Harness 0.1.0-rc.7), local test results (160/160 passed), verified synthetic cleanup with no resource residue, the three privacy warnings in the security report, and `imageDigest: N/A` because no evaluation image ran. Hosted CI remains NOT EXECUTED.

## Phase 0–4 contract preservation

- Phase 0 Loader behavior remains covered by `tests/loader-contract.test.ts`; no Loader or public entry source is changed.
- Phase 1 Docker isolation remains covered by the Docker contract suites; no Docker production source is changed.
- Phase 2 candidate, validation, verifier, and process lifecycle source is unchanged.
- Phase 3/4 deadline, redaction, proxy, artifact integrity, and environment suites remain in the full `pnpm test` gate.
- Existing uncommitted work is preserved. Round 1 does not stage, commit, push, publish, deploy, or rewrite Git history.

## Live-call gate

Live native Best-of-3/5 and the five-or-more Terminal-Bench bridge comparisons remain **approval required**. Before any such run, the user must receive the exact planned candidate count, verifier-request estimate, maximum request count, and budget, then explicitly approve the paid calls. Round 1 produces no live-call result.

Use [`phase-5-evidence-template.md`](phase-5-evidence-template.md) for the local evidence captured after implementation.
