# pi-traverser — the router (Part 2)

The traversal engine, the Pi extension and the Claude Code hook. Takes the user's prompt, walks the
Obsidian vault by asking a decisions API (the hosted TypeSafe Jev API by default,
or a self-hosted Laya) to pick a child at each level, and injects the matching
reference guide into the agent's context.

This is Part 2 of [the architecture plan](../docs/architecture-plan.md). It
shares its vault model with [../brain-core](../brain-core) and reads the
manifests that [../brain-keeper](../brain-keeper) writes. It is installed by
`pi install` from the repository root; see [Installing into Pi](#5-installing-into-pi).

```
prompt ──> gate + hop 1 (one forward pass) ──> hop 2 ──> leaf .md
             │                                              │
             └── "no reference needed" ──> inject nothing    └──> LLM-visible message
```

---

## 1. Quick start

```bash
cd duker-brain        # the repository root: one install covers all packages
npm install
npm test
```

Then route a prompt against the fixture vault:

```bash
export TYPESAFE_API_KEY=sk-...
cd pi-traverser
node bin/brain-traverse.mjs route --vault ./fixtures/vault "How do I configure connection pooling for asyncpg in FastAPI?"
```

```
leaf | gate=0.97 | backend(0.94, 31ms) -> asyncpg_pooling(0.96, 29ms) | 68ms total | Backend/asyncpg_pooling.md
  hop . -> backend [branch] conf=0.941 of 4 options, 31ms
  hop Backend -> asyncpg_pooling [leaf] conf=0.958 of 4 options, 29ms

[Reference Guide: asyncpg Connection Pooling]
Source: Backend/asyncpg_pooling.md — routed via Root -> backend -> asyncpg_pooling.md, min confidence 0.94
...
```

Add `-v` to see the full probability distribution at each hop — that is what you
want when a prompt routes somewhere surprising.

## 2. The CLI

The reason this is a library plus a CLI rather than one `index.ts`: when the tree
misroutes, you need to iterate on criteria text without restarting Pi every time.

| Command | What it does |
|---|---|
| `route "<prompt>"` | Route one prompt; prints the trail, per-hop confidence, and the injected block. `--quiet` omits the document, `--json` emits the raw result, `-v` adds probabilities. |
| `lint` | Validate every `_index.json` in the vault: schema, duplicate ids, missing targets, branches without manifests, the ≤15 rule, thin criteria — and whether any manifest is stale against its notes. |
| `health` | Check the decisions API: which backend answered (Jev or Laya), the model, and whether the API key is accepted. |
| `bench [-n N]` | Route the same prompt N times; reports p50/p90/p99. Against a local host it gates on the plan's 100 ms budget; pass `--budget <ms>` to gate a remote one. |
| `config` | Print the resolved configuration, where each value came from, and any setting that was ignored and why. |
| `stats` | Summarise the routing log: what gets injected, notes that never are, folders where routing gives up, and near ties between siblings. |

Flags: `--vault`, `--url`, `--path`, `--timeout`, `--min-conf`, `--no-gate`,
`--no-cache`, `--no-composite`, `--budget`. Every flag also accepts `--name=value`, and numbers are validated.

`lint` is worth running before every Pi session once you start editing the vault
by hand — a branch pointing at a directory with no `_index.json` is silent at
runtime (the traverser falls back) but obvious to the linter.

## 3. How routing works

**One request covers the gate and the first hop.** Laya answers every question
in a request in a single forward pass, so the "does this prompt even need a
reference manual?" check rides along with the root choice instead of costing its
own round trip. A 2-hop route is two HTTP requests, not three.

**Composite Multi-Document Routing**: For cross-cutting developer prompts (e.g.
"Deploy our FastAPI asyncpg backend with Docker"), the router detects candidate
branches whose probability is within margin (`compositeThreshold`, `compositeMarginRatio`),
traverses both branches concurrently in parallel via `Promise.all`, and injects
complementary guides under a unified context budget allocation (`allocateUnifiedContextBudget`).

**Each hop** reads the current directory's `_index.json`, turns it into a
`criteria` map of `{ id: description }`, and asks for a `choice`. A `branch`
descends; a `leaf` is read from disk and returned.

**Guardrails**, in the order they fire:

| Situation | Result |
|---|---|
| A bare acknowledgement ("yes", "thanks", "continue") | `skipped` — no request at all |
| Gate probability < `gateThreshold` | `skipped` — nothing injected |
| Hop confidence < `minConfidence` (or act probability < `minActProbability`, Laya only) | stop, use the nearest catch-all |
| Chosen label is not in the manifest | stop, use the nearest catch-all |
| Branch target has no `_index.json` | stop, use the nearest catch-all |
| `maxHops` reached without a leaf | stop, use the nearest catch-all |
| Decisions API down, 5xx, timeout, or `routeBudgetMs` spent | `error` — **nothing injected** |
| Vault root has no `_index.json` | `no-index` — nothing injected |

The last two deliberately do not fall back: if the service is unreachable there
is no evidence that any guide is the right one, and injecting the catch-all
anyway would put unrequested instructions in front of the model on every turn.

**The catch-all** is the note marked `fallback: true`. With the default
`fallbackDocument: "auto"`, the search starts in the folder where routing gave
up and walks back to the root, so a confident hop into `Backend/` followed by an
unsure one lands on Backend's own catch-all if it has one. Set
`fallbackDocument` to a vault-relative path to always use one note, or to `""`
to inject nothing.

**Timeouts and retries** have a budget: `timeoutMs` per request and
`routeBudgetMs` for the whole route, retries included. Retries back off briefly
and honour `Retry-After`, but never past the budget, so a slow service costs a
turn at most `routeBudgetMs`.

## 4. What gets injected

An **LLM-visible message**, not a system-prompt edit:

```
[Reference Guide: asyncpg Connection Pooling]
Source: Backend/asyncpg_pooling.md — routed via Root -> backend -> asyncpg_pooling.md, min confidence 0.94
This is background reference material selected automatically for the prompt above.
Use it where it applies. If it is not relevant to what was asked, ignore it.

# asyncpg Connection Pooling
...

[End Reference Guide]
```

Two choices worth knowing about:

**Why a message and not `systemPrompt`.** Pi replaces the entire system prompt
for a turn when an extension returns one, and diffs it into a cache miss. Every
prompt that routes somewhere new would reprocess the whole prefix, which is
expensive on a large local model. A message appends, leaving the prefix cache
intact.

**Why it is framed as reference material rather than instruction.** Routing is
not perfect. A block the model is told it may ignore degrades gracefully when it
is wrong; a block phrased as system instructions does not.

YAML frontmatter is stripped before injection, and a document longer than
`maxDocumentChars` is cut at a line boundary (closing any code fence the cut
left open) with the truncation marked: `showing 12000 of 30500 characters`.

**The same guide is not sent twice in a row.** Within `reinjectAfterTurns`
turns (default 8), an unchanged guide that is already in the conversation is
replaced by a one-line reminder that it still applies. The memory resets when
the session is compacted, branched or switched, so a guide that may have left
the context goes back in.

## 5. Installing into Pi

From the repository root's `pi` manifest, one command installs this extension
together with the brain-keeper tools and commands:

```bash
pi install git:github.com/DukeR-git/duker-brain
```

Pi clones the repository, runs `npm install --omit=dev`, and loads
`pi-traverser/index.ts`. For development, install a checkout by path instead:
`pi install /path/to/duker-brain`. That links rather than copies, so edits
are live after `/reload`.

If the decisions API is not usable at `session_start` (unreachable, still
loading, or no API key for Jev), routing **pauses** and says why, rather than
making every prompt pay a timeout. It probes again in the background after a
cool-down (5 s for a host that is loading its checkpoint, otherwise 15 s
doubling to 5 min) and resumes on its own. Two decision failures in a row
mid-session pause it the same way. `/brain on` or `/brain status` re-checks at once.

With no vault configured, routing stays off until one is: `/brain-init` creates
one, then `/brain reload` (or `/reload`) picks it up. A config file that is not
valid JSON also turns routing off, with the parse error, instead of breaking
Pi's startup; fix it and run `/brain reload`.

Pi loads TypeScript through `jiti`, so there is no build step.

### In-session commands

| Command | Effect |
|---|---|
| `/brain status` | Routing on/off/paused, endpoint, backend and health (re-checked), last route |
| `/brain trace` | Full trail and confidences from the last prompt |
| `/brain reload` | Re-read the config, drop every cache, re-check the service, and say if any manifest is stale |
| `/brain rebuild` | Recompile the vault's manifests (after editing notes by hand) |
| `/brain stats` | The routing-log report: what gets injected, what never does, near ties |
| `/brain eval` | Run the vault's routing evaluation suite against sample prompts |
| `/brain on` / `/brain off` | Toggle routing for the session |
| `/brain config` | The resolved configuration, where each value came from, and ignored settings |
| `/brain help` | Display in-session command reference and descriptions |

The footer shows a live status line: `brain: asyncpg_pooling 0.94 68ms`.

### In Claude Code

The same router runs as the duker-brain plugin's hooks (see the
[root README](../README.md#claude-code-plugin) for installing it). Claude Code
starts `dist/brain-hook.mjs` afresh for every prompt, so the session memory the
Pi extension holds in memory lives in files in the plugin's data folder:
`sessions/<session_id>.json` (which guides the conversation holds) and
`breaker.json` (the service pause). The behaviour matches Pi's:

- the guide is added with `additionalContext`, and a one-line `systemMessage`
  shows the status when a guide goes in (`displayInjection`)
- an unchanged guide sent within `reinjectAfterTurns` becomes a reminder, and
  `SessionStart` after `/compact` or `/clear` resets that memory
- trivial follow-ups are not routed, and two decision failures in a row pause
  routing for 15 s, doubling to 5 min; the next prompt after the pause is the probe
- Claude Code caps hook output at 10,000 characters, so under the hook
  `maxDocumentChars` is limited to 8,500

The hook always exits 0 and stops itself after 8 s, inside the plugin's 10 s
timeout, so a slow or broken service costs the prompt its guide, never the
prompt itself. `/duker-brain:status` prints what it last saw.

## 6. Configuration

Resolved from defaults, then `~/.config/brain-traverse/config.json` (the user
file `brain-keeper init` writes), then `./brain-traverse.config.json` or
`$BRAIN_CONFIG`, then `BRAIN_*` environment variables. A relative `vaultRoot`
in a file resolves against that file's directory, and `~` is expanded. Copy
[config.example.json](../config.example.json) to start.

The loader lives in brain-core and the keeper uses it too. Every value is
validated — `"false"` is read as false, an out-of-range number or an unknown
key is ignored with a warning — and `/brain config` shows the warnings.

| Key | Env | Default | Meaning |
|---|---|---|---|
| `vaultRoot` | `BRAIN_VAULT_ROOT` | — | Vault root holding the top-level `_index.json`. Required. |
| `decisionsUrl` | `BRAIN_DECISIONS_URL` | `https://api.typesafe.ai` | Hosted Jev, or a self-hosted Laya such as `http://my-server:8081`. |
| `decisionsPath` | `BRAIN_DECISIONS_PATH` | `/v1/systemone` | Served by both Jev and host-laya. host-laya also accepts `/v1/decisions`. |
| `apiKey` | `TYPESAFE_API_KEY` / `BRAIN_DECISIONS_API_KEY` | — | Bearer token for Jev; the `BRAIN_` variable wins if both are set. A local Laya needs none. |
| `model` | `BRAIN_DECISIONS_MODEL` | `jev-latest` | Sent with every request. Pin e.g. `jev-1.13.0` once thresholds are tuned. Laya ignores it. |
| `timeoutMs` | `BRAIN_TIMEOUT_MS` | 500 local / 2000 remote | Per request. Derived from the URL if unset; "local" includes LAN addresses and bare host names. |
| `retries` | `BRAIN_RETRIES` | `1` | On network error, 429 or 5xx, with a short back-off. 503 is what host-laya returns while loading. |
| `routeBudgetMs` | `BRAIN_ROUTE_BUDGET_MS` | 1000 local / 3000 remote | Ceiling on a whole route, every hop and retry included. |
| `maxHops` | `BRAIN_MAX_HOPS` | `4` | Hard ceiling. The doctor flags folders deeper than this. |
| `minConfidence` | `BRAIN_MIN_CONFIDENCE` | `0.4` | Below this, fall back. Read from `probabilities` when a backend omits `confidence`. |
| `minActProbability` | `BRAIN_MIN_ACT_PROBABILITY` | `0` (off) | Laya only: below this act/abstain probability, fall back too. |
| `gateEnabled` | `BRAIN_GATE_ENABLED` | `true` | The "needs a manual?" pre-check. |
| `gateThreshold` | `BRAIN_GATE_THRESHOLD` | `0.5` | Noul probability to proceed. |
| `fallbackDocument` | `BRAIN_FALLBACK_DOC` | `auto` | The nearest note marked `fallback: true`; or a vault-relative path; `""` disables. |
| `maxDocumentChars` | `BRAIN_MAX_DOC_CHARS` | `12000` | Injected-document cap. |
| `maxPromptChars` | `BRAIN_MAX_PROMPT_CHARS` | `1500` | Prompt slice sent as decision state. |
| `watchManifests` | `BRAIN_WATCH_MANIFESTS` | `true` | Re-read `_index.json` on mtime change. |
| `displayInjection` | `BRAIN_DISPLAY_INJECTION` | `true` | Show the block in the TUI. |
| `reinjectAfterTurns` | `BRAIN_REINJECT_AFTER_TURNS` | `8` | Send a reminder instead of the same unchanged guide within this many turns; `0` re-injects every turn. |
| `routeLog` | `BRAIN_ROUTE_LOG` | `auto` | JSONL log for `stats`: `auto` is `$XDG_STATE_HOME/brain-traverse/routes.jsonl` (else `~/.local/state/...`); `""` turns it off. Prompts are stored only as a hash. |
| `enabled` | `BRAIN_ENABLED` | `true` | Master switch. |
| `logLevel` | `BRAIN_LOG_LEVEL` | `info` | `silent`…`debug`. |

### Tuning notes

`maxPromptChars` exists because Laya's English checkpoint has a 512-token
context that the criteria block shares. A pasted stack trace would crowd out the
options; the routing signal is almost always in the opening lines, so the head
is kept. Jev's context is far larger, but Jev bills per input token, so the same
cap still pays off there.

`minConfidence` at 0.4 is the plan's number and a reasonable start. Raise it
if you see confident-looking misroutes — and note that Laya's English checkpoint
collapses on non-English input *while still reporting high confidence*, so if
your prompts are not in English, use Jev or switch the Laya host to its
multilingual checkpoint rather than raising this.

## 7. The fixture vault

`fixtures/vault` is a two-level tree: 3 branches plus a fallback at the root,
9 leaves below. Leaves carry `id`/`title`/`criteria` frontmatter; each folder
describes itself in `_about.md`; the `_index.json` manifests are output from
brain-keeper's compiler.

It is shared by all three test suites, so `npm test` runs without a GPU, and it
is what `brain-keeper init --example` copies into a new vault. One
brain-core test asserts that recompiling it produces no diff — that is what keeps
the reader and the writer honest about each other.

## 8. Tests

```bash
npm test          # 43 tests here; the traversal suite lives in brain-core
npm run typecheck
```

Traversal, manifests, frontmatter and config validation are tested in
[../brain-core](../brain-core) (146 tests), since that is where they live.
What stays here covers the Pi extension itself: that it injects a message and
never a `systemPrompt`, that it pauses when the service is unreachable or Jev
has no key and resumes when the service comes back, the reminder instead of a
repeated guide, the routing log, the `/brain` command, the injection block's
format, and the CLI run as a real process. The factory takes its environment
and clock as options, so no test touches `process.env`.

Both suites drive a mock decisions server that can imitate either backend, so
nothing needs a GPU, a network or an API key.

For an end-to-end check against the real service, run the CLI with a key set
(or the Laya host up). `bench` is the quickest check of latency; the plan's
100 ms budget assumes a local Laya, so it is only enforced for a local URL.

## 9. Layout

```
pi-traverser/
├── index.ts                   Pi entry point (re-exports the factory; listed in the root pi manifest)
├── src/
│   ├── extension.ts           the Pi factory: hooks, health back-off, /brain command
│   ├── claude-hook.ts         the Claude Code hooks: prompt, session start, status
│   ├── session.ts             per-session memory shared by both: inject or remind
│   ├── inject.ts              injection block, reminder and trace formatting
│   └── config.ts              re-exports brain-core's shared config loader
├── bin/brain-traverse.mjs     CLI launcher (registers tsx, runs brain-traverse.ts)
├── bin/brain-traverse.ts      the CLI
├── bin/brain-hook.ts          the Claude Code hook command (bundled to dist/brain-hook.mjs)
├── fixtures/vault/            test vault, shared by all three packages
└── test/                      the Pi extension and config suites
```

## 10. Where this deviates from the plan

| Plan says | Reality | What was done |
|---|---|---|
| Default endpoint is local Laya on `:8081` | Most users have no GPU box to host it on | Defaults to hosted Jev; a local Laya is one config line. |
| Hook is `before_prompt` | Pi's hook is `before_agent_start` | Uses the real hook name. |
| "Prepend the document to the system prompt" | Returning `systemPrompt` replaces the turn's prompt and busts the prefix cache | Injects an LLM-visible message instead. |
| Confidence gate only | Every prompt pays a traversal, including "thanks" | Added a noul pre-check, batched into hop 1's forward pass so it is nearly free. |
| Low confidence → stop *or* fall back | Ambiguous | Falls back to the nearest catch-all (the folder's own, else the root's); with none, reports `low-confidence` and injects nothing. |
| Missing index → return `null` | — | Distinct statuses (`no-index`, `error`, `max-hops`, …) so `/brain trace` says *why* nothing was injected. |
| — | Not in the plan | Refuses a `targetPath` that escapes the vault root. |

## 11. Related

- [../host-laya](../host-laya) — optional self-hosted decisions service (Part 1)
- [../brain-core](../brain-core) — the shared vault model and the traversal engine
- [../brain-keeper](../brain-keeper) — MCP tools for writing to the brain (Part 3)

`bin/brain-traverse.ts lint` and `brain-keeper doctor` overlap deliberately: lint
validates the compiled manifests from the reader's point of view, doctor
validates the notes they were compiled from. If one is green and the other is
not, something wrote a manifest by hand.
