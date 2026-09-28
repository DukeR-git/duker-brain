# Shared brains

A shared brain is a ready-made set of notes you add to your own brain as one
folder. You can start from one of the starter brains here, add anyone's brain
from GitHub, and publish your own the same way.

## Starter brains

| Name | What it covers | Notes |
|---|---|---|
| [python-backend](python-backend) | FastAPI, asyncio, SQLAlchemy 2.0 and PostgreSQL, Alembic, pytest, uv | 10 |

Add one to a new brain:

```bash
brain-keeper init ~/brain --starter python-backend
```

or to the brain you already have:

```bash
brain-keeper add python-backend
```

In Claude Code the same commands are `/duker-brain:init ~/brain --starter python-backend`
and `/duker-brain:add python-backend`. In Pi they are `/brain-init … --starter`
and `/brain-add`.

## Adding a brain from GitHub

```bash
brain-keeper add someone/their-brain                  # a whole repository
brain-keeper add someone/monorepo/brains/go           # one folder in it
brain-keeper add someone/their-brain#v2               # at a tag or branch
brain-keeper add https://github.com/someone/their-brain
brain-keeper add https://gitlab.com/someone/brain.git # any git host
```

The brain goes into its own top-level folder (its name, or `--as <folder>`),
and the vault's `.brain-sources.json` records where it came from and a hash of
every file it brought. `git` must be installed.

Later, `brain-keeper update` (or `update <folder>`) pulls in what changed:

- a new note is added
- a note you have not touched is replaced with the new version
- a note you **edited** is kept, and the update tells you it also changed upstream
- a note you deleted stays deleted, and one removed upstream stays in place

The brain's routing evals are merged into your `evals.json` with ids prefixed by
its folder (`python-backend/jwt`), so `brain-traverse eval` checks them too.

**Only add brains from sources you trust.** Only Markdown notes and
`evals.json` are copied, so a brain cannot bring scripts or settings. But its
notes are given to your coding agent as context whenever a prompt routes to
them, so read what they say.

## Publishing your own

Any folder of notes in a git repository works. It needs:

- **`_about.md`** at its root, with `criteria` saying what the whole brain is
  about. This is what routing reads to decide whether a prompt belongs in your
  brain at all, next to the other folders in someone's vault.
- **Notes** with `id`, `title` and `criteria` frontmatter, at most 15 entries
  per folder, as in any brain ([Writing the brain](../README.md#writing-the-brain)).
- **Distinctive ids.** Your notes sit next to other people's, and note ids must
  be unique across a vault, so prefix them (`py_`, `go_`, `k8s_`).
- **A catch-all** (`fallback: true`) for when routing reaches your brain but no
  note fits. Optional, but recommended.

And optionally:

- **`brain.json`**: `name` (the default folder, lower case with dashes), `title`,
  `description`, `version`, `author`, `license`, `homepage`.
- **`evals.json`**: sample prompts and the note each should reach, in the
  [eval format](../README.md#command-line-tools). They prove your criteria
  route, and they travel with the brain.

`README`, `LICENSE`, `CHANGELOG` and other files at the root, `_index.json`
manifests, and hidden files and folders are not copied, so a normal repository
layout is fine. Tag your repository with the GitHub topic `duker-brain` so
others can find it.

Before publishing, add it to a scratch vault and check it:

```bash
brain-keeper init /tmp/scratch --no-config
brain-keeper add ./path/to/your/repo --vault /tmp/scratch   # or file:///… for a local repository
brain-keeper doctor --vault /tmp/scratch
brain-traverse eval --vault /tmp/scratch
```

## Contributing a starter brain

Starter brains live in this folder and are reviewed like code. Open an issue
first with the topic and a list of the notes you plan, then a pull request
that adds `brains/<name>/` with `brain.json`, `_about.md`, the notes and an
`evals.json`. CI checks that every starter adds cleanly to an empty vault and
that its evals point at notes that exist.
