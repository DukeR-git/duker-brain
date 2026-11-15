# duker-brain

[![CI](https://github.com/DukeR-git/duker-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/DukeR-git/duker-brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

Dynamic context routing for coding agents. Your knowledge lives in a
hierarchical Obsidian vault, "the brain". On every prompt, a fast decision
model walks that tree and adds only the note that applies, instead of one
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
          │  TypeSafe Jev            │   │   (the brain)    │
          └──────────────────────────┘   └────────┬─────────┘
                                                  ^ writes
                                         ┌────────┴─────────┐
            agent ──tools / MCP─────────>│  brain-keeper    │
                                         └──────────────────┘
```

- **Router**: a [Claude Code](https://code.claude.com) plugin hook and a
  [Pi](https://pi.dev) extension. It routes each prompt through the vault and
  adds the matching note to the conversation, or two notes when a prompt spans
  two topics. Other MCP clients call the same router as a tool, `brain_route`.
- **Keeper**: 18 `brain_*` tools for adding to, searching, maintaining,
  evaluating and exporting the brain ([the list](brain-keeper/README.md#3-the-tools)),
  plus commands to capture and research knowledge into it. They are native
  tools in Pi, and an MCP server for Claude Code, Codex, Cursor and any other
  MCP client.
- **Decision model**: picks the note at each step. The hosted
  [TypeSafe Jev](https://docs.typesafe.ai) API by default, which needs only an
  API key, or your own service with the same API. See
  [The decision model](#the-decision-model).
- **Starter brains**: ready-made notes you can add in one command, and a way to
  share your own brain through GitHub. See [Starter and shared brains](#starter-and-shared-brains).

The repository is `duker-brain`; its two command-line tools are
`brain-traverse` (the router) and `brain-keeper` (the authoring tools).

## Install

You need Node.js 22 or newer on your `PATH`, and a
[TypeSafe API key or a self-hosted decision model](#the-decision-model).

| Agent | How notes reach it | Setup |
|---|---|---|
| Claude Code | Automatically, on every prompt | [Plugin](#claude-code-plugin) |
| Pi | Automatically, on every prompt | [Package](#pi) |
| Codex, Cursor and other MCP clients | On request: the agent calls `brain_route` | [MCP server and skill](#codex-and-other-mcp-clients) |

### Claude Code (plugin)

Inside Claude Code:

```
/plugin marketplace add DukeR-git/duker-brain
/plugin install duker-brain@duker-brain
```

When you enable the plugin, it asks for three optional settings: the vault
folder, the decisions API key and the decisions API URL. For Jev, fill in the
key; for a self-hosted model, fill in the URL. Leave them empty to use
`TYPESAFE_API_KEY` and the config file instead. Then create a brain, here
starting from the Python backend starter, and check that routing works:

```
/duker-brain:init ~/brain --starter python-backend
/duker-brain:status
```

From then on every prompt is routed, and the matching note is added as context.
When a note goes in, Claude Code shows one line such as
`brain: asyncpg_pooling 0.93 53ms`; set `displayInjection` to `false` to hide
it. You also get the 18 `brain_*` tools and these commands:

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
export TYPESAFE_API_KEY=sk-...   # or, self-hosted: export BRAIN_DECISIONS_URL=http://my-server:8081
```

That installs the router, the 18 brain tools, and the `/brain`,
`/brain-init`, `/brain-add`, `/brain-update`, `/brain-capture`, `/brain-research`
and `/brain-export` commands. Then create a brain from inside Pi and reload:

```
/brain-init ~/brain --starter python-backend
/brain reload
```

`--starter` adds a [starter brain](#starter-and-shared-brains) so routing has
something to do straight away; `--example` adds a small sample tree instead.
Leave both out to start with just the catch-all note. `/brain status` shows
whether routing is live, and `/brain help` lists all in-session subcommands.

Pointing `/brain-init` at an existing Obsidian vault is safe: it never
overwrites a note (it does regenerate `_index.json` files, which are build
output). Add `--dry-run` to see what it would do first, and list folders that
are not knowledge (Templates, Attachments, Daily Notes) in the vault's
`.brainignore`. Run `brain_doctor` (or `brain-keeper doctor`) afterwards to see
what the notes still need.

### Codex and other MCP clients

Any MCP client gets the 18 tools. These clients have no prompt hook, so
routing is on request: the agent calls `brain_route` with the user's prompt and
gets the matching note back. The [duker-brain skill](skills/duker-brain/SKILL.md)
tells it when to do that, and how to write notes the router can find.

#### Without cloning

You also need git. Create a brain (or adopt an Obsidian vault you already
have) once, in a terminal:

```bash
npx -y --package=github:DukeR-git/duker-brain brain-keeper init ~/brain --starter python-backend
```

Then add the server to your client's MCP config, for example
`.cursor/mcp.json`. This is
[skills/duker-brain/mcp.json](skills/duker-brain/mcp.json):

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "--package=github:DukeR-git/duker-brain", "brain-keeper", "serve"],
      "env": {
        "BRAIN_VAULT_ROOT": "/absolute/path/to/your/vault",
        "TYPESAFE_API_KEY": "<your key from console.typesafe.ai/keys>"
      }
    }
  }
}
```

- `npx` fetches the repository and runs the prebuilt bundle from [dist](dist).
  The first run takes a while. Running `init` first warms the cache, so the
  client does not time out waiting for the server.
- `BRAIN_VAULT_ROOT` can be left out when `init` saved the vault. The key can
  be left out when `BRAIN_DECISIONS_URL` points at a self-hosted service that
  does not check one.
- The file name, and in some clients the top-level key, differ; the `brain`
  entry is the same everywhere.
- On Windows, clients that cannot launch `npx` directly need
  `"command": "cmd"` and `"args": ["/c", "npx", "-y", …]`.

Last, copy the [skills/duker-brain](skills/duker-brain) folder to wherever your
agent reads skills from.

#### From a checkout

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
with `claude mcp add brain --scope user`. `setup` also says where to copy the
two command files; see [brain-keeper/commands](brain-keeper/commands/README.md).

Already using Pi? The package is cloned at
`~/.pi/agent/git/github.com/DukeR-git/duker-brain`, so you can point the MCP
commands there instead of cloning again.

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
`brain-keeper watch` running. `brain_doctor` lists what breaks these rules, and
`brain_check_routing` shows where a prompt lands. Writes are atomic, and
removed notes go to the vault's `.trash/` rather than being deleted, but
keeping the vault in git is still the best undo.

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

## The decision model

At each folder of the brain, a decision model reads the prompt and the
`criteria` of the notes and subfolders there, and picks one. Use either:

- **TypeSafe Jev** (the default): the hosted [Jev](https://docs.typesafe.ai)
  API. All it needs is an API key from
  [console.typesafe.ai/keys](https://console.typesafe.ai/keys). In Claude Code,
  put it in the plugin's *Decisions API key* setting (Claude Code asks for it
  when you enable the plugin and keeps it in your system's credential store);
  anywhere else, set the `TYPESAFE_API_KEY` environment variable.
- **A self-hosted model**: any service that answers the same API as Jev
  (`POST /v1/systemone`, and `GET /v1/models` for the health check). Set its
  address as the plugin's *Decisions API URL*, or as `decisionsUrl` in
  `~/.config/brain-traverse/config.json` (or `BRAIN_DECISIONS_URL`), for
  example `http://my-server:8081`. No API key is needed; if your service checks
  one, give it as the API key setting or `BRAIN_DECISIONS_API_KEY`.

**What leaves your machine:** each prompt, cut to 1,500 characters
(`maxPromptChars`), and the `criteria` of the notes being chosen between, sent
to Jev or to your own service. The notes' contents are never sent.

Each step is one request, capped at 2 s, and a whole prompt at 3 s. If the
service is slow or unreachable, the prompt goes ahead without a note: routing
pauses and retries later, and never blocks your agent.

To check the key and see what the last prompt routed to, run
`/duker-brain:status` in Claude Code, `/brain status` in Pi, or
`brain-traverse health`.

## Configuration

One config serves the router, the keeper and the CLIs. Settings are read in
this order, and later sources win:

1. `~/.config/brain-traverse/config.json`: per user. `init` writes `vaultRoot` here.
2. `./brain-traverse.config.json`, or the file named by `$BRAIN_CONFIG`: per project.
   Because a project file arrives with any repository you clone, it may not set
   `decisionsUrl`, `decisionsPath`, `apiKey` or `routeLog`; those are ignored
   with a warning (a `$BRAIN_CONFIG` file may set them).
3. `BRAIN_*` environment variables.

The settings you are most likely to touch:

| Key | Env | Default | |
|---|---|---|---|
| `vaultRoot` | `BRAIN_VAULT_ROOT` | none | The brain. `~` is expanded. |
| `apiKey` | `TYPESAFE_API_KEY` or `BRAIN_DECISIONS_API_KEY` | none | Required for Jev; a self-hosted service needs one only if it checks it. Prefer the env var to keeping it in a file. |
| `decisionsUrl` | `BRAIN_DECISIONS_URL` | `https://api.typesafe.ai` | Or a self-hosted service with the same API, e.g. `http://my-server:8081`. |
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

## Command-line tools

After `npm install` in a checkout, run them with `node`. After `npm link`,
they are also on your `PATH`. Without a checkout,
`npx -y --package=github:DukeR-git/duker-brain brain-keeper doctor` runs the
same commands.

```bash
node pi-traverser/bin/brain-traverse.mjs route "How do I size an asyncpg pool?" -v
node pi-traverser/bin/brain-traverse.mjs eval        # run routing regression evals
node pi-traverser/bin/brain-traverse.mjs health      # does the decisions API answer, and is the key accepted?
node pi-traverser/bin/brain-traverse.mjs stats       # what gets injected, what never does, near ties, cache hits
node brain-keeper/bin/brain-keeper.mjs doctor        # vault health
node brain-keeper/bin/brain-keeper.mjs add python-backend     # add a starter or shared brain
node brain-keeper/bin/brain-keeper.mjs update        # update the brains you added
node brain-keeper/bin/brain-keeper.mjs export --format cursor # export rules to .cursor/rules/
node brain-keeper/bin/brain-keeper.mjs search "pgbouncer"
node brain-keeper/bin/brain-keeper.mjs tree --criteria
```

## Repository layout

| Folder | What it is |
|---|---|
| [pi-traverser](pi-traverser) | The router: the Pi extension, the Claude Code hook, and the `brain-traverse` CLI for tuning routes without launching an agent. |
| [brain-keeper](brain-keeper) | The authoring tools: Pi tools, the MCP server, the `brain-keeper` CLI and the two commands. |
| [brain-core](brain-core) | Shared by both: vault schema, frontmatter parser, compiler, traversal engine and decisions client. |
| [.claude-plugin](.claude-plugin), [claude-plugin](claude-plugin) | The Claude Code plugin and marketplace manifests, and the plugin's own commands. |
| [skills](skills) | The agent skill and the `mcp.json` for other MCP clients. |
| [brains](brains) | The starter brains, and how to share your own. |
| [dist](dist) | Self-contained bundles of the CLIs and the hook, built by `npm run build` and committed, because the plugin and `npx` run them without an install. |
| [docs](docs) | The [roadmap](docs/ROADMAP.md). |

The router reads `_index.json` manifests and the keeper writes them. Both
import the same schema, the same 15-child rule and the same frontmatter parser
from `brain-core`, so a manifest the keeper emits is one the router accepts. A
test asserts that recompiling the fixture vault produces no diff.

`brain-core` is imported by relative path, with no build step. The three
TypeScript folders must therefore stay side by side. The npm workspace at the
root only exists so that dependencies install in one place.

## Development

```bash
npm install
npm test            # all three packages
npm run typecheck
npm run build       # rebuild the self-contained dist/ bundles (commit the result)
```

None of the tests need a network or an API key: a mock server imitates Jev,
bearer-key checks included. The opt-in live test talks to the real API:
`BRAIN_LIVE_URL=https://api.typesafe.ai TYPESAFE_API_KEY=sk-... npm test`.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the suites on
Linux and Windows and checks that the committed `dist/` bundles are up to date.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security
issues go through [SECURITY.md](SECURITY.md), not public issues. Release notes
are in [CHANGELOG.md](CHANGELOG.md), and planned work is in
[docs/ROADMAP.md](docs/ROADMAP.md).

## License

[MIT](LICENSE).
