# Phase 5 Test Stability Report

Status: DIAGNOSIS COMPLETE LOCALLY; EXTERNAL EXECUTION APPROVAL REQUIRED

This report preserves every observed full-suite result from the Round 2 instability discovery and the five-run Round 3 diagnostic matrix. A green run is not substituted for a failed run.

## Summary fields

| Field | Value |
|---|---|
| `testRunCount` | 9 |
| `successfulRuns` | 6 |
| `failedRuns` | 3 |
| `failureNames` | Three distinct failures listed below |
| `failureFrequency` | 3/9 overall; 0/5 in the dedicated diagnostic matrix |
| `failureDistribution` | Each observed failure name occurred once |
| `environment` | Local macOS sandboxed desktop test environment; exact OS build NOT RECORDED |
| `nodeVersion` | 24.14.0 |
| `pnpmVersion` | 11.7.0 |
| `cleanupObserved` | See resource observation; direct OS orphan inventory NOT RECORDED |
| `networkUsed` | false |
| `credentialUsed` | false |

## Complete run evidence

Durations are the Node test runner durations reported by each command.

| Run | Command context | Exit code | Tests | Failed suite | Failed test | Duration |
|---|---|---:|---|---|---|---:|
| R2-A | Hosted CI contract first run; full suite included | 1 | 173/174 | Best-of orchestration | `runs five isolated candidates and uses two verifier pivots` | 8.151 s |
| R2-B | Hosted CI contract exact rerun; full suite included | 0 | 174/174 | none | none | 7.935 s |
| R2-C | Independent full suite | 1 | 173/174 | process isolation | `kills the complete process group when a command times out` | 7.970 s |
| R2-D | Independent full suite exact rerun | 1 | 173/174 | process lifecycle contract | `force-kills a process group that ignores SIGTERM` | 8.328 s |
| R3-1 | Dedicated stability matrix | 0 | 174/174 | none | none | 8.578 s |
| R3-2 | Dedicated stability matrix | 0 | 174/174 | none | none | 8.520 s |
| R3-3 | Dedicated stability matrix | 0 | 174/174 | none | none | 9.127 s |
| R3-4 | Dedicated stability matrix | 0 | 174/174 | none | none | 8.514 s |
| R3-5 | Dedicated stability matrix | 0 | 174/174 | none | none | 8.502 s |

## Failure names and distribution

| Failure name | Observations | Distribution among failures |
|---|---:|---:|
| `runs five isolated candidates and uses two verifier pivots` | 1 | 1/3 |
| `kills the complete process group when a command times out` | 1 | 1/3 |
| `force-kills a process group that ignores SIGTERM` | 1 | 1/3 |

The failures moved between candidate orchestration and two different process-lifecycle assertions. None reproduced during the five-run diagnostic matrix. This is consistent with a timing or environment-noise candidate, but it does not prove an environment-only cause and does not rule out a low-frequency lifecycle defect.

## Resource observation

- Repository status was captured before and after the five-run matrix and was unchanged apart from the already expected Phase 0–5 and current preflight files.
- All five diagnostic runs passed the inherited process, container, worktree, cache, and cleanup assertions.
- The three carryover failures remain visible above. Two reported that a process group was still observable when the test expected it to be absent; the candidate-orchestration failure returned `failed` instead of `winner_selected`.
- No non-test process was killed and no environment, timeout, retry, order, source, or existing test was changed.
- A direct OS-level orphan-process inventory and an external temporary-directory inventory were not captured under the authorized command set. Therefore this report does not claim that an orphan process or external temporary artifact was impossible.

## Classification

| Question | Evidence-based answer |
|---|---|
| Repeated execution environment noise? | Possible, not proven; the five-run matrix did not reproduce any failure. |
| Deterministic resource leak? | Not demonstrated; failures moved and five consecutive cleanup suites passed. |
| Test-to-test residual process or temporary resource? | Not directly observed; a low-frequency residual-process race remains possible. |
| Ready for Hosted CI? | Local stability diagnosis is complete, but Hosted CI remains APPROVAL REQUIRED and NOT EXECUTED. |

No success-only summary is permitted. Future evidence must retain this 6-success/3-failure history unless a separately authorized root-cause investigation supersedes it with stronger evidence.

## External gates

- Hosted CI: APPROVAL REQUIRED
- Native Best-of-3: APPROVAL REQUIRED
- Native Best-of-5: APPROVAL REQUIRED
- Terminal-Bench: APPROVAL REQUIRED
- Credential usage: NOT AUTHORIZED
- Cost: 0

