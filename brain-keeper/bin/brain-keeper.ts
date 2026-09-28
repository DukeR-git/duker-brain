/**
 * CLI over the same tools the MCP server exposes.
 *
 * Two jobs: `serve` is what a harness launches, and everything else lets you
 * exercise a tool from a shell — which is how you check the server will behave
 * before wiring it into an agent, and how you run maintenance without one.
 *
 *   brain-keeper init ~/brain --example
 *   brain-keeper setup
 *   brain-keeper serve
 *   brain-keeper doctor
 *   brain-keeper tree --criteria
 *   brain-keeper search "pgbouncer statement cache"
 *   brain-keeper check "how do I pool asyncpg connections?" --expect asyncpg_pooling
 *   brain-keeper watch
 *   brain-keeper call brain_add_note '{"folder":"Backend", ...}'
 */

import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { numberFlag, parseArgs, runMain, type Args } from "../../brain-core/src/cli.js";
import { applyPluginOptions, userConfigPath } from "../../brain-core/src/env.js";
import { withVaultLock } from "../../brain-core/src/fsutil.js";
import { MANIFEST_FILE } from "../../brain-core/src/manifest.js";
import { compileVault } from "../../brain-core/src/vault.js";
import { loadConfig, requireVault, type KeeperConfig } from "../src/config.js";
import { addBrain, renderAdd, renderStarters, renderUpdate, updateBrains } from "../src/brains.js";
import { initVault, renderInit } from "../src/init.js";
import { TOOLS, findTool, runTool } from "../src/tools.js";

const KEEPER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `
brain-keeper <command> [options]

  init <dir>                Create a vault (or adopt an existing one) and save it as the default
  starters                  List the starter brains, and the shared brains this vault holds
  add <source>              Add a shared brain as its own folder: a starter name, owner/repo[/folder][#ref], or a git URL
  update [folder]           Pull new and changed notes into shared brains, keeping your edits
  setup                     Print the commands that connect this server to Claude Code and Codex
  serve                     Run the MCP server on stdio (what a harness launches)
  tools                     List the tools this server exposes
  tree [folder]             Show the brain's structure
  doctor                    Health check: structure, criteria, stale manifests
  rebuild [folder]          Regenerate _index.json from note frontmatter
  watch                     Rebuild manifests whenever notes change (for editing in Obsidian)
  get <path>                Print one note
  search <words>...         Find notes by title, criteria and body
  check <prompt>...         Route prompts through the live router
  export                    Export vault rules (Cursor, Windsurf, Aider, bundle)
  call <tool> <json>        Call any tool directly; <json> may be '-' to read stdin

Options
  --vault <path>            Override the vault root
  --url <url>               Decisions API base URL (for check)
  --format <fmt>            Export format: cursor (default), windsurf, aider, bundle
  --out <dir>               Export output destination directory
  --criteria                Include routing criteria in the tree
  --depth <n>               Tree depth (default 3)
  --limit <n>               Most search results (default 10)
  --expect <id>             Expected destination for the last check prompt
  --dry-run                 For rebuild, init, add, update and export: report without writing
  --example                 For init: include the example notes
  --starter <source>        For init: add a shared brain too, e.g. --starter python-backend
  --as <folder>             For add: the vault folder to put the brain in (default: its name)
  --no-config               For init: do not save the vault to the user config

Flags also accept --name=value.
`.trim();

const VALUE_FLAGS = new Set(["vault", "url", "depth", "expect", "limit", "format", "out", "starter", "as"]);

function configFrom(args: Args): KeeperConfig {
	const overrides: Partial<KeeperConfig> = {};
	if (typeof args.flags.vault === "string") overrides.vaultRoot = args.flags.vault;
	if (typeof args.flags.url === "string") overrides.decisionsUrl = args.flags.url;
	const config = loadConfig({ overrides });
	for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`);
	return config;
}

async function call(args: Args, name: string, input: unknown): Promise<number> {
	const tool = findTool(name);
	if (!tool) {
		process.stderr.write(`unknown tool '${name}'. Run 'brain-keeper tools' for the list.\n`);
		return 2;
	}

	const result = await runTool(tool, configFrom(args), input);
	(result.isError ? process.stderr : process.stdout).write(result.text + "\n");
	return result.isError ? 1 : 0;
}

/**
 * Recompile whenever a note changes, so a vault edited by hand in Obsidian
 * keeps its manifests current. Changes are debounced: a save touches several
 * files, and Obsidian writes some of them twice.
 */
async function watchVault(config: KeeperConfig): Promise<number> {
	const vault = requireVault(config);
	let timer: NodeJS.Timeout | undefined;

	const rebuild = () => {
		try {
			const result = withVaultLock(vault, () => compileVault(vault, { maxHops: config.maxHops }));
			const written = result.files.filter((file) => file.status === "written");
			if (written.length) {
				const errors = result.issues.filter((issue) => issue.severity === "error").length;
				process.stdout.write(
					`${new Date().toLocaleTimeString()}  rebuilt ${written.map((file) => file.path).join(", ")}` +
						(errors ? `  (${errors} error(s): run brain-keeper doctor)` : "") +
						"\n",
				);
			}
		} catch (error) {
			process.stderr.write(`rebuild failed: ${(error as Error).message}\n`);
		}
	};

	rebuild();
	process.stdout.write(`watching ${vault} (Ctrl+C to stop)\n`);

	// Recursive fs.watch works on Windows, macOS and Linux with Node 20+.
	const watcher = watch(vault, { recursive: true }, (_event, file) => {
		const name = String(file ?? "").split(/[\\/]/);
		// Our own output, dotfiles (.obsidian, .trash, the lock, temp files) and
		// anything that is not a note or folder do not need a rebuild.
		if (name.some((part) => part.startsWith(".")) || name.at(-1) === MANIFEST_FILE) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(rebuild, 400);
	});

	return new Promise<number>((done) => {
		const stop = () => {
			watcher.close();
			if (timer) clearTimeout(timer);
			done(0);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

async function main(): Promise<number> {
	// Launched by the Claude Code plugin, the options from its settings dialog
	// arrive as CLAUDE_PLUGIN_OPTION_* variables; elsewhere this does nothing.
	applyPluginOptions(process.env);
	const args = parseArgs(process.argv.slice(2), VALUE_FLAGS);

	switch (args.command) {
		case "init": {
			const dir = args.positional[0];
			if (!dir) {
				process.stderr.write("init needs a directory, e.g. brain-keeper init ~/brain\n");
				return 2;
			}
			const dryRun = args.flags["dry-run"] === true;
			const result = initVault({
				dir,
				example: args.flags.example === true,
				saveConfig: args.flags["no-config"] !== true,
				dryRun,
			});
			process.stdout.write(renderInit(result) + "\n");
			if (typeof args.flags.starter === "string") {
				// A dry run of a vault that does not exist yet still shows what the brain would add.
				const added = addBrain({ vaultRoot: result.vaultRoot, source: args.flags.starter, dryRun: dryRun || !existsSync(result.vaultRoot) });
				process.stdout.write("\n" + renderAdd(added) + "\n");
			}
			return 0;
		}

		case "starters": {
			let vaultRoot: string | undefined;
			try {
				vaultRoot = configFrom(args).vaultRoot || undefined;
			} catch {
				/* listing starters needs no vault */
			}
			process.stdout.write(renderStarters(vaultRoot) + "\n");
			return 0;
		}

		case "add": {
			const source = args.positional[0];
			if (!source) {
				process.stderr.write("add needs a source, e.g. brain-keeper add python-backend, or brain-keeper add owner/repo\n");
				return 2;
			}
			const result = addBrain({
				vaultRoot: requireVault(configFrom(args)),
				source,
				as: typeof args.flags.as === "string" ? args.flags.as : undefined,
				dryRun: args.flags["dry-run"] === true,
			});
			process.stdout.write(renderAdd(result) + "\n");
			return 0;
		}

		case "update": {
			const result = updateBrains({
				vaultRoot: requireVault(configFrom(args)),
				folder: args.positional[0],
				dryRun: args.flags["dry-run"] === true,
			});
			process.stdout.write(renderUpdate(result) + "\n");
			return result.updates.some((update) => update.error) ? 1 : 0;
		}

		case "setup":
			process.stdout.write(setupText() + "\n");
			return 0;

		case "serve": {
			const { main: serve } = await import("../src/server.js");
			await serve();
			// The stdio transport owns the process from here.
			return new Promise<number>(() => {});
		}

		case "watch":
			return watchVault(configFrom(args));

		case "tools": {
			for (const tool of TOOLS) {
				const mark = tool.destructive ? "d" : tool.mutates ? "w" : "r";
				process.stdout.write(`${mark}  ${tool.name.padEnd(22)}`);
				process.stdout.write(`${tool.description.split(". ")[0]}.\n`);
			}
			process.stdout.write("\n(r = read-only, w = writes to the vault, d = removes something, to .trash/)\n");
			return 0;
		}

		case "tree": {
			const depth = numberFlag(args.flags, "depth", { min: 1, max: 8, integer: true });
			if (depth.error) {
				process.stderr.write(`${depth.error}\n`);
				return 2;
			}
			return call(args, "brain_tree", {
				folder: args.positional[0],
				criteria: args.flags.criteria === true,
				depth: depth.value,
			});
		}

		case "doctor":
			return call(args, "brain_doctor", {});

		case "rebuild":
			return call(args, "brain_rebuild", {
				folder: args.positional[0],
				dryRun: args.flags["dry-run"] === true,
			});

		case "get":
			if (!args.positional[0]) {
				process.stderr.write("get needs a note path\n");
				return 2;
			}
			return call(args, "brain_get_note", { path: args.positional[0] });

		case "search": {
			const query = args.positional.join(" ").trim();
			const limit = numberFlag(args.flags, "limit", { min: 1, max: 50, integer: true });
			if (!query || limit.error) {
				process.stderr.write(`${limit.error ?? "search needs some words"}\n`);
				return 2;
			}
			return call(args, "brain_search", { query, limit: limit.value });
		}

		case "check": {
			if (args.positional.length === 0) {
				process.stderr.write("check needs at least one prompt\n");
				return 2;
			}
			const expected = typeof args.flags.expect === "string" ? args.flags.expect : undefined;
			const prompts = args.positional.map((prompt, index) => ({
				prompt,
				// --expect applies to the last prompt, so a single-prompt check reads naturally.
				expected: index === args.positional.length - 1 ? expected : undefined,
			}));
			return call(args, "brain_check_routing", { prompts });
		}

		case "export": {
			const config = configFrom(args);
			const tool = findTool("brain_export")!;
			const fmt = (typeof args.flags.format === "string" ? args.flags.format : "cursor") as any;
			const out = typeof args.flags.out === "string" ? args.flags.out : undefined;
			const dryRun = args.flags["dry-run"] === true;
			const res = await runTool(tool, config, { format: fmt, outputDir: out, dryRun });
			if (res.isError) {
				process.stderr.write(`${res.text}\n`);
				return 1;
			}
			process.stdout.write(`${res.text}\n`);
			return 0;
		}

		case "call": {
			const [name, payload] = args.positional;
			if (!name) {
				process.stderr.write("call needs a tool name\n");
				return 2;
			}
			const raw = payload === "-" ? readFileSync(0, "utf8") : (payload ?? "{}");
			let input: unknown;
			try {
				input = JSON.parse(raw);
			} catch (error) {
				process.stderr.write(`arguments are not valid JSON: ${(error as Error).message}\n`);
				return 2;
			}
			return call(args, name, input);
		}

		case "":
		case "help":
			process.stdout.write(USAGE + "\n");
			return 0;

		default:
			process.stderr.write(`unknown command '${args.command}'\n\n${USAGE}\n`);
			return 2;
	}
}

/** Ready-to-paste harness wiring, with this checkout's absolute paths filled in. */
function setupText(): string {
	const launcher = resolve(KEEPER_ROOT, "bin", "brain-keeper.mjs");
	const commands = join(KEEPER_ROOT, "commands", "brain-*.md");
	const config = loadConfig();
	const quote = (path: string) => (/\s/.test(path) ? `"${path}"` : path);
	const needsKey = !config.apiKey;

	return `
Vault: ${config.vaultRoot || "(none yet - run: brain-keeper init <dir>)"}
The server reads the vault from ${userConfigPath()}. brain_check_routing also
needs the decisions API key in the server's environment when you route through
Jev${needsKey ? " (none is set in this shell)" : ""}; the commands below pass it.

Claude Code
  Easiest: install the plugin, which adds automatic routing as well:
    /plugin marketplace add DukeR-git/duker-brain
    /plugin install duker-brain@duker-brain
  Or only the tools, from this checkout:
  claude mcp add brain --scope user -e TYPESAFE_API_KEY=<your key> -- node ${quote(launcher)} serve
  commands: copy ${quote(commands)} into ~/.claude/commands/

Codex
  codex mcp add brain --env TYPESAFE_API_KEY=<your key> -- node ${quote(launcher)} serve
  commands: copy ${quote(commands)} into ~/.codex/prompts/

Any other MCP client (stdio)
  { "command": "node", "args": [${JSON.stringify(launcher)}, "serve"], "env": { "TYPESAFE_API_KEY": "<your key>" } }

Using a self-hosted Laya host instead of Jev? Drop the key (or pass its
LAYA_API_KEY as BRAIN_DECISIONS_API_KEY) and set "decisionsUrl" in the config file.

Pi needs none of this: \`pi install\` registers the tools and commands natively.
`.trim();
}

runMain("brain-keeper", main);
