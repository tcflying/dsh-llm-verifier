## Summary

Describe the user-visible problem and the focused change that solves it.

## Scope

- In scope:
- Explicitly out of scope:

## Safety impact

Describe any effect on approvals, credentials, process isolation, validation, repository identity, patch integrity, Git mutation, artifacts, or cleanup. Write `None` only after checking each area.

## Validation

List the exact commands run and their results.

```text
pnpm run typecheck
pnpm test
pnpm run build
python3 -m py_compile python/verifier_bridge.py
```

## Checklist

- [ ] The change is narrowly scoped and contains no unrelated refactor or formatting churn.
- [ ] Tests cover the relevant success and failure paths.
- [ ] Tests use synthetic repositories and credentials and do not call a live model API.
- [ ] No credential, private source, prompt, absolute local path, or run artifact is included.
- [ ] `README.md` and `README.zh-CN.md` are both updated when user-visible behavior changes.
- [ ] Dependency and lockfile changes are intentional and explained.
