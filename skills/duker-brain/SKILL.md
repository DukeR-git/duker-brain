---
name: duker-brain
description: Use the duker-brain MCP server (brain_* tools) as project memory kept in an Obsidian vault. Use before answering any project- or domain-specific question (conventions, architecture, library gotchas, past decisions) to fetch the note that applies, and whenever creating, editing or reorganising notes in the vault.
---

# duker-brain

The brain is an Obsidian vault arranged as a tree: folders are branches, notes
are leaves. A small decision model walks it one folder at a time, picking a
child by its one-line `criteria`, and returns the single note that applies.
Two things follow, and the rules below are those two things spelled out: a note
is only as findable as its criteria, and a folder is only as routable as it is
small.

This skill needs the `brain` MCP server. If the `brain_*` tools are missing,
the setup is one file: [mcp.json](mcp.json).

## Before answering: query the brain

Before answering a question about this project or its domain — its
conventions, architecture, how a library is used here, why something was
decided, a failure that was hit before — call `brain_route` with the user's
request in their own words.

- **A note comes back.** Treat it as background reference. Where it disagrees
  with general knowledge, the note wins: it records what this project actually
  does. If it turns out not to be about what was asked, ignore it.
- **"No guide for this prompt".** Answer normally. If you have reason to think
  a note exists, try `brain_search` with two or three keywords, then
  `brain_get_note`. Do not re-ask `brain_route` with reworded prompts.
- **An error.** The decisions service is unreachable. Tell the user once, and
  use `brain_search` and `brain_get_note` for the rest of the session; they
  work without it.

Skip the call for general programming questions, small talk, and follow-ups
that a note already in the conversation covers. Skip it too when a
`[Reference Guide: …]` block was already added for this prompt: Pi and the
Claude Code plugin route every prompt on their own.

## Writing notes

Write through the tools (`brain_add_note`, `brain_update_note`,
`brain_add_branch`, …), not by creating files: they generate the frontmatter
and recompile the index. Four rules decide whether a note is ever found again.

1. **Look before writing.** `brain_search` for the topic and `brain_tree` for
   where it belongs. If a note already covers it, extend that one with
   `brain_update_note` and `append`. Near-duplicate notes make both harder to
   route to.

2. **Criteria: 10–25 words that tell the note apart from its siblings.** Read
   the siblings first (`brain_tree` on the folder with `criteria: true`), then
   name the trigger words, domain terms and user intents that belong to this
   note and to none of them. It is a discriminator, not a summary.

   - weak: `things about databases`
   - strong: `PostgreSQL connection pooling, asyncpg pool sizing, PgBouncer transaction mode, statement cache errors`

   If the new note's terms overlap a sibling's, rewrite the sibling's criteria
   in the same change. Folders get criteria too, in their `_about.md`.

3. **At most 15 children per folder**, subfolders and notes counted together.
   Past that the router's choice gets unreliable. When a folder is full, do
   not add the sixteenth: use `brain_split_branch` to move a themed group into
   a subfolder first. Split by a real theme; an arbitrary split leaves the new
   folder with criteria nobody can write.

4. **Keep the catch-all.** The vault root holds exactly one note marked
   `fallback: true` (usually `general_instructions.md`); it is what the router
   returns when nothing else fits. Never remove it, never unmark it, never mark
   a second one in the same folder, and keep specific knowledge out of it. A
   subfolder may have a catch-all of its own under the same one-per-folder rule.

Frontmatter, if you ever have to write a file by hand:

```markdown
---
id: asyncpg_pooling
title: asyncpg Connection Pooling
criteria: PostgreSQL connections, asyncpg pool sizing and lifespan setup, PgBouncer transaction mode, statement cache errors
---
```

Removing a note or a folder moves it to `.trash/`; ask the user first.

## After writing or editing

Always finish with one of these, so the index the router reads matches the
notes on disk:

- **Changed through `brain_*` tools:** the index is already rebuilt. Run
  `brain_doctor` and fix what it reports (thin or duplicated criteria,
  over-full folders, a missing catch-all) before moving on.
- **Changed files directly** (an editor, Obsidian, git, a script): run
  `brain_rebuild`, then `brain_doctor`. Until the rebuild, the router cannot
  see the edit.

For a new note or rewritten criteria, also confirm it is reachable:
`brain_check_routing` with a prompt someone would really ask and `expected`
set to the note's id. If it lands elsewhere, the fix is the criteria of both
notes, not the folder structure.
