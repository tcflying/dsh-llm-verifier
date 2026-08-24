# Phase 5 Security Report

Status values in this report distinguish local evidence from work that has not run. No hosted workflow or live evaluation result is inferred from source inspection.

## Runtime

| Runtime | Version | Status |
|---|---|---|
| Node | 24.14.0 | VERIFIED LOCALLY |
| pnpm | 11.7.0 | VERIFIED LOCALLY |
| uv | 0.11.6 | VERIFIED LOCALLY |
| Python | 3.13.13 | VERIFIED LOCALLY through the frozen offline uv environment |
| DeepSeek Harness | 0.1.0-rc.7 | VERIFIED LOCALLY |
| `llm-verifier` | 0.2.0 | VERIFIED LOCALLY through the complete offline bridge cache test |

## Security

| Check | Result | Status |
|---|---|---|
| Credential-value scan | No credential-like value found in the Phase 5 file set | VERIFIED LOCALLY |
| CI secret-reference scan | No `secrets` or `vars` expression and no common model API-key variable name | VERIFIED LOCALLY |
| CI checkout credential persistence | Disabled; workflow permission is `contents: read` | VERIFIED LOCALLY |
| Dependency modification | No project manifest or lockfile changed by Phase 5 | VERIFIED LOCALLY |
| Network execution | No network command executed for local acceptance | NOT EXECUTED |
| Hosted GitHub workflow | Workflow source exists; no hosted run was triggered | NOT EXECUTED |
| Model execution | No live candidate or verifier evaluation | NOT EXECUTED |

## Privacy warnings

`privacyWarnings:`

- no credential values accessed
- no model responses collected
- no external data uploaded

The tests contain credential variable names and constructed synthetic patterns only. They never serialize credential values, value lengths, hashes, or prefixes.

## Execution metadata

| Field | Value |
|---|---|
| `stageDuration.securityContract` | 0.057 seconds; 6/6 passed |
| `stageDuration.typecheck` | 1.281 seconds; passed |
| `stageDuration.build` | 1.014 seconds in the latest Round 4 gate; passed |
| `stageDuration.documentationContract` | 0.067 seconds; 6/6 passed |
| `stageDuration.fullTest` | 7.875 seconds wall time in the latest Round 4 gate; 154/154 passed |
| `cleanup` | VERIFIED LOCALLY — synthetic markers cleared and inherited process/container/worktree cleanup tests passed |
| `resourceResidue` | false in deterministic fixtures and the complete local suite |
| `imageDigest` | N/A — no evaluation image executed |

## Cost and external evaluation

- DeepSeek requests: 0
- Native Best-of-N executions: 0
- Terminal-Bench executions: 0
- Cost: 0
- Status: approval required

## Documentation and hosted-CI readiness

- Bilingual Phase 5 boundaries: COMPLETE LOCALLY
- Documentation contract: 6/6 dedicated tests and 154/154 complete suite passed
- Hosted CI workflow source contract: VERIFIED LOCALLY
- Hosted CI execution: NOT EXECUTED
- External validation: NOT EXECUTED
