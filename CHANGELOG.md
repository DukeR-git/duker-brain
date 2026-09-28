# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-09-28

First public release.

### Added

- **Router** (`pi-traverser`): a Pi extension that routes each prompt through a
  hierarchical Obsidian vault with a System-1 decision model and injects the
  matching note. Includes a gate, per-folder catch-alls, a circuit breaker,
  per-session deduplication and reinjection after a configurable number of
  turns.
- **Composite routing**: prompts that span several branches can inject more
  than one note, sharing a single context budget.
- **Route cache**: repeated prompts skip the decisions API. The cache is
  invalidated whenever the manifests are recompiled.
- **Keeper** (`brain-keeper`): 17 `brain_*` tools for adding to, searching,
  restructuring, checking, evaluating and exporting the vault. They run as
  native Pi tools and as an MCP server for Claude Code, Codex and other MCP
  clients. Also the `/brain-init`, `/brain-capture`, `/brain-research` and
  `/brain-export` commands.
- **Routing evals**: `brain-traverse eval` and `brain_eval` run a vault's
  `evals.json` and report accuracy, regressions, latency and near ties.
- **Rules export**: `brain-keeper export` writes the vault out as Cursor rules,
  Windsurf rules, an Aider file list or a single Markdown bundle.
- **CLIs**: `brain-traverse` (route, eval, health, stats, lint, bench, config)
  and `brain-keeper` (init, setup, serve, doctor, rebuild, watch, search, tree,
  export).
- **Shared core** (`brain-core`): vault schema, frontmatter parser, manifest
  compiler, traversal engine, decisions client and layered, validated
  configuration.
- **host-laya**: an optional, Jev-compatible FastAPI decisions service around a
  local Laya checkpoint, containerised for Intel Arc GPUs.

[Unreleased]: https://github.com/DukeR-git/duker-brain/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/DukeR-git/duker-brain/releases/tag/v1.0.0
