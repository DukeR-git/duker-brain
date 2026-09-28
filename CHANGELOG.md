# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-09-28

### Added

- **Starter and shared brains.** `brain-keeper add <source>` adds a ready-made
  brain to yours as its own folder: a starter by name, any GitHub repository or
  folder in one (`owner/repo[/folder][#ref]`), another git URL, or a folder on
  disk. `brain-keeper update` pulls in new and changed notes and keeps the
  ones you edited, using the source and file hashes recorded in
  `.brain-sources.json`. `brain-keeper starters` lists what is available, and
  `init --starter <source>` starts a new brain with one. Only Markdown notes and
  `evals.json` are copied; a brain's evals are merged into the vault's suite.
  Also available as `/duker-brain:add` and `/duker-brain:update` in Claude Code,
  and `/brain-add` and `/brain-update` in Pi.
- The first starter brain, `python-backend`: FastAPI, asyncio, SQLAlchemy 2.0
  and PostgreSQL, Alembic, pytest and uv, in 10 notes with 12 routing evals.

### Changed

- The README now presents the decision model as a choice between the hosted
  TypeSafe Jev API and a local, self-hosted Laya model, including what each one
  sends off your machine.

## [1.1.0] - 2026-09-28

### Added

- **Claude Code plugin.** Install with `/plugin marketplace add DukeR-git/duker-brain`
  and `/plugin install duker-brain@duker-brain`. A `UserPromptSubmit` hook
  routes every prompt and adds the matching note as context, with the same
  reminders, trivial-prompt skipping and circuit breaker as the Pi extension.
  It also brings the 17 `brain_*` tools as an MCP server and the
  `/duker-brain:init`, `status`, `capture` and `research` commands. The vault,
  API key and decisions URL can be set in the plugin's settings dialog.
- `dist/` now holds fully self-contained bundles, including the new
  `brain-hook.mjs`, and is committed, so the plugin runs with no `npm install`.

### Changed

- Node.js 22 or newer is now required. Node.js 20 reached end of life in April
  2026, and the test scripts rely on Node 22's built-in glob expansion, which
  Windows shells do not provide. CI tests Node 22 and 24.
- Development now uses TypeScript 7. `@types/node` stays on Node 22, the
  oldest supported version, so the types only offer APIs Node 22 has.

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

[Unreleased]: https://github.com/DukeR-git/duker-brain/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/DukeR-git/duker-brain/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/DukeR-git/duker-brain/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DukeR-git/duker-brain/releases/tag/v1.0.0
