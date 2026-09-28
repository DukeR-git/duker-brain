# Security Policy

## Supported versions

Only the latest release gets security fixes.

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| < 1.2 | No |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub instead: open the repository's **Security**
tab and choose **Report a vulnerability**. Include what is affected, how to
reproduce it and what an attacker could do with it.

You should get a first reply within a week. Once a fix is released, the
advisory is published and you are credited, unless you would rather not be.

## Scope

These are in scope:

- **API key handling**: `apiKey`, `TYPESAFE_API_KEY`, `BRAIN_DECISIONS_API_KEY`
  or `LAYA_API_KEY` leaking into logs, the route log, error messages, injected
  context or tool output.
- **Vault writes**: any keeper tool or CLI command that can write, move or
  delete files outside the configured `vaultRoot`, for example through path
  traversal in a note ID or path.
- **host-laya**: authentication bypass when `LAYA_API_KEY` is set, or anything
  that lets a client do more than request a decision.
- **Shared brains**: a brain added with `brain-keeper add` that gets anything
  into your vault other than its own notes, for example files from outside
  its folder through links or path tricks, or anything that executes.
- **Prompt injection that escalates**: a note or prompt that makes the router or
  the keeper act beyond reading and writing notes in the vault.

These are out of scope:

- host-laya started without `LAYA_API_KEY` and bound to a network interface.
  That is documented as unauthenticated.
- The content of your own vault, including notes from a shared brain you
  added. Notes are injected into the agent's context by design, so only put
  there, and only add brains from sources, you trust. Report a malicious
  published brain to its host (for example GitHub) instead.
- Vulnerabilities in the hosted TypeSafe Jev API. Report those to TypeSafe.

## Hardening checklist

- Keep API keys in environment variables, not in `brain-traverse.config.json`.
  The config file is git-ignored, but a copy elsewhere may not be.
- Leave host-laya on `127.0.0.1` (the default) unless other machines need it.
  If they do, set `LAYA_API_KEY` and restrict the port with a firewall.
- Keep the vault in git, so that any unwanted keeper write can be reverted.
