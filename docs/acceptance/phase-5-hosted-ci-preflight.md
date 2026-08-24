# Phase 5 Hosted CI Preflight

Status: APPROVAL_REQUIRED

This document freezes the local state before any Hosted CI execution. It is not a workflow run result and grants no remote permission.

## Preflight state

```text
workflowConfigured=expected
workflowTriggered=false
remoteMutation=false
credentialProvided=false
runId=null
runUrl=null
commitSha=ce06d928d495b865920aa0b24907a3b8d3ead669
artifactDigest=null
```

`workflowConfigured=expected` records only that the repository contains the locally reviewed workflow source. It does not prove that GitHub accepted, scheduled, or ran the workflow.

## Manual trigger contract

```text
LOCAL_PREPARED
      |
      v
APPROVAL_REQUIRED
      |
      v
HOSTED_EXECUTION_ALLOWED
```

The current state is `APPROVAL_REQUIRED`. `HOSTED_EXECUTION_ALLOWED` may be entered only after the user explicitly authorizes the exact remote commit, workflow, trigger mechanism, credential policy, and evidence-collection scope.

Any trigger intent while approval is absent returns `HOSTED_CI_NOT_AUTHORIZED`. It must not call GitHub, create a run, select a fallback commit, or infer approval from local test success.

## Hosted CI evidence schema

The following fields are required for a future authorized run. Their current values deliberately describe non-execution:

| Field | Current value |
|---|---|
| `workflowName` | `null` |
| `runId` | `null` |
| `commitSha` | `ce06d928d495b865920aa0b24907a3b8d3ead669` — local expected commit only |
| `runnerOS` | `UNKNOWN` |
| `nodeVersion` | `UNKNOWN` |
| `pythonVersion` | `UNKNOWN` |
| `dependencyInstallMode` | `UNKNOWN` |
| `testCommand` | `null` |
| `result` | `NOT_EXECUTED` |
| `artifactHashes` | `null` |
| `duration` | `null` |
| `cleanupStatus` | `NOT_EXECUTED` |
| `credentialUsage` | `NOT AUTHORIZED` |

Only values returned by an authorized Hosted CI run may replace these fields. A local run, sample identifier, guessed URL, synthetic green state, placeholder digest, or copied result from another commit is invalid evidence.

## Current external gates

- Hosted CI: APPROVAL REQUIRED
- Native Best-of-3: APPROVAL REQUIRED
- Native Best-of-5: APPROVAL REQUIRED
- Terminal-Bench: APPROVAL REQUIRED
- Credential usage: NOT AUTHORIZED
- Cost: 0

