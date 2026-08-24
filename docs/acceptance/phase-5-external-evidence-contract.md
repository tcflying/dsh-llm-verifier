# Phase 5 External Execution Evidence Bundle Contract

Status: EXTERNAL EXECUTION PENDING; APPROVAL REQUIRED

This contract freezes the evidence shape for a future authorized external run. It does not authorize or report a Hosted CI run, model request, credential use, or benchmark execution. Local test results must never be placed in an external evidence field.

## Uniform evidence envelope

Every future external execution bundle must use this envelope without omitting a top-level field:

```json
{
  "executionType": "NOT_EXECUTED",
  "authorizationRecord": {
    "status": "APPROVAL_REQUIRED",
    "approvalId": null,
    "approvedAt": null,
    "approvedBy": null
  },
  "requestBudget": {
    "status": "NOT_AUTHORIZED",
    "maximumRequests": 0,
    "actualRequests": 0
  },
  "tokenCeiling": {
    "status": "NOT_AUTHORIZED",
    "maximumTokens": 0,
    "actualTokens": 0
  },
  "costLimit": {
    "currency": "USD",
    "maximumCost": 0,
    "actualCost": 0
  },
  "credentialDeclaration": {
    "status": "NOT_AUTHORIZED",
    "credentialName": null,
    "credentialValueRecorded": false
  },
  "environment": {
    "status": "UNKNOWN",
    "provider": null,
    "region": null
  },
  "sourceCommit": "ce06d928d495b865920aa0b24907a3b8d3ead669",
  "workflowEvidence": {
    "status": "NOT_EXECUTED",
    "workflowName": "NOT_EXECUTED",
    "runId": null,
    "runUrl": null,
    "triggerTime": null,
    "runnerOS": "UNKNOWN",
    "nodeVersion": "UNKNOWN",
    "pythonVersion": "UNKNOWN",
    "commitSha": null,
    "workflowStatus": "NOT_EXECUTED",
    "artifactHashes": [],
    "logsDigest": null
  },
  "modelEvidence": {
    "status": "NOT_EXECUTED",
    "candidateGeneration": {
      "candidateCount": 0,
      "candidateRequestCount": 0,
      "candidateSuccessCount": 0,
      "candidateFailureCount": 0
    },
    "verification": {
      "verificationCount": 0,
      "validationFailures": 0,
      "timeoutCount": 0,
      "cancelCount": 0
    },
    "ranking": {
      "eligibleCount": 0,
      "verifierResultDigest": null,
      "winnerSelectionEvidence": null
    }
  },
  "benchmarkEvidence": {
    "status": "NOT_EXECUTED",
    "benchmarkVersion": null,
    "taskSetIdentity": null,
    "candidateBundleHash": null,
    "bridgeSelectionDigest": null,
    "directSelectionDigest": null,
    "comparisonResult": "NOT_EXECUTED",
    "consistencyStatus": "UNKNOWN"
  },
  "artifactEvidence": {
    "status": "NOT_EXECUTED",
    "bundleHash": null,
    "manifestHash": null,
    "externalArtifacts": []
  },
  "cleanupEvidence": {
    "status": "NOT_EXECUTED",
    "containersRemoved": "UNKNOWN",
    "worktreesRemoved": "UNKNOWN",
    "residualProcesses": "UNKNOWN",
    "temporaryArtifacts": "UNKNOWN"
  },
  "finalDecision": "EXTERNAL_EXECUTION_PENDING"
}
```

The fixed `sourceCommit` identifies the local source snapshot prepared for acceptance. It is not an artifact hash, workflow result, or proof that the commit was executed externally.

## Hosted CI evidence rules

- Until an authorized hosted run finishes, `workflowEvidence.status`, `workflowName`, and `workflowStatus` remain `NOT_EXECUTED`; unknown runtime values remain `UNKNOWN`; run identifiers, URLs, times, commit SHA, and log digest remain `null`; artifact hashes remain empty.
- A future `runUrl` must be copied from the actual provider response. A guessed URL or sample run is invalid evidence.
- `artifactHashes` must be computed from downloaded artifacts produced by the recorded run. The local source commit, a local build output, or a placeholder digest must not be presented as an artifact hash.
- `logsDigest` must be derived from the retained hosted log artifact, not local output.

## Native Best-of evidence rules

Native execution evidence has three separate planes:

1. `candidateGeneration` records candidate count, request count, successes, and failures.
2. `verification` records verifier calls, validation failures, timeouts, and cancellations.
3. `ranking` records eligible candidates, the verifier result digest, and winner-selection evidence.

All counters are zero and all ranking artifacts are `null` while `modelEvidence.status` is `NOT_EXECUTED`. Best-of-3 and Best-of-5 require separate bundles; counts from one may not be reused for the other.

## Terminal-Bench evidence rules

The benchmark version and task-set identity must identify the exact executed benchmark input. The candidate bundle, bridge selection, and direct selection must each have their own digest. `comparisonResult` may be populated only from those retained artifacts, and `consistencyStatus` may be decided only after the comparison is complete.

A placeholder score, synthetic pass, local deterministic test, or unexecuted fixture is not Terminal-Bench evidence. Before authorization and execution, the benchmark state remains exactly `NOT_EXECUTED` / `null` / `UNKNOWN` as shown above.

## Rejection and decision rules

An evidence bundle is invalid if any of these conditions applies:

- external evidence appears while `authorizationRecord.status` is not `APPROVED`;
- a workflow, model, or benchmark claims success while its status is `NOT_EXECUTED`;
- any artifact or result digest is a placeholder, guessed value, local source commit, or untraceable synthetic value;
- request, token, credential, or cost evidence exceeds its recorded authorization;
- required cleanup state or source identity is omitted;
- local evidence is presented as Hosted CI, native model, or Terminal-Bench evidence.

The current and only permitted decision is `EXTERNAL_EXECUTION_PENDING`. `RELEASE_READY` and `BENCHMARK_VALIDATED` are forbidden until separately authorized external execution produces a complete, traceable, internally consistent bundle.

## Current gate state

- Hosted CI: APPROVAL REQUIRED
- Native Best-of-3: APPROVAL REQUIRED
- Native Best-of-5: APPROVAL REQUIRED
- Terminal-Bench: APPROVAL REQUIRED
- Credential: NOT AUTHORIZED
- Cost: 0

