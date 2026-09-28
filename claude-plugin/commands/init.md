---
description: Create a brain (an Obsidian vault for routing) or adopt an existing one, and make it the default.
argument-hint: <folder> [--example] [--starter <name>] [--dry-run]
allowed-tools: Bash(node:*)
---

Set up the brain that duker-brain routes prompts through.

If no folder was given (`$ARGUMENTS` is empty), ask the user where the vault
should live (suggest `~/brain`) and whether to start it with a starter brain
(`--starter <name>`), so routing has something to do straight away. The
available starters are listed by:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/brain-keeper.mjs" starters
```

Then continue with their answer.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/brain-keeper.mjs" init $ARGUMENTS
```

Report the result in a few lines. Things worth knowing when you do:

- `init` never overwrites a note. Pointed at an existing Obsidian vault it only
  adds `_index.json` manifests (build output) and a catch-all note if none
  exists. `--dry-run` shows what it would do first.
- `--starter <name>` adds that brain as its own folder; more can be added
  later with `/duker-brain:add`.
- It saves the folder as the default vault in
  `~/.config/brain-traverse/config.json`. The routing hook and the `brain_*`
  tools both read it, from the next prompt on; no restart is needed. A vault
  folder set in the plugin's settings takes precedence over it.
- Routing through the hosted TypeSafe Jev API (the default) needs an API key.
  If none is configured, tell the user to add it in the plugin's settings
  (`/plugin`, then duker-brain) or to set `TYPESAFE_API_KEY`.

Finish by suggesting `/duker-brain:status` to confirm that routing works.
