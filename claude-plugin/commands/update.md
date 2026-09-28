---
description: Pull new and changed notes into the shared brains you added, keeping the notes you edited.
argument-hint: [folder] [--dry-run]
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/brain-keeper.mjs" update $ARGUMENTS
```

Show the result as it is. If any note was "kept" because the user edited it
and it also changed upstream, say that their version was kept and that they
can compare it with the upstream version if they want the new content.
