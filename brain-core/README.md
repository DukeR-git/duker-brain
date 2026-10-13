# brain-core — the shared vault model

The definitions both halves of the system depend on: the reader
([pi-traverser](../pi-traverser)) and the writer ([brain-keeper](../brain-keeper)).

This exists for one reason: **a manifest the keeper writes must be one the
traverser accepts.** Two copies of the schema, the ≤15 rule and the frontmatter
parser would eventually disagree, and the symptom would be routing that silently
stops working.

## Contents

| Module | What lives there |
|---|---|
| `types.ts` | Decisions protocol, manifest entries, vault nodes, traversal results |
| `frontmatter.ts` | Parse and write the four owned keys (block scalars and keyword lists included), preserving everything else |
| `manifest.ts` | `_index.json` schema, validation, cached reads, `MAX_CHILDREN` and the criteria thresholds |
| `vault.ts` | Scanning the tree, `.brainignore`, health checks, and the compiler — which never writes a manifest the traverser would reject |
| `traverser.ts` | The routing loop and its guardrails: confidence, route budget, the nearest catch-all |
| `decisions-client.ts` | HTTP client for the Jev decisions API, with a key-checking health probe; never throws |
| `paths.ts` | Vault-relative paths, and refusing anything that escapes the root (other Windows drives included) |
| `env.ts` | Defaults (Jev URL, path, model, timeouts) and config-file discovery |
| `config.ts` | The one validated config loader both packages use, with per-setting sources |
| `fsutil.ts` | Atomic writes and the vault lock |
| `routelog.ts` | The JSONL routing log and the report `brain-traverse stats` prints |
| `cli.ts` | Argument parsing and clean shutdown shared by both CLIs |

## How it is consumed

By **relative path**, not through `node_modules`:

```ts
import { scanVault } from "../../brain-core/src/vault.js";
```

No build step and no `file:` dependency to get out of sync, and it keeps
working when Pi loads the package from its git clone or through a symlink,
because Node resolves to the real path. The npm workspace at the repository root
exists only so that dependencies install in one place.

The one constraint: **the three folders must stay side by side** inside
`brain-traverse/`. Moving one breaks the imports in the other two.

## Tests

```bash
npm install     # at the repository root
npm test        # 169 tests
npm run typecheck
```

`test/mock-decisions.ts` is a fake of the Jev decisions API; with `jevKey` set
it requires that bearer key. It also scripts failures, `Retry-After` and
non-JSON bodies, and it answers 404 on any path Jev does not serve. Every
package's suite uses it, so nothing needs a network or an API key. `test/helpers.ts` makes temp vaults that are deleted
when the test process exits.

`test/live.test.ts` is the one test against a real service, and it only runs
when `BRAIN_LIVE_URL` is set.

The fixture vault lives in `../pi-traverser/fixtures/vault` and is shared by all
three suites. Its manifests are compiler output, and one test asserts that
recompiling it produces no diff — which is what makes "the reader and the writer
agree" a checked property rather than a hope.
