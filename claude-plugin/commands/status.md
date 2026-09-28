---
description: Show whether duker-brain is routing prompts, with which settings, and what the last prompt did.
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/brain-hook.mjs" status --data "${CLAUDE_PLUGIN_DATA}"
```

Show the output to the user as it is, in a code block. Then, in one or two
sentences, point out anything that stops routing from working: no vault, no API
key while the backend is TypeSafe Jev, or a paused decisions service. If
nothing is wrong, say that routing is working and stop.
