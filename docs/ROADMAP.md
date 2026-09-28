# Roadmap

Ideas that are planned or being considered. None of it is promised, and the
order is a rough priority. If you want to work on one, open an issue first so
the design can be agreed before the code.

Already shipped in 1.0.0: routing evals (`brain-traverse eval`), the route
cache, rules export (`brain-keeper export`) and composite multi-document
routing. See [CHANGELOG.md](../CHANGELOG.md).

## Next

- **Automatic routing outside Pi.** Claude Code, Codex and other MCP clients get
  the keeper tools but not per-prompt routing. A Claude Code `UserPromptSubmit`
  hook that runs `brain-traverse route` and injects the note would cover the
  largest group of users.
- **Installable without cloning.** Publish to npm so MCP users can run
  `npx brain-keeper serve`. This needs `brain-core` to stop being imported by
  relative path, or the `dist/` bundles to become the published entry points.
- **Linting and formatting** for the TypeScript (Biome, or ESLint and Prettier)
  and Python (`ruff`), enforced in CI.
- **host-laya beyond Intel Arc.** CUDA and CPU compose profiles, and Apple
  Silicon (MPS) where the checkpoint supports it, chosen at container start.

## Authoring the brain

- **Criteria refinement** (`brain_refine_criteria`, `/brain refine [folder]`):
  look at a folder's children together, flag overlapping or vague `criteria`,
  and suggest sharper, mutually exclusive wording.
- **Gap analysis** (`brain-keeper gaps`): cluster the prompts in the route log
  that fell back to a catch-all or routed with low confidence, and report which
  topics the brain is missing.
- **Wikilinks.** When a note is injected, append a short index of the notes it
  `[[links]]` to, so the agent can fetch them with `brain_get_note`.
- **Optional git journaling** (`"autoGitCommit": true`): commit the vault after
  each keeper write, with a message naming the tool and the note.
- **Example vault guide.** A README for `pi-traverser/fixtures/vault` explaining
  how its `criteria` were written, as a model for new vaults.

## Routing

- **Context-aware budgets.** Let the harness pass the remaining context window
  so `maxDocumentChars` grows or shrinks with the headroom.
- **Speculative routing.** Start routing while the user is still typing, so the
  route is ready when the prompt is sent.

## Tooling around the brain

- **GitHub Action for vault health**: check that manifests are current, no
  folder has more than 15 children, criteria and IDs are valid, and the eval
  suite passes.
- **Local web playground** (`brain-traverse ui`): type a prompt and watch the
  hops, compare sibling criteria, and chart route-log statistics.
- **Obsidian plugin**: show criteria and the 15-child limit inside Obsidian, and
  test how a prompt routes without leaving it.

## host-laya

- **Quantised checkpoints** (8-bit and 4-bit) to cut VRAM use well below the
  current ~1.7 GB, so Laya fits beside a large LLM on one consumer card.
