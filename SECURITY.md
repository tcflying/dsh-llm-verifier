# Security Policy

## Project status

`dsh-llm-verifier` is currently a developer preview. The public version uses detached Git worktrees and DeepSeek Harness permission controls for candidate generation, while validation commands execute target-repository code on the host. Use it only with repositories and commands you trust.

The supported public baseline is the latest revision of the default branch with:

- DeepSeek Harness `0.1.0-rc.7`;
- Node.js 24;
- `llm-verifier==0.2.0`.

## Reporting a vulnerability

Do not open a normal public issue containing:

- exploit instructions;
- credentials, tokens, or secrets;
- private source code or repository content;
- unredacted logs or absolute local paths;
- a working proof of concept that could put users at immediate risk.

Use GitHub's **Report a vulnerability** flow on the repository Security page when it is available. If that private flow is unavailable, open a minimal public issue titled `Private security report requested` with only:

- the affected component;
- a high-level impact category;
- confirmation that you can provide details privately.

A maintainer can then arrange a private channel. Do not include technical details in that public issue.

## Security-relevant areas

Reports are especially useful when they concern:

- approval bypass or confused-deputy behavior;
- execution outside the intended candidate workspace;
- repository path or `HEAD` identity bypass;
- patch integrity or SHA-256 verification bypass;
- credential exposure to validation processes, logs, artifacts, diffs, binaries, or symlink targets;
- process-group termination or residual process failures;
- unsafe cleanup of worktrees or user files;
- unexpected commit, push, stash, reset, merge, or apply behavior;
- verifier input containing material that should remain local.

## Handling secrets in reports

Replace every secret with a synthetic sentinel and verify that the sentinel is enough to reproduce the issue. When a report depends on a private repository shape, provide a minimal synthetic repository that preserves the behavior without preserving the original content.
