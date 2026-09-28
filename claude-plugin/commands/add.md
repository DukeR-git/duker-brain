---
description: Add a shared brain (a starter, or anyone's brain from GitHub) to your brain as its own folder.
argument-hint: <starter name | owner/repo[/folder][#ref] | git URL> [--as <folder>] [--dry-run]
allowed-tools: Bash(node:*)
---

Add a shared brain to the user's brain.

If no source was given (`$ARGUMENTS` is empty), list what is available and
ask which one to add:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/brain-keeper.mjs" starters
```

Otherwise run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/brain-keeper.mjs" add $ARGUMENTS
```

Report the result briefly: which folder it went into, how many notes, and any
errors the compile reported. Routing uses it from the next prompt; no restart
is needed.

If the source is not a starter brain, remind the user once, in one sentence,
that these notes will be given to the coding agent as context, so the source
should be one they trust. Do not open or summarise the notes unless asked.

If it fails because the folder already exists, suggest `--as <folder>`. If it
fails because the vault root is full (15 entries), suggest putting it inside an
existing folder, for example `--as Languages/python-backend`.
