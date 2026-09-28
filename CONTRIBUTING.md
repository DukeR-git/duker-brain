# Contributing

Thanks for helping. Bug reports, routing reports, documentation fixes and pull
requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so the approach can
  be agreed before you write the code. [docs/ROADMAP.md](docs/ROADMAP.md) lists
  what is already planned.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

You need Node.js 22 or newer. Python 3.12 is only needed for `host-laya`.

```bash
git clone https://github.com/DukeR-git/duker-brain
cd duker-brain
npm install
```

## Checks

Run these before opening a pull request. CI runs the same checks on Linux and
Windows with Node 22 and 24.

```bash
npm run typecheck
npm test
npm run build
```

None of the tests need a GPU, a network or an API key: a mock decisions server
stands in for both Jev and Laya. The opt-in live test runs against a real
service:

```bash
BRAIN_LIVE_URL=https://api.typesafe.ai TYPESAFE_API_KEY=sk-... npm test
```

For `host-laya`:

```bash
cd host-laya
pip install -r requirements-test.txt
pytest
```

## How the code is laid out

- `brain-core` holds everything the router and the keeper share: the manifest
  schema, the 15-child rule, the frontmatter parser, the compiler and the
  decisions client. Put shared logic here, not in either consumer.
- `brain-core` is imported **by relative path** and has no build step, so
  `brain-core`, `pi-traverser` and `brain-keeper` must stay side by side. The
  root npm workspace only exists so dependencies install in one place.
- Pi loads the TypeScript directly, so there is nothing to compile for it. The
  `dist/` bundles from `npm run build` are for standalone CLI use and are not
  committed.
- A test asserts that recompiling the fixture vault in
  `pi-traverser/fixtures/vault` produces no diff. If you change the compiler
  on purpose, regenerate the fixture manifests in the same commit.

## Pull requests

- Keep each pull request to one change, and add or update tests with it.
- Match the style of the surrounding code: tabs in TypeScript, and comments
  that explain why rather than what.
- Update the relevant README, and add a line under `Unreleased` in
  [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- Keep line endings LF. `.gitattributes` handles this, but editors on Windows
  sometimes override it.

## Reporting a bad route

If the router picked the wrong note (or no note), the most useful report
includes:

- the prompt,
- the output of `brain-traverse route "<prompt>" -v`,
- the `criteria` of the note you expected and of its siblings,
- which backend and model you used (`brain-traverse health`).

The bug report template asks for these.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
