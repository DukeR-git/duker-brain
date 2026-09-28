---
name: brain-capture
description: Review this session and file what is worth keeping into the brain.
---

Review the work in this session and capture what is worth keeping into the brain,
using the `brain_*` tools.

## What is worth keeping

Keep things that will still be true and still be useful in three months, in a
different session, to someone who was not here:

- a non-obvious constraint of a library, API, or tool, and what it forces
- a failure mode with its actual cause, not just the fix
- a decision with its reasoning, where the reasoning is not obvious from the code
- a procedure that took real effort to work out

Do **not** keep:

- anything already in the codebase, its README, or its git history — the brain is
  for what the repo does not record
- narration of what happened this session ("we fixed the build")
- restatements of public documentation the model already knows
- anything specific to one file or one commit, which will be stale by next week

If nothing in this session clears that bar, say so and stop. A brain full of
filler routes worse than a small one, because the router has more near-identical
criteria to discriminate between. Capturing nothing is a valid outcome.

## How to file it

1. **Look before you write.** Call `brain_tree` to see what the brain already
   covers. For each candidate, call `brain_check_routing` with a prompt someone
   would actually ask about it. If it already lands on a relevant note, the right
   move is almost always `brain_update_note` with `append`, not a new note.

2. **Propose before you write.** Show the user a short list: for each item, the
   title, the destination folder, the criteria line, and whether it is a new note
   or an addition to an existing one. Wait for their go-ahead. Do not batch-write
   a session's worth of notes unasked.

3. **Write the criteria carefully.** This is the part that decides whether the
   note is ever found again. 10–25 words naming the trigger words, domain terms
   and user intents that should select it, written to discriminate against its
   siblings:

   - weak: `things about databases`
   - strong: `PostgreSQL connection pooling, asyncpg pool sizing, PgBouncer transaction mode, statement cache errors`

4. **Write the body for a stranger.** State the constraint or the cause first,
   then the detail. Keep it under a page. Do not address the reader as if they
   were in this session — no "as we saw above", no "the bug we just fixed".

5. **Verify.** After writing, call `brain_check_routing` with the prompt from
   step 1 and `expected` set to the new note. If it lands elsewhere, fix the
   criteria — of both notes, usually — and check again. A note the router cannot
   reach is not captured, it is just stored.

6. **Leave it tidy.** Call `brain_doctor`. If the folder you wrote into is now
   over the 15-child limit, split it with `brain_split_branch`, grouping by an
   actual theme. Report the result in two or three lines.
