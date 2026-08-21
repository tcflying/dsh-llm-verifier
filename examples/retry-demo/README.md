# Retry demo target

This deliberately small repository fixture contains an off-by-one defect in `src/retry.js`. It is intended for a public, synthetic `dsh-llm-verifier` demonstration.

## Establish the failing baseline

```bash
npm test
```

Two tests should fail because a budget of three attempts currently executes only two calls.

## Suggested `verified_best_of` task

```text
Fix the off-by-one defect in src/retry.js so maxAttempts includes the final allowed attempt. Preserve the public API and error behavior. Do not weaken or delete tests. Run npm test for validation. Do not apply a winner until I inspect the report and patch.
```

Suggested tool input:

```json
{
  "task": "Fix the off-by-one defect in src/retry.js so maxAttempts includes the final allowed attempt. Preserve the public API and error behavior. Do not weaken or delete tests.",
  "candidateCount": 3,
  "validationCommands": ["npm test"]
}
```

Use only synthetic credentials and paths when recording a demo. Do not publish model traces or absolute home-directory paths.
