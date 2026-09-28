---
name: brain-research
description: Research a topic on the web or in documentation and write it into the brain as a clean note.
argument-hint: <topic or question>
---

Research **$ARGUMENTS** and write what you find into the brain as a clean,
durable note, using the `brain_*` tools.

If no topic was given, ask for one and stop.

## 1. Check the brain first

Call `brain_check_routing` with a prompt someone would ask about this topic, and
`brain_tree` on the folder it lands in. If a note already covers it, your job is
to extend or correct that note, not to add a second one — near-duplicate notes
with near-identical criteria are the main way routing accuracy degrades.

Call `brain_get_note` on anything relevant before you change it.

## 2. Research

Use the web and documentation tools available in this session. Prefer, in order:

1. official documentation for the exact version in use — check the lockfile,
   `pyproject.toml`, `package.json` or equivalent before assuming
2. the project's own source or changelog
3. reputable secondary sources

Do not write a note from memory. The point of this command is that the note is
grounded in something you actually read. If the sources disagree, or the answer
depends on a version, say so in the note rather than picking one silently.

If you cannot find solid sources, report that and stop. Do not fill the gap with
plausible-sounding prose — a confidently wrong note is worse than no note,
because the router will inject it authoritatively into future prompts.

## 3. Write the note

Distil, do not transcribe. A brain note is not a copy of the documentation; it is
the part that is worth having at hand while coding.

Structure:

- open with the thing that is actually load-bearing — the constraint, the gotcha,
  the rule — not with a definition of the topic
- short sections with `##` headings, one idea each
- concrete names: functions, flags, config keys, error strings someone would
  paste into a search
- a `## Sources` section at the end listing the URLs you used, with the version
  or date where it matters

Keep it under a page. If the topic genuinely needs more, that is a sign it should
be two or three notes in a subfolder, each with its own criteria.

Do not include: marketing copy, history, installation boilerplate available in
any quickstart, or anything the model reliably knows without a reference.

## 4. File it

Call `brain_add_note` (or `brain_update_note` with `append` if you are extending
an existing note). Pick the folder from `brain_tree`. Write the `criteria` as
10–25 words of trigger terms and intents that discriminate this note from its
siblings — this decides whether the research is ever surfaced again.

If the topic does not fit any existing folder, prefer filing it in the closest
one over creating a new branch. Create a branch with `brain_add_branch` only when
you can write real criteria for it and expect several notes to live there.

## 5. Verify and report

Call `brain_check_routing` with two or three realistic prompts and `expected` set
to the new note. If any land elsewhere, fix the criteria and re-check.

Then call `brain_doctor`, split the folder if the write pushed it over the limit,
and report back in a few lines: what you wrote, where it went, which sources it
came from, and what the routing check showed.
