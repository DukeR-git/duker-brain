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
                 ┌─────────────────────────────────────────┐
  prompt ───────>│ router (Pi extension / Claude Code hook)│
                 │   gate + hop 1 ──> hop 2 ──> leaf .md   │──> injected as context
                 └──────┬───────────────────────┬──────────┘
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

- **Router**: a [Claude Code](https://code.claude.com) plugin hook and a [Pi](https://pi.dev)
  extension. It routes each prompt through the vault and adds the matching note
  to the conversation. Supports parallel composite
  routing for cross-cutting queries under a unified context budget.
- **Keeper**: 17 `brain_*` tools for adding to, searching, maintaining, evaluating and
  exporting the brain, plus commands to capture and research knowledge into it. They
  are native tools in Pi, and an MCP server for Claude Code, Codex and any other MCP client.
- **Decision model**: picks the note at each step. Either the hosted
  [TypeSafe Jev](https://docs.typesafe.ai) API, which needs only an API key, or
  [Laya](https://pypi.org/project/laya/), an open model you run on your own
  machine. See [Choose a decision model](#choose-a-decision-model).
- **Starter brains**: ready-made notes you can add in one command, and a way to
  share your own brain through GitHub. See [Starter and shared brains](#starter-and-shared-brains).

---

## Choose a decision model

At each folder of the brain, a decision model reads the prompt and the
`criteria` of the notes and subfolders there, and picks one. You can use either
of two models. They answer the same API, so you can switch later by changing
one setting.

| | **TypeSafe Jev** (hosted, the default) | **Laya** (local, self-hosted) |
|---|---|---|
| What it is | TypeSafe's hosted decisions API | The open [Laya](https://pypi.org/project/laya/) model on your own hardware, served by [host-laya](host-laya) |
| What you need | An API key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys) | A Linux machine with Docker. The packaged image targets an Intel Arc GPU (about 1.7 GB of VRAM) |
| Cost | [TypeSafe's pricing](https://docs.typesafe.ai) | Your own hardware |
| What leaves your machine | Each prompt, cut to 1,500 characters (`maxPromptChars`), and the `criteria` of the notes being chosen between. The notes' contents are never sent | Nothing, when the host is on your own network |
| Speed | A network round trip per step, capped at 2 s per request and 3 s per prompt | About 35 ms per step on a local network, capped at 0.5 s and 1 s |
| To set up | Add the key. Nothing to run | Run host-laya, then point `decisionsUrl` at it |

If the model is slow or unreachable, the prompt goes ahead without a note:
routing pauses and retries later, and it never blocks your agent.

### Use TypeSafe Jev

Get a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys) and
give it to duker-brain in one of these ways:

- **Claude Code:** the plugin's *Decisions API key* setting. Claude Code asks for
  it when you enable the plugin and keeps it in your system's credential store.
- **Anywhere:** the `TYPESAFE_API_KEY` environment variable.

Leave the decisions URL empty: Jev is the default.

### Use a local Laya model

1. **Start the decisions service** on a machine you control.
   [host-laya](host-laya) is the reference deployment: a Docker image for Ubuntu
   with an Intel Arc GPU, which you start with `docker compose up -d`. Laya
   itself also runs on NVIDIA GPUs (CUDA) and on the CPU (`LAYA_DEVICE=cuda` or
   `cpu`), but only the Intel Arc image is packaged today, so on other hardware
   you adapt its Dockerfile. On a CPU, expect about 200 ms per decision.
2. **Point duker-brain at it.** In Claude Code, set the plugin's *Decisions API
   URL* to the service, for example `http://my-server:8081`. Anywhere else, put
   `"decisionsUrl": "http://my-server:8081"` in
   `~/.config/brain-traverse/config.json`, or set `BRAIN_DECISIONS_URL`.
3. **No API key is needed,** unless you started host-laya with `LAYA_API_KEY`.
   Do that whenever the service is reachable from other machines, and give
   duker-brain the same value as its API key (the plugin setting, or
   `BRAIN_DECISIONS_API_KEY`).

To see which model is in use and whether it answers, run `/duker-brain:status`
in Claude Code, `/brain status` in Pi, or `brain-traverse health`.

---

## Install

You need Node.js 22 or newer on your `PATH`, and a decision model:
[a TypeSafe API key, or a local Laya service](#choose-a-decision-model).

### Claude Code (plugin)

Inside Claude Code:

```
/plugin marketplace add DukeR-git/duker-brain
/plugin install duker-brain@duker-brain
```

When you enable the plugin, it asks for three optional settings: the vault
folder, the decisions API key and the decisions API URL. For TypeSafe Jev, fill
in the key; for a local Laya, fill in the URL (see
[Choose a decision model](#choose-a-decision-model)). Leave them empty to use
`TYPESAFE_API_KEY` and the config file instead. Then create a brain, here
starting from the Python backend starter, and check that routing works:

```
/duker-brain:init ~/brain --starter python-backend
/duker-brain:status
```

From then on every prompt is routed, and the matching note is added as context.
When a note goes in, Claude Code shows one line such as
`brain: asyncpg_pooling 0.93 53ms`; set `displayInjection` to `false` to hide
it. You also get the 17 `brain_*` tools and these commands:

| Command | What it does |
|---|---|
| `/duker-brain:init <dir> [--starter <name>]` | Create a brain, or adopt an existing Obsidian vault, and make it the default |
| `/duker-brain:status` | Settings, service health and what the last prompt routed to |
| `/duker-brain:add <source>` | Add a starter brain or someone's shared brain as its own folder |
| `/duker-brain:update [folder]` | Pull new and changed notes into the brains you added, keeping your edits |
| `/duker-brain:capture` | File what is worth keeping from this session into the brain |
| `/duker-brain:research <topic>` | Research a topic and write it up as a note |

The plugin runs prebuilt bundles from [dist](dist), so nothing is installed
besides the plugin itself. Its state (which notes each conversation already
holds) lives in Claude Code's plugin data folder. After `/compact` or `/clear`,
the next prompt gets the full note again.

### Pi

```bash
pi install git:github.com/DukeR-git/duker-brain
export TYPESAFE_API_KEY=sk-...   # for TypeSafe Jev; for a local Laya, set decisionsUrl instead
```

That installs the router, the 17 brain tools, and the `/brain`,
`/brain-init`, `/brain-add`, `/brain-update`, `/brain-capture`, `/brain-research`
and `/brain-export` commands. Then create a brain from inside Pi and reload:

```
/brain-init ~/brain --starter python-backend
/brain reload
```

`--starter` adds a [starter brain](#starter-and-shared-brains) so routing has
something to do straight away; `--example` adds a small sample tree instead.
Leave both out to start with just the catch-all note. `/brain status` shows whether routing is live, and `/brain help`
lists all in-session subcommands.

Pointing `/brain-init` at an existing Obsidian vault is safe: it never
overwrites a note (it does regenerate `_index.json` files, which are build
output). Add `--dry-run` to see what it would do first, and list folders that
are not knowledge (Templates, Attachments, Daily Notes) in the vault's
`.brainignore`. Run `brain_doctor` (or `brain-keeper doctor`) afterwards to see
what the notes still need.

### Codex and other MCP clients

These harnesses get the keeper: the tools and the two commands. Automatic
routing on every prompt is available for Claude Code (above) and Pi.

```bash
git clone https://github.com/DukeR-git/duker-brain
cd duker-brain
npm install
node brain-keeper/bin/brain-keeper.mjs init ~/brain --starter python-backend
node brain-keeper/bin/brain-keeper.mjs setup
```

`setup` prints the exact commands for this checkout, for example:

```bash
codex mcp add brain -- node /path/to/duker-brain/brain-keeper/bin/brain-keeper.mjs serve
```

To give Claude Code only the tools, without routing, use the same command
with `claude mcp add brain --scope user`.

It also says where to copy the two command files. See
[brain-keeper/commands](brain-keeper/commands/README.md).

Already using Pi? The package is cloned at
`~/.pi/agent/git/github.com/DukeR-git/duker-brain`, so you can point the MCP
commands there instead of cloning again.

## Starter and shared brains

You do not have to start from an empty brain. A **starter brain** is a
ready-made set of notes, with routing criteria and evals, that goes into your
brain as one folder:

```bash
brain-keeper starters                 # what is available
brain-keeper add python-backend       # add one to the brain you have
brain-keeper init ~/brain --starter python-backend   # or start a new brain with it
```

| Starter | What it covers |
|---|---|
| [python-backend](brains/python-backend) | FastAPI, asyncio, SQLAlchemy 2.0 and PostgreSQL, Alembic, pytest, uv |

**Anyone's brain on GitHub works the same way**, so a team can keep its
knowledge in one repository and everyone adds it:

```bash
brain-keeper add your-org/team-brain            # a whole repository
brain-keeper add your-org/monorepo/brains/go    # one folder in it
brain-keeper add your-org/team-brain#v2         # at a tag or branch
```

`brain-keeper update` later pulls in new and changed notes. A note you edited
is kept, and the update tells you it also changed upstream. Only Markdown notes
and `evals.json` are copied, never scripts, but the notes do reach your coding
agent as context, so only add brains from sources you trust.

In Claude Code these are `/duker-brain:add` and `/duker-brain:update`, and in
Pi `/brain-add` and `/brain-update`. To publish your own brain, and for the
details of how updates work, see [brains/README.md](brains/README.md).

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

### Timeouts

Jev and Laya answer the same request on `POST /v1/systemone`, so only
`decisionsUrl` (and the key) differ between them; see
[Choose a decision model](#choose-a-decision-model). A decisions URL on the
local network (localhost, `192.168.x.x`, `10.x`, a bare host name, `*.local`)
gets tight defaults: 500 ms per request and 1 s per route. A remote URL gets
2 s and 3 s. Set `timeoutMs` and `routeBudgetMs` to override them.
[host-laya](host-laya) is not installed by `pi install` or the Claude Code
plugin; it runs on the machine that has the GPU.

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
| [pi-traverser](pi-traverser) | The router: the Pi extension, the Claude Code hook, and the `brain-traverse` CLI for tuning routes without launching an agent. |
| [.claude-plugin](.claude-plugin), [claude-plugin](claude-plugin) | The Claude Code plugin and marketplace manifests, and the plugin's own commands. |
| [brains](brains) | The starter brains, and how to share your own. |
| [dist](dist) | Self-contained bundles of the CLIs and the hook, built by `npm run build` and committed, because the plugin runs them without an install. |
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
node brain-keeper/bin/brain-keeper.mjs add python-backend  # add a starter or shared brain
node brain-keeper/bin/brain-keeper.mjs update       # update the brains you added
node brain-keeper/bin/brain-keeper.mjs export --format cursor # export rules to .cursor/rules/
node brain-keeper/bin/brain-keeper.mjs search "pgbouncer"
node brain-keeper/bin/brain-keeper.mjs tree --criteria
```

## Development

```bash
npm install
npm test            # all three packages
npm run typecheck
npm run build       # rebuild the self-contained dist/ bundles (commit the result)
```

```
brain-core     171   vault model, compiler, config, traversal, cache, evals, exporter
pi-traverser    71   the Pi extension, the Claude Code hook, injection formatting, config, CLI
brain-keeper   109   operations, the 17-tool surface, shared brains, Pi registration, MCP server
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
