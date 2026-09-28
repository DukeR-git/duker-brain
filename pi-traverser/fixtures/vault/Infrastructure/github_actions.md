---
id: github_actions
title: GitHub Actions
criteria: GitHub Actions CI workflows, matrix builds, dependency caching with lockfile keys, runners, secrets on fork pull requests
---

# GitHub Actions

## Matrix builds
`strategy.matrix` expands to one job per combination. `fail-fast: false` keeps
the other combinations running when one fails, which is what you want when
diagnosing a platform-specific break.

## Caching
`actions/cache` keys should include a lockfile hash. A key that never changes
serves a stale cache forever.

## Secrets
Secrets are not available to workflows triggered by `pull_request` from forks.
