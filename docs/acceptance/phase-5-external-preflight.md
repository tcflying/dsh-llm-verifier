# Phase 5 External Execution Preflight

Status: APPROVAL REQUIRED

This record describes local readiness only. It contains no Hosted CI, model, verifier-provider, or benchmark result.

## Local baseline

| Field | Value |
|---|---|
| `commitSha` | `ce06d928d495b865920aa0b24907a3b8d3ead669` |
| `localTypecheck` | PASS |
| `localBuild` | PASS |
| `localTests` | 160/160 PASS before this preflight batch |
| `localDiffCheck` | PASS |
| `workingTree` | Preserved Phase 0–5 accepted, uncommitted changes |

These local results do not prove Hosted CI behavior or real model quality.

## Hosted CI preflight

```text
workflowExpected=true
triggered=false
remoteMutation=false
credentialProvided=false
runId=null
commitSha=ce06d928d495b865920aa0b24907a3b8d3ead669
```

No workflow was triggered, no GitHub API was used, and no hosted result or image digest exists. An actual run identifier, remote commit SHA, runner timing, log URL, and artifact digest may be recorded only after separately authorized execution returns them.

## External execution defaults

```text
approvalRequired=true
credentialUsageAuthorized=false
modelExecutionAuthorized=false
terminalBenchAuthorized=false
hostedCiAuthorized=false
maxModelRequests=null
maxTotalTokens=null
estimatedCostCeiling=COST_ESTIMATE_UNAVAILABLE
```

The approval input and deterministic calculation contract is defined in `phase-5-external-approval-template.md`.

## Evidence schema

An authorized external run must record facts returned by that run without inventing missing values:

| Field | Pre-execution value |
|---|---|
| `executionType` | One approved experiment type |
| `status` | `APPROVAL REQUIRED` |
| `runId` | `null` |
| `remoteCommitSha` | `null` |
| `requestCount` | 0 |
| `inputTokens` | 0 |
| `outputTokens` | 0 |
| `cost` | 0 |
| `imageDigest` | N/A — no image executed |
| `benchmarkArtifactHash` | `null` |
| `evidenceHash` | `null` |
| `cleanup` | NOT EXECUTED |

Missing external evidence remains `null`, N/A, or NOT EXECUTED as appropriate. It must never be replaced with a sample run, guessed digest, local test result, or synthetic success state.

## Entry decision

The repository satisfies the local preparation baseline. External execution is still blocked until the user explicitly approves the selected execution types, credential usage, maximum request counts, Token ceiling, cost limit, failure retry policy, and all hard stop conditions.

