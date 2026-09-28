# Installing the commands

`brain-capture.md` and `brain-research.md` are harness-agnostic prompt files.
They are plain Markdown with YAML frontmatter, which is the format all three
harnesses read — only the directory differs.

The `brain_*` tools are what the commands work with; install those first (see
the [keeper README](../README.md#1-install)). Without them the commands will
describe what they want to do and have nothing to do it with.

`brain-keeper setup` prints the paths below for your checkout.

## Claude Code

```bash
mkdir -p ~/.claude/commands
ln -s "$PWD/brain-capture.md"  ~/.claude/commands/brain-capture.md
ln -s "$PWD/brain-research.md" ~/.claude/commands/brain-research.md
```

Project-scoped instead of global: use `.claude/commands/` in the repo.
Invoke with `/brain-capture` and `/brain-research <topic>`.

## Codex

```bash
mkdir -p ~/.codex/prompts
ln -s "$PWD/brain-capture.md"  ~/.codex/prompts/brain-capture.md
ln -s "$PWD/brain-research.md" ~/.codex/prompts/brain-research.md
```

Invoke with `/brain-capture` and `/brain-research <topic>`.

## Pi

Nothing to do: `pi install` loads both files as prompt templates through the
`pi` manifest in the repository root. Invoke them with `/brain-capture` and
`/brain-research <topic>`.

## Any other harness

Paste the file's contents as a prompt. Nothing in them is harness-specific — they
reference `brain_*` tool names and `$ARGUMENTS`, and that is all.

## Why these are prompts and not code

Capturing knowledge well is a judgement task: what is worth keeping, whether it
duplicates something already filed, how to phrase criteria that discriminate. A
script cannot make those calls. What a script *can* do — write the file, keep the
index consistent, check the routing — is exactly what the MCP tools do. These
prompts are the judgement half; the tools are the mechanical half.
