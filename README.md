# brain-traverse

[![CI](https://github.com/DukeR-git/duker-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/DukeR-git/duker-brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

Dynamic context routing for coding agents. Your knowledge lives in a
hierarchical Obsidian vault, "the brain". On every prompt, a fast System-1
decision model walks that tree and injects only the note that applies, not one
enormous system prompt.

Two hops, typically well under a second, and the agent sees the one guide it needs.

```
                 ┌────────────────────────────────────────┐
  prompt ───────>│ router (Pi extension)                  │
                 │   gate + hop 1 ──> hop 2 ──> leaf .md  │──> injected as a message
                 └──────┬───────────────────────┬─────────┘
                        │ POST /v1/systemone    │ reads _index.json
                        v                       v
          ┌──────────────────────────┐   ┌──────────────────┐
          │ decisions API            │   │  Obsidian vault  │
          │  TypeSafe Jev (default)  │   │   (the brain)    │
          │  or self-hosted Laya     │   └────────┬─────────┘
          └──────────────────────────┘            ^ writes
                                         ┌────────┴─────────┐
            agent ──tools / MCP─────────>│  brain-keeper    │
                                         └──────────────────┘
```

- **Router**: a [Pi](https://pi.dev) extension. It routes each prompt through the
  vault and appends the matching note to the conversation. Supports parallel composite
  routing for cross-cutting queries under a unified context budget.
- **Keeper**: 17 `brain_*` tools for adding to, searching, maintaining, evaluating and
  exporting the brain, plus `/brain-capture`, `/brain-research`, and `/brain-export`. They are native tools in Pi,
  and an MCP server for Claude Code, Codex and any other MCP client.
- **Decisions API**: the hosted [TypeSafe Jev](https://docs.typesafe.ai) API by
  default, which needs nothing installed besides an API key. A self-hosted
  [Laya](https://pypi.org/project/laya/) server works too (see [host-laya](host-laya)).

---

## Install

You need Node.js 22 or newer, and a TypeSafe API key from
[console.typesafe.ai/keys](https://console.typesafe.ai/keys).

### Pi

```bash
pi install git:github.com/DukeR-git/duker-brain
export TYPESAFE_API_KEY=sk-...
```

That installs the router, the 17 brain tools, and the `/brain`,
`/brain-init`, `/brain-capture`, `/brain-research` and `/brain-export` commands. Then create a
brain from inside Pi and reload:

```
/brain-init ~/brain --example
/brain reload
```

`--example` adds a small sample tree (Backend / Frontend / Infrastructure) so
routing has something to do straight away. Leave it out to start with just the
catch-all note. `/brain status` shows whether routing is live, and `/brain help`
lists all in-session subcommands.

Pointing `/brain-init` at an existing Obsidian vault is safe: it never
overwrites a note (it does regenerate `_index.json` files, which are build
output). Add `--dry-run` to see what it would do first, and list folders that
are not knowledge (Templates, Attachments, Daily Notes) in the vault's
`.brainignore`. Run `brain_doctor` (or `brain-keeper doctor`) afterwards to see
what the notes still need.

### Claude Code, Codex and other MCP clients

These harnesses get the keeper: the tools and the two commands. Automatic
routing on every prompt is currently implemented only for Pi.

```bash
git clone https://github.com/DukeR-git/duker-brain
cd duker-brain
npm install
node brain-keeper/bin/brain-keeper.mjs init ~/brain --example
node brain-keeper/bin/brain-keeper.mjs setup
```

`setup` prints the exact commands for this checkout, for example:

```bash
claude mcp add brain --scope user -- node /path/to/duker-brain/brain-keeper/bin/brain-keeper.mjs serve
codex mcp add brain -- node /path/to/duker-brain/brain-keeper/bin/brain-keeper.mjs serve
```

It also says where to copy the two command files. See
[brain-keeper/commands](brain-keeper/commands/README.md).

Already using Pi? The package is cloned at
`~/.pi/agent/git/github.com/DukeR-git/duker-brain`, so you can point the MCP
commands there instead of cloning again.

## Configuration

One config serves the router, the keeper and the CLIs. Settings are read in
this order, and later sources win:

1. `~/.config/brain-traverse/config.json`: per user. `init` writes `vaultRoot` here.
2. `./brain-traverse.config.json`, or the file named by `$BRAIN_CONFIG`: per project.
3. `BRAIN_*` environment variables.

The settings you are most likely to touch:

| Key | Env | Default | |
|---|---|---|---|
| `vaultRoot` | `BRAIN_VAULT_ROOT` | none | The brain. `~` is expanded. |
| `apiKey` | `TYPESAFE_API_KEY` or `BRAIN_DECISIONS_API_KEY` | none | Required for Jev, and for a Laya host started with `LAYA_API_KEY`. Prefer the env var to keeping it in a file. |
| `decisionsUrl` | `BRAIN_DECISIONS_URL` | `https://api.typesafe.ai` | Or a self-hosted Laya, e.g. `http://my-server:8081`. |
| `model` | `BRAIN_DECISIONS_MODEL` | `jev-latest` | Pin a version such as `jev-1.13.0` if you tune thresholds. |
| `minConfidence` | `BRAIN_MIN_CONFIDENCE` | `0.4` | Below this, fall back to the catch-all note. |
| `fallbackDocument` | `BRAIN_FALLBACK_DOC` | `auto` | `auto` uses the note marked `fallback: true`; a path pins one; `""` disables. |

Every value is validated: a typo'd key or a value of the wrong type is ignored
with a warning instead of silently misbehaving. `brain-traverse config` (or
`/brain config` in Pi) prints the resolved settings, where each came from, and
anything that was ignored. [config.example.json](config.example.json) lists every
key; the full reference is in [pi-traverser](pi-traverser/README.md#6-configuration).
The router and the keeper read the same settings, so `brain_check_routing`
predicts exactly what the router will do.

### Self-hosting the decisions model

Jev and Laya speak the same request and response shape on
`POST /v1/systemone`, so switching is a one-line change:

```json
{ "decisionsUrl": "http://my-server:8081" }
```

A decisions URL on the local network (localhost, `192.168.x.x`, `10.x`, a
bare host name, `*.local`) gets tight defaults: 500 ms per request and 1 s per
route. A remote URL gets 2 s and 3 s.

[host-laya](host-laya) is a reference deployment: a Jev-compatible FastAPI
service around a local Laya checkpoint, Dockerised for an Intel Arc GPU. It is
specific to that hardware and is not installed by `pi install`. Treat it as a
starting point. If it is reachable from other machines, start it with
`LAYA_API_KEY` and give clients the same key as `BRAIN_DECISIONS_API_KEY`.

## Writing the brain

**Note frontmatter is the source of truth, and every `_index.json` is a build
artifact.** A note describes itself; a folder describes itself in `_about.md`:

```markdown
---
id: asyncpg_pooling
title: asyncpg Connection Pooling
criteria: PostgreSQL connections, asyncpg pool sizing and lifespan setup, acquiring and releasing connections, PgBouncer transaction mode, statement cache errors
---
```

- `criteria` is what the decision model actually reads. Write 10–25 words that
  tell a note apart from its **siblings**; it is not a summary of the note.
- Keep each folder to **15 children or fewer**. Past that, each option gets too
  few tokens to describe itself.
- One root note carries `fallback: true`, the catch-all used when routing is
  unsure. A folder may have its own catch-all too: when routing reaches
  `Backend/` confidently and then hesitates, Backend's catch-all is used rather
  than the root's.

The keeper tools recompile the manifests after every write. If you edit in
Obsidian by hand, run `brain_rebuild` (or `brain-keeper rebuild`), or leave
`brain-keeper watch` running. Writes are atomic, and removed notes go to the
vault's `.trash/` rather than being deleted, but keeping the vault in git is
still the best undo.

## Repository layout

| Folder | What it is |
|---|---|
| [pi-traverser](pi-traverser) | The router: the Pi extension plus the `brain-traverse` CLI for tuning routes without launching Pi. |
| [brain-keeper](brain-keeper) | The authoring tools: Pi tools, the MCP server, the `brain-keeper` CLI and the two commands. |
| [brain-core](brain-core) | Shared by both: vault schema, frontmatter parser, compiler, traversal engine and decisions client. |
| [host-laya](host-laya) | Optional self-hosted decisions service (Python and Docker, hardware-specific). |
| [docs](docs) | The original [architecture plan](docs/architecture-plan.md) (each package README notes where the build deviates from it) and the [roadmap](docs/ROADMAP.md). |

The router reads `_index.json` manifests and the keeper writes them. Both
import the same schema, the same 15-child rule and the same frontmatter parser
from `brain-core`, so a manifest the keeper emits is one the router accepts. A
test asserts that recompiling the fixture vault produces no diff.

`brain-core` is imported by relative path, with no build step. The three
TypeScript folders must therefore stay side by side. The npm workspace at the
root only exists so that dependencies install in one place.

## Command-line tools

After `npm install` in a checkout, run them with `node`. After `npm link`,
they are also on your `PATH`.

```bash
node pi-traverser/bin/brain-traverse.mjs route "How do I size an asyncpg pool?" -v
node pi-traverser/bin/brain-traverse.mjs eval        # run routing regression evals
node pi-traverser/bin/brain-traverse.mjs health     # which backend, and is the key accepted?
node pi-traverser/bin/brain-traverse.mjs stats      # what gets injected, what never does, near ties, cache hits
node brain-keeper/bin/brain-keeper.mjs doctor       # vault health
node brain-keeper/bin/brain-keeper.mjs export --format cursor # export rules to .cursor/rules/
node brain-keeper/bin/brain-keeper.mjs search "pgbouncer"
node brain-keeper/bin/brain-keeper.mjs tree --criteria
```

## Development

```bash
npm install
npm test            # all three packages
npm run typecheck
npm run build       # bundle standalone dist/ CLIs with esbuild
```

```
brain-core     167   vault model, compiler, config, traversal, cache, evals, exporter
pi-traverser    51   the Pi extension, injection formatting, config, eval & route CLI
brain-keeper    84   operations, the 17-tool surface, Pi registration, export, MCP server
host-laya       22   the HTTP layer against a stub engine (pytest; no torch needed)
```

None of the tests need a GPU, a network or an API key. A mock decisions server
imitates both backends: host-laya's `/healthz`, and Jev's bearer-key checks.
host-laya's own scripts (`smoke_test.py`, `bench.py`, `parity_check.py`) need
the real service, and so does the opt-in live test:
`BRAIN_LIVE_URL=https://api.typesafe.ai TYPESAFE_API_KEY=sk-... npm test`.

```bash
cd host-laya && pip install -r requirements-test.txt && pytest
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the Node suites
on Linux and Windows, builds the `dist/` bundles, and runs the host-laya tests.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security
issues go through [SECURITY.md](SECURITY.md), not public issues. Release notes
are in [CHANGELOG.md](CHANGELOG.md), and planned work is in
[docs/ROADMAP.md](docs/ROADMAP.md).

## License

[MIT](LICENSE).
