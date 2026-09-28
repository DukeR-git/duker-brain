/**
 * Pi extension: the brain's authoring tools, registered natively.
 *
 * Claude Code and Codex reach these tools through the MCP server in
 * ./src/server.ts. Pi gets the very same definitions registered as Pi tools, so
 * `pi install` is the whole setup - no MCP adapter, no second process. It also
 * gets `/brain-init`, the in-session form of `brain-keeper init`.
 *
 * Pi validates tool arguments against plain JSON Schema, so each zod schema is
 * converted once here; the handler still parses with zod through `runTool`,
 * which keeps error messages identical across harnesses.
 */

import { existsSync } from "node:fs";

import * as z from "zod";

import { parseArgs } from "../brain-core/src/cli.js";
import { addBrain, renderAdd, renderStarters, renderUpdate, updateBrains } from "./src/brains.js";
import { LazyConfig, loadConfig, requireVault, type LoadOptions } from "./src/config.js";
import { initVault, renderInit } from "./src/init.js";
import { TOOLS, labelFor, runTool } from "./src/tools.js";

/** A slash command's argument string, parsed like the CLI's flags. */
function commandArgs(args: string, valueFlags: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
	const { positional, flags } = parseArgs(["command", ...args.trim().split(/\s+/).filter(Boolean)], new Set(valueFlags));
	return { positional, flags };
}

// Structural stand-in for Pi's ExtensionAPI: only what this file calls.
interface PiToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}
interface PiCommandContext {
	ui: { notify(text: string, level?: string): void };
	cwd?: string;
}
interface PiExtensionAPI {
	registerCommand(
		name: string,
		spec: { description: string; handler: (args: string, ctx: PiCommandContext) => Promise<void> | void },
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: Record<string, unknown>;
		execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiToolResult>;
	}): void;
}

export interface KeeperExtensionOptions {
	/** Environment to read config from; defaults to `process.env`. For tests. */
	env?: NodeJS.ProcessEnv;
}

export default function brainKeeper(pi: PiExtensionAPI, options: KeeperExtensionOptions = {}): void {
	const configOptions: LoadOptions = options.env ? { env: options.env } : {};
	// Resolved lazily, and again while no vault is set: `brain-keeper init` may
	// run mid-session, and a bad config file should surface as a tool error
	// rather than break Pi's startup.
	let config = new LazyConfig(() => loadConfig(configOptions));

	for (const tool of TOOLS) {
		const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.schema) as Record<string, unknown>;

		pi.registerTool({
			name: tool.name,
			label: labelFor(tool.name),
			description: tool.description,
			parameters,
			async execute(_toolCallId, params) {
				const result = await runTool(tool, config.get(), params);
				// Throwing is how a Pi tool reports failure; the message goes back to the model.
				if (result.isError) throw new Error(result.text);
				return { content: [{ type: "text", text: result.text }], details: { tool: tool.name } };
			},
		});
	}

	pi.registerCommand("brain-init", {
		description: "Create a brain vault and make it the default: /brain-init <dir> [--example] [--starter <name>] [--dry-run]",
		handler: (args, ctx) => {
			const { positional, flags } = commandArgs(args, ["starter"]);
			const dir = positional[0];
			if (!dir) {
				ctx.ui.notify("usage: /brain-init <dir> [--example] [--starter <name>] [--dry-run]   e.g. /brain-init ~/brain --starter python-backend", "warn");
				return;
			}
			try {
				const dryRun = flags["dry-run"] === true;
				const result = initVault({
					dir,
					example: flags.example === true,
					dryRun,
					cwd: ctx.cwd,
					env: options.env,
				});
				let text = renderInit(result);
				if (typeof flags.starter === "string") {
					const added = addBrain({ vaultRoot: result.vaultRoot, source: flags.starter, dryRun: dryRun || !existsSync(result.vaultRoot) });
					text += `\n\n${renderAdd(added)}`;
				}
				if (!dryRun) config = new LazyConfig(() => loadConfig(configOptions));
				ctx.ui.notify(`${text}${dryRun ? "" : "\n\nRun /brain reload (or /reload) to start routing with it."}`, "info");
			} catch (error) {
				ctx.ui.notify(`brain-init failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("brain-add", {
		description: "Add a shared brain as its own folder: /brain-add <starter name | owner/repo[/folder][#ref] | git URL> [--as <folder>] [--dry-run]",
		handler: (args, ctx) => {
			const { positional, flags } = commandArgs(args, ["as"]);
			if (!positional[0]) {
				ctx.ui.notify(`usage: /brain-add <source> [--as <folder>] [--dry-run]\n\n${renderStarters()}`, "warn");
				return;
			}
			try {
				const result = addBrain({
					vaultRoot: requireVault(config.get()),
					source: positional[0],
					as: typeof flags.as === "string" ? flags.as : undefined,
					dryRun: flags["dry-run"] === true,
				});
				ctx.ui.notify(`${renderAdd(result)}${result.dryRun ? "" : "\n\nRun /brain reload to route with it."}`, "info");
			} catch (error) {
				ctx.ui.notify(`brain-add failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("brain-update", {
		description: "Pull new and changed notes into shared brains, keeping your edits: /brain-update [folder] [--dry-run]",
		handler: (args, ctx) => {
			const { positional, flags } = commandArgs(args, []);
			try {
				const result = updateBrains({ vaultRoot: requireVault(config.get()), folder: positional[0], dryRun: flags["dry-run"] === true });
				const failed = result.updates.some((update) => update.error);
				ctx.ui.notify(`${renderUpdate(result)}${result.dryRun ? "" : "\n\nRun /brain reload to route with the changes."}`, failed ? "warn" : "info");
			} catch (error) {
				ctx.ui.notify(`brain-update failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("brain-export", {
		description: "Export vault rules to external formats: /brain-export <cursor|windsurf|aider|bundle> [outDir] [--dry-run]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const fmt = (parts.find((p) => !p.startsWith("--")) ?? "cursor") as any;
			const valid = ["cursor", "windsurf", "aider", "bundle"];
			if (!valid.includes(fmt)) {
				ctx.ui.notify(`unknown export format '${fmt}'. Choose one of: ${valid.join(", ")}`, "warn");
				return;
			}
			const outDir = parts.filter((p) => !p.startsWith("--"))[1];
			const dryRun = parts.includes("--dry-run");
			try {
				const tool = TOOLS.find((t) => t.name === "brain_export")!;
				const result = await runTool(tool, config.get(), { format: fmt, outputDir: outDir, dryRun });
				ctx.ui.notify(result.text, result.isError ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(`brain-export failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
