# Phase 5 External Execution Approval Template

Status: APPROVAL REQUIRED

This template calculates ceilings only. Completing it does not authorize credential access, model requests, benchmark execution, Hosted CI, or any remote mutation. The user must explicitly approve the completed values and every selected execution type before execution begins.

## Approval inputs

| Field | Required value |
|---|---|
| `experimentType` | One of `native-best-of-3`, `native-best-of-5`, or `terminal-bench-best-of-5` |
| `candidateCount` | Exactly 3 or 5 for the matching experiment |
| `tasksCount` | Positive integer |
| `benchmarkCases` | Positive integer for Terminal-Bench; otherwise 0 |
| `verifierCount` | Non-negative integer |
| `selectionCount` | Non-negative integer |
| `bridgeRequests` | Non-negative integer |
| `directVerifierRequests` | Non-negative integer |
| `consistencyComparisonCount` | Positive integer for Terminal-Bench; otherwise 0 |
| `estimatedInputTokensPerCandidate` | Positive integer supplied for this approval |
| `estimatedOutputTokensPerCandidate` | Positive integer supplied for this approval |
| `verifierTokenEstimate` | Non-negative per-request verifier token estimate |
| `retryAllowance` | Non-negative ratio; a ceiling only, not retry authorization |
| `failureRetryPolicy` | Explicit policy; default is `no automatic retry` |
| `hardTokenCeiling` | Positive integer supplied for this approval |
| `inputTokenPrice` | User-supplied per-token price or omitted |
| `outputTokenPrice` | User-supplied per-token price or omitted |

No credential value belongs in this document. Approval records only whether credential use is separately authorized.

## Deterministic request calculation

For `native-best-of-3`:

```text
baseRequests = tasksCount * (3 + verifierCount + selectionCount)
```

For `native-best-of-5`:

```text
baseRequests = tasksCount * (5 + verifierCount + selectionCount)
```

For `terminal-bench-best-of-5`:

```text
baseRequests = (5 * benchmarkCases) + bridgeRequests + directVerifierRequests
consistencyComparisonCount = benchmarkCases
```

For every experiment:

```text
maxModelRequests = ceil(baseRequests * (1 + retryAllowance))
```

The retry allowance reserves a ceiling only. `failureRetryPolicy: no automatic retry` remains in force unless the user explicitly authorizes another policy.

## Deterministic token calculation

```text
candidateInputTokens = candidateRequests * estimatedInputTokensPerCandidate
candidateOutputTokens = candidateRequests * estimatedOutputTokensPerCandidate
verifierTokens = verifierRequests * verifierTokenEstimate
baseTotalTokens = candidateInputTokens + candidateOutputTokens + verifierTokens
tokenCeiling = ceil(baseTotalTokens * (1 + retryAllowance))
```

The approval package is invalid if `tokenCeiling` exceeds `hardTokenCeiling`; execution must not silently lower or reset either ceiling.

For deterministic reporting, combined verifier tokens are included in `maxInputTokens`; `maxOutputTokens` contains candidate output tokens. `maxTotalTokens` is their sum after the retry allowance.

## Cost calculation

```text
estimatedCostCeiling =
  (maxInputTokens * inputTokenPrice)
  + (maxOutputTokens * outputTokenPrice)
```

Both prices must be explicit approval inputs. This template intentionally contains no default provider price. If either price is absent, the result is `COST_ESTIMATE_UNAVAILABLE` and paid execution remains blocked.

## Required outputs

- `maxModelRequests`
- `maxInputTokens`
- `maxOutputTokens`
- `maxTotalTokens`
- `estimatedCostCeiling`
- `hardStopCondition`
- `approvalRequired=true`

## Hard stop conditions

- token ceiling exceeded
- cost limit exceeded
- unexpected credential usage detected
- request count exceeded
- benchmark artifact mismatch
- evidence hash mismatch

Any hard stop prevents new requests. It does not authorize retry, credential reuse, evidence replacement, or a second execution.

## Explicit approval record

- Hosted CI execution approved: no
- Native Best-of-3 approved request count: not approved
- Native Best-of-5 approved request count: not approved
- Terminal-Bench five-group execution approved: no
- Credential usage approved: no
- Token ceiling approved: no
- Cost limit approved: no
- Stop conditions approved: no
- `approvalRequired=true`

