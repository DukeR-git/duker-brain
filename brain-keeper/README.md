# brain-keeper — adding to, maintaining and improving the brain

Tools that let your coding agent **write** to the brain, plus two commands for
the judgement-heavy parts. One implementation, two front doors: native tools in
**Pi** (installed by `pi install`), and an MCP server for **Claude Code, Codex**
and any other MCP client.

This is Part 3, reshaped from the plan's "vault compiler + Obsidian workflow"
into something you drive from inside an agent. The compiler is still here; it
just runs automatically after every write instead of being a build step you
remember to run.

```
agent ──tools / MCP──> brain-keeper ──> Obsidian vault (.md + _about.md)
                    │                  │
                    │            frontmatter is the source of truth
                    └── recompiles ──> _index.json  ──read by──> pi-traverser
```

---

## 1. Install

### Pi

Nothing extra: `pi install git:github.com/DukeR-git/duker-brain` (see the
[root README](../README.md#pi)) registers all 17 tools natively, along with
`/brain-capture`, `/brain-research`, `/brain-export` and `/brain-init`. `/brain-init ~/brain`
creates a vault and makes it the default; `--dry-run` previews it.

### Claude Code, Codex and other MCP clients

From a checkout of the repository:

```bash
npm install                                            # at the repository root
node brain-keeper/bin/brain-keeper.mjs init ~/brain    # add --example for a sample tree
node brain-keeper/bin/brain-keeper.mjs setup           # prints the commands below, with real paths
```

`init` creates the vault if needed, writes a catch-all note and a
`.brainignore`, compiles the manifests, and saves `vaultRoot` to
`~/.config/brain-traverse/config.json`. The MCP server reads that file, so the
vault needs no environment variable. It never overwrites a note, so it is also
how you adopt an Obsidian vault you already have — though it does write an
`_index.json` (build output) into every folder it treats as part of the brain.
Run `init <dir> --dry-run` first to see which, and list folders that are not
knowledge (Templates, Attachments, Daily Notes) in `.brainignore`. `doctor`
then tells you which folders still need an `_about.md`.

Try the tools without an agent:

```bash
node brain-keeper/bin/brain-keeper.mjs doctor
node brain-keeper/bin/brain-keeper.mjs tree --criteria
```

## 2. Connect it to your harness

The server runs on stdio: `node <repo>/brain-keeper/bin/brain-keeper.mjs serve`.
The `.mjs` launcher registers `tsx`, so it works from any working directory.
Only the config format differs between harnesses.

**Claude Code:**

```bash
claude mcp add brain --scope user -e TYPESAFE_API_KEY=sk-... -- node /path/to/duker-brain/brain-keeper/bin/brain-keeper.mjs serve
```

(The key is only needed by `brain_check_routing`, and only against Jev.)

Or in `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/duker-brain/brain-keeper/bin/brain-keeper.mjs", "serve"]
    }
  }
}
```

**Codex:**

```bash
codex mcp add brain -- node /path/to/duker-brain/brain-keeper/bin/brain-keeper.mjs serve
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.brain]
command = "node"
args = ["/path/to/duker-brain/brain-keeper/bin/brain-keeper.mjs", "serve"]
```

To use a vault other than the one `init` saved, add
`"env": { "BRAIN_VAULT_ROOT": "/path/to/vault" }`. `brain_check_routing` also
needs `TYPESAFE_API_KEY` in the server's environment when you route through Jev
(or `BRAIN_DECISIONS_API_KEY` for a Laya host started with `LAYA_API_KEY`).

The server reads its config on the first tool call, and again while no vault is
configured, so running `brain-keeper init` after the harness started it just
works. A broken config file does not stop the server from starting: every tool
call reports the problem instead, which the model can relay.

Then install the commands; see [commands/README.md](commands/README.md).

## 3. The tools
 
Eleven write, six read. Descriptions are written for the model that has to decide
which one to call. Over MCP each tool also carries annotations — read-only,
destructive, idempotent, open-world — so a harness can auto-approve the reads
and ask before a removal.

| Tool | | What it does |
|---|---|---|
| `brain_tree` | r | Structure, child counts, which folders are over the routing limit |
| `brain_get_note` | r | One note (or a folder's `_about.md`): frontmatter and body. Markdown only. |
| `brain_search` | r | Keyword search over titles, criteria and bodies — "is this already in the brain?" |
| `brain_doctor` | r | Health report — every problem with the action that fixes it |
| `brain_check_routing` | r | Where do these prompts actually land, with the router's own settings? |
| `brain_eval` | r | Run routing regression evals against the vault with accuracy & latency metrics |
| `brain_export` | w | Export vault rules to Cursor (.cursor/rules/*.mdc), Windsurf, Aider, or bundle |
| `brain_add_note` | w | Capture a new note |
| `brain_update_note` | w | Retitle, rewrite criteria, replace or append to the body |
| `brain_move_note` | w | Refile a note that is in the wrong place |
| `brain_remove_note` | d | Move a note to `.trash/` |
| `brain_add_branch` | w | New folder with its `_about.md` |
| `brain_update_branch` | w | Change a folder's criteria or description |
| `brain_move_branch` | w | Move a folder under another parent, rename it, or change its id |
| `brain_remove_branch` | d | Move a folder and its notes to `.trash/` |
| `brain_split_branch` | w | Fix an over-full folder in one step |
| `brain_rebuild` | w | Recompile manifests after editing the vault by hand |

(r = read-only, w = writes, d = removes, to the vault's `.trash/`.)

Every write returns a diff: files touched, manifests regenerated, warnings, and
the vault's error count afterwards.

```
Added Backend/redis_caching.md

Files:
  created  Backend/redis_caching.md  (Redis Caching)

Manifests rebuilt:
  written   Backend/_index.json  (5 entries)
```

## 4. The commands

Two prompt files in [commands/](commands/), installable in all three harnesses.

**`/brain-capture`** — reviews the session and files what is worth keeping. Most
of it is about what *not* to keep: it is told to check for existing coverage
first, to propose before writing, and that capturing nothing is a valid outcome.

**`/brain-research <topic>`** — researches a topic on the web or in docs and
writes it up as a clean note, grounded in sources it actually read, with a
`## Sources` section. Told explicitly to stop rather than fill a gap from memory.

Both end the same way: `brain_check_routing` to prove the note is reachable, then
`brain_doctor`.

These are prompts rather than code because deciding what is worth keeping, and
how to phrase criteria that discriminate, is judgement. The mechanical half —
writing the file, keeping the index consistent, checking routing — is the tools.

## 5. The authoring model

**Note frontmatter is the source of truth. Every `_index.json` is a build
artifact.** Nothing hand-edits a manifest; the next compile would overwrite it.

A **leaf** describes itself in its own frontmatter:

```markdown
---
id: asyncpg_pooling
title: asyncpg Connection Pooling
criteria: PostgreSQL connections, asyncpg pool sizing, PgBouncer transaction mode, statement cache errors
---

# asyncpg Connection Pooling
...
```

A **branch** describes itself in `_about.md`, same shape. It sorts first in
Obsidian and is never mistaken for a note.

Unknown frontmatter keys — `tags`, `aliases`, anything a plugin wrote — are
preserved verbatim through every write. The keeper owns four keys and leaves the
rest alone.

### Writing criteria

This is the part that decides whether a note is ever found again. 10–25 words of
trigger terms and intents, written to discriminate against the note's *siblings*,
not to summarise its contents.

- weak: `things about databases`
- strong: `PostgreSQL connection pooling, asyncpg pool sizing, PgBouncer transaction mode, statement cache errors`

`brain_doctor` flags criteria under 4 words, over 40 words, and siblings whose
criteria are identical — that last one is the failure that makes routing
unpredictable, because the model genuinely cannot tell them apart.

## 6. What `brain_doctor` checks

| Code | Severity | Meaning |
|---|---|---|
| `too-many-children` | error | Over 15 children; the option-token budget cannot describe them all |
| `missing-criteria` | error | A note or `_about.md` with no `criteria` |
| `missing-about` | error | A folder with no `_about.md` |
| `duplicate-id` | error | Two children of one folder share a routing label |
| `empty-branch` | error | A folder with nothing in it; no manifest can be written |
| `duplicate-criteria` | warning | Siblings the model cannot tell apart |
| `thin-criteria` / `verbose-criteria` | warning | Under 4 words / over 40 |
| `empty-body` | warning | A note that would inject nothing |
| `no-fallback` / `multiple-fallbacks` | warning | No catch-all at the root / several in one folder |
| `hashed-id` | warning | A name with no Latin letters or digits, so its label is an unreadable `id_ab12cd34`; add an `id:` |
| `bad-frontmatter` | warning | Frontmatter the parser had to guess at: a key set twice, an unclosed block, a non-boolean `fallback` |
| `too-deep` | warning | A folder the router cannot reach within `maxHops`, or nested too deep to scan |
| `non-slug-id` | info | An `id:` like `My Note` is used as the label `my_note` |

The compiler never writes a manifest the router would reject: with a
`duplicate-id`, the first note keeps the label and the rest are left out (and
reported) rather than taking the whole folder offline, and a folder with
nothing to route to is left out of its parent's manifest.

It also reports **stale manifests** — a dry-run compile that would change
something means the notes on disk no longer match the compiled index, which is
the most likely way a hand-edited vault stops routing correctly.

## 7. Configuration

The keeper uses the router's own config loader (it lives in brain-core): the
same `BRAIN_*` variables and the same files
(`~/.config/brain-traverse/config.json`, then `./brain-traverse.config.json`).
That is what makes `brain_check_routing` trustworthy — it routes with your
`minConfidence`, `maxHops` and `maxPromptChars`, not with defaults. See the
[full reference](../pi-traverser/README.md#6-configuration). The settings the
keeper itself cares about:

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_VAULT_ROOT` | — | Vault root. Required; `init` saves it for you. |
| `BRAIN_DECISIONS_URL` | `https://api.typesafe.ai` | Only used by `brain_check_routing`. |
| `TYPESAFE_API_KEY` / `BRAIN_DECISIONS_API_KEY` | — | Needed by `brain_check_routing` against Jev, or a keyed Laya host. |
| `BRAIN_MAX_HOPS` | `4` | Also used by the doctor's `too-deep` check. |
| `BRAIN_LOG_LEVEL` | `info` | Diagnostics go to stderr — stdout is the JSON-RPC stream. |

An unknown or ill-typed setting is ignored with a warning on stderr, never
silently.

## 8. Safety

Writes are **direct**: a tool call changes the vault and reports the diff. Your
harness shows you every tool call before it runs; that is the approval step,
and the MCP annotations mark the two removal tools as destructive so a harness
can insist on it. Keeping the vault in git is still the best undo.

What makes a write safe:

- **atomic** — every file is written to a temp file and renamed into place, so
  the router, Obsidian or a crash never sees half a note or half a manifest
- **one at a time** — each operation holds a lock on the vault (`.brain.lock`),
  so the MCP server, Pi's tools, the CLI and `watch` cannot interleave
- **recoverable** — "remove" moves notes and folders to the vault's `.trash/`,
  where Obsidian keeps its own deleted files; moving them back restores them
- **all or nothing** — a split validates everything first and moves the notes
  back if a move fails part-way

What the keeper will not do:

- write outside the vault root — every caller-supplied path is checked, so a
  `../..` (or, on Windows, a path on another drive) is refused rather than followed
- read anything but markdown — `brain_get_note` will not hand out `.obsidian/`
  settings, where plugins keep API tokens
- overwrite a note without `overwrite: true`
- mark a second catch-all note in one folder
- make a folder the scanner cannot see (`.NET` becomes `NET`)
- edit `_index.json` directly, or treat `_about.md` as a note
- move every child out of a folder, or split fewer than two notes
- remove anything you did not name

`brain_add_note` **warns** rather than refuses when a folder goes over 15
children. Refusing would block legitimate capture at the worst moment; the
warning names `brain_split_branch` as the fix.

## 9. Tests

```bash
npm test        # 82 tests, no GPU and no network
npm run typecheck
```

Covers every operation against a throwaway copy of the fixture vault — including
that a split leaves the brain healthy, that unknown frontmatter survives an
update, that a rename keeps the frontmatter id in step with the filename, that
removals go to `.trash/`, that a held lock is respected, and that path escapes
are refused. The tool suite drives tools by name with raw JSON, the way an MCP
client does, and checks that `brain_check_routing` honours a tuned
`minConfidence`. A third suite covers the Pi registration (every zod schema
becomes plain JSON Schema, and tool errors surface as Pi tool failures),
`/brain-init`, and `init`'s promise never to overwrite a note.

`test/server.test.ts` speaks raw JSON-RPC to `brain-keeper serve` over stdio:
`initialize`, `tools/list` (15 tools, with their annotations), and a tool call
against a broken config file. It also runs the CLI as a real process.

## 10. Layout

```
brain-keeper/
├── pi.ts                Pi extension: the tools as native Pi tools, plus /brain-init
├── src/
│   ├── server.ts        MCP stdio server
│   ├── tools.ts         the 15 tool definitions, zod schemas, descriptions and annotations
│   ├── operations.ts    every vault mutation (locked, atomic, recompiled), and search
│   ├── init.ts          create or adopt a vault, save it to the user config
│   ├── report.ts        tree, issue and diff rendering
│   ├── routing.ts       brain_check_routing, via brain-core's real traverser
│   └── config.ts        brain-core's shared config, plus the lazy loader the server uses
├── bin/
│   ├── brain-keeper.mjs launcher: registers tsx, runs the CLI
│   └── brain-keeper.ts  serve, init, setup, watch, and a CLI over the same tools
├── commands/            /brain-capture and /brain-research, plus install notes
└── test/
```

## 11. Where this deviates from the plan

| Plan says | What was built | Why |
|---|---|---|
| A standalone `compile_brain.py` you run after editing | The compiler runs after every write, and `brain_rebuild` covers hand edits | A build step you have to remember is a build step you forget; a stale manifest breaks routing silently |
| Obsidian Templater scaffolds frontmatter | `brain_add_note` writes it | The agent is already the thing adding notes |
| A file-watcher daemon | `brain-keeper watch`, optional | Every tool write recompiles anyway; the watcher is for editing by hand in Obsidian |
| MCP for every harness | Native tools in Pi, MCP elsewhere | Pi has no built-in MCP client; registering the same definitions directly makes `pi install` the whole setup |
| Folder metadata in "an optional folder-note or `_about.md`" | `_about.md`, required | "Optional" means the router gets only a folder name to discriminate on |
| Validation raises a blocking error over 15 children | `doctor` errors, `add_note` warns and points at `split_branch` | Blocking a capture mid-session is the wrong moment to enforce structure |
| — | `brain_check_routing` | Not in the plan, and the most useful tool here: it closes the loop between editing criteria and knowing whether it worked |

## 12. Related

- [../host-laya](../host-laya) — optional self-hosted decisions service (Part 1)
- [../pi-traverser](../pi-traverser) — the router that reads what this writes (Part 2)
- [../brain-core](../brain-core) — the shared vault model both depend on
