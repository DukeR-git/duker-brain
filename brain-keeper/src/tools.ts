/**
 * The tool surface, defined once and mounted by both the MCP server and the CLI.
 *
 * Descriptions are written for a model deciding whether to call the tool, not
 * for a person browsing a reference. Each one says when to reach for it and,
 * where it matters, what to call instead.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as z from "zod";

import { exportVault, loadEvalSuite, renderEvalReport, runEvalSuite } from "../../brain-core/src/index.js";
import { parseNote } from "../../brain-core/src/frontmatter.js";
import { isLocalUrl } from "../../brain-core/src/env.js";
import { normaliseVaultPath, resolveInVault } from "../../brain-core/src/paths.js";
import { findNode, scanVault } from "../../brain-core/src/vault.js";
import { requireVault, type KeeperConfig } from "./config.js";
import * as ops from "./operations.js";
import { renderChangeSet, renderIssues, renderSearch, renderTree } from "./report.js";
import { checkRouting, createTraverser, renderRoutingChecks } from "./routing.js";

export interface ToolResult {
	text: string;
	isError?: boolean;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
	name: string;
	description: string;
	schema: S;
	/** True for tools that write to the vault; the CLI marks these in its help. */
	mutates: boolean;
	/** True when the tool removes something (even to `.trash/`); harnesses may ask before running it. */
	destructive?: boolean;
	/** True when calling it twice with the same input has no further effect. */
	idempotent?: boolean;
	/** True when it reaches outside the vault (the decisions service). */
	openWorld?: boolean;
	run(config: KeeperConfig, input: z.infer<S>): Promise<ToolResult> | ToolResult;
}

/** MCP tool annotations, derived from the flags above. */
export function annotationsFor(tool: ToolDefinition) {
	return {
		title: labelFor(tool.name),
		readOnlyHint: !tool.mutates,
		destructiveHint: tool.mutates ? tool.destructive === true : false,
		idempotentHint: tool.idempotent === true || !tool.mutates,
		openWorldHint: tool.openWorld === true,
	};
}

/** `brain_add_note` -> `Brain: add note`. */
export function labelFor(name: string): string {
	return `Brain: ${name.replace(/^brain_/, "").replace(/_/g, " ")}`;
}

const CRITERIA_HELP =
	"10-25 words naming the trigger words, domain keywords and user intents that should select this node. " +
	"Write it as a discriminator against its siblings, not as a summary: " +
	'"FastAPI routing, dependency injection, async database connections, uvicorn config" beats "everything about the backend".';

function ok(text: string): ToolResult {
	return { text };
}

/**
 * Infers each tool's input type from its own schema.
 *
 * Annotating a tool as `ToolDefinition` would widen the generic to the default
 * and leave every handler's `input` as `unknown`; going through this helper
 * keeps the schema's inferred type inside the handler while the exported list
 * stays uniformly typed.
 */
function defineTool<S extends z.ZodTypeAny>(definition: ToolDefinition<S>): ToolDefinition {
	return definition as unknown as ToolDefinition;
}

const opts = (config: KeeperConfig): ops.OperationOptions => ({ maxHops: config.maxHops });

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const brainTree = defineTool({
	name: "brain_tree",
	description:
		"Show the structure of the brain: folders, notes, child counts, and which folders are over the 15-child " +
		"routing limit. Call this first when you need to know what the brain already covers or where a new note belongs.",
	mutates: false,
	schema: z.object({
		folder: z.string().optional().describe('Subtree to show, vault-relative. Defaults to the whole brain.'),
		depth: z.number().int().min(1).max(8).optional().describe("How deep to render. Default 3."),
		criteria: z.boolean().optional().describe("Include each node's routing criteria. Verbose but useful when auditing."),
	}),
	run(config, input) {
		const vault = requireVault(config);
		const tree = scanVault(vault, { maxHops: config.maxHops });
		const start = input.folder ? findNode(tree.root, normaliseVaultPath(input.folder)) : tree.root;
		if (!start) return { text: `No such folder in the brain: ${input.folder}`, isError: true };

		const errors = tree.issues.filter((issue) => issue.severity === "error").length;
		return ok(
			[
				`${vault}`,
				`${tree.counts.branches} folder(s), ${tree.counts.leaves} note(s)` +
					(errors ? `, ${errors} structural error(s) — run brain_doctor` : ""),
				"",
				renderTree(start, { maxDepth: input.depth ?? 3, criteria: input.criteria === true }),
			].join("\n"),
		);
	},
});

const brainGetNote = defineTool({
	name: "brain_get_note",
	description:
		"Read one note from the brain: its frontmatter (id, title, criteria) and its full body. " +
		"Use before updating a note so you amend it rather than overwrite what is already there. " +
		"A folder's `_about.md` can be read the same way.",
	mutates: false,
	schema: z.object({
		path: z.string().describe('Vault-relative path of a .md file, e.g. "Backend/asyncpg_pooling.md".'),
	}),
	run(config, input) {
		const vault = requireVault(config);
		// Markdown only: the vault also holds `.obsidian/` settings, where plugins
		// keep API tokens, and none of that is the brain's to hand out.
		if (!input.path.trim().toLowerCase().endsWith(".md")) {
			return { text: `Only markdown notes can be read: ${input.path}`, isError: true };
		}
		const absolute = resolveInVault(vault, input.path, "note");
		let raw: string;
		try {
			raw = readFileSync(absolute, "utf8");
		} catch {
			return { text: `No such note: ${input.path}`, isError: true };
		}

		const note = parseNote(raw);
		return ok(
			[
				`path:     ${normaliseVaultPath(input.path)}`,
				`id:       ${note.frontmatter.id ?? "(derived from filename)"}`,
				`title:    ${note.frontmatter.title ?? "(none)"}`,
				`criteria: ${note.frontmatter.criteria ?? "(none)"}`,
				note.frontmatter.fallback ? "fallback: true" : "",
				"",
				"---",
				note.body.trimEnd(),
			]
				.filter((line) => line !== "")
				.join("\n"),
		);
	},
});

const brainSearch = defineTool({
	name: "brain_search",
	description:
		"Keyword search across every note's title, criteria and body. Use it before adding a note to find one that " +
		"already covers the topic (extend that instead), and to find notes by content when you do not know where they " +
		"are filed. Works without the decisions service.",
	mutates: false,
	schema: z.object({
		query: z.string().describe("Words to look for, e.g. \"pgbouncer statement cache\"."),
		limit: z.number().int().min(1).max(50).optional().describe("Most results to return. Default 10."),
	}),
	run(config, input) {
		const vault = requireVault(config);
		return ok(renderSearch(input.query, ops.searchNotes(vault, input.query, input.limit ?? 10)));
	},
});

const brainDoctor = defineTool({
	name: "brain_doctor",
	description:
		"Health check the whole brain: folders over the routing limit, notes with missing, thin or duplicated " +
		"criteria, empty folders, stale manifests. Returns each problem with the action that fixes it. " +
		"Run this when asked to improve or maintain the brain, and after a batch of edits.",
	mutates: false,
	schema: z.object({}),
	run(config) {
		const vault = requireVault(config);
		const report = ops.doctor(vault, opts(config));
		const lines = [
			`${vault}`,
			`${report.counts.branches} folder(s), ${report.counts.leaves} note(s)`,
			"",
			renderIssues(report.issues),
		];

		if (report.stale.length) {
			lines.push(
				"",
				`${report.stale.length} manifest(s) are stale — the notes on disk no longer match the compiled index:`,
			);
			for (const file of report.stale) lines.push(`  ${file.path}`);
			lines.push("Run brain_rebuild to regenerate them.");
		}

		return ok(lines.join("\n"));
	},
});

const brainCheckRouting = defineTool({
	name: "brain_check_routing",
	description:
		"Ask the live router where prompts land, using the same traversal and the same settings the coding agent uses " +
		"at prompt time. This is how you verify a new note is reachable and that criteria edits worked. " +
		"Supply `expected` to assert a prompt should reach a specific note. Requires the decisions service.",
	mutates: false,
	openWorld: true,
	schema: z.object({
		prompts: z
			.array(
				z.object({
					prompt: z.string().describe("A realistic user prompt that should reach a particular note."),
					expected: z.string().optional().describe("Note id or vault-relative path you expect it to reach."),
				}),
			)
			.min(1)
			.max(20),
	}),
	async run(config, input) {
		const vault = requireVault(config);
		const checks = await checkRouting(config, vault, input.prompts);
		const allFailed = checks.every((check) => check.result.status === "error");
		if (!allFailed) return ok(renderRoutingChecks(checks));

		const fix = isLocalUrl(config.decisionsUrl)
			? "Check that the Laya host is running (brain-traverse health), or point BRAIN_DECISIONS_URL elsewhere."
			: config.apiKey
				? "Check the API key and BRAIN_DECISIONS_URL (brain-traverse health says which is wrong)."
				: "Set TYPESAFE_API_KEY (or BRAIN_DECISIONS_API_KEY) in this server's environment, or point BRAIN_DECISIONS_URL at a Laya host.";
		return {
			text: `${renderRoutingChecks(checks)}\n\nEvery check failed to reach the decisions service at ${config.decisionsUrl}. ${fix}`,
			isError: true,
		};
	},
});

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const brainAddNote = defineTool({
	name: "brain_add_note",
	description:
		"Add a new note to the brain. This is how knowledge gets captured. " +
		"Call brain_search or brain_tree first to find where it belongs (and whether it already exists), and " +
		"brain_check_routing afterwards to confirm the note is reachable. Writes the file and regenerates the " +
		"affected index; nothing else is needed.",
	mutates: true,
	schema: z.object({
		folder: z.string().describe('Vault-relative folder, e.g. "Backend". Use "." for the root.'),
		title: z.string().describe("Human-readable title, e.g. \"asyncpg Connection Pooling\"."),
		criteria: z.string().describe(CRITERIA_HELP),
		content: z.string().describe("The note body in Markdown. No frontmatter — that is generated."),
		id: z.string().optional().describe("Routing label and filename stem. Defaults to a slug of the title."),
		fallback: z.boolean().optional().describe("Mark as this folder's catch-all note. At most one per folder."),
		overwrite: z.boolean().optional().describe("Replace an existing note at the same id."),
	}),
	run: (config, input) => ok(renderChangeSet(ops.addNote(requireVault(config), input, opts(config)))),
});

const brainUpdateNote = defineTool({
	name: "brain_update_note",
	description:
		"Amend an existing note: retitle it, rewrite its routing criteria, replace its body, or append to it. " +
		"Prefer `append` when adding newly learned detail to a note that is otherwise fine. " +
		"Rewriting `criteria` is the main lever for fixing a note that the router keeps missing.",
	mutates: true,
	schema: z.object({
		path: z.string().describe('Vault-relative path, e.g. "Backend/asyncpg_pooling.md".'),
		title: z.string().optional(),
		criteria: z.string().optional().describe(CRITERIA_HELP),
		content: z.string().optional().describe("Replaces the entire body."),
		append: z.string().optional().describe("Appended after a blank line. Cannot be combined with `content`."),
		fallback: z.boolean().optional().describe("Make this its folder's catch-all note, or stop it being one."),
	}),
	run: (config, input) => ok(renderChangeSet(ops.updateNote(requireVault(config), input, opts(config)))),
});

const brainMoveNote = defineTool({
	name: "brain_move_note",
	description:
		"Move a note to a different folder, optionally renaming its id. Use when a note is filed somewhere the " +
		"router will never look for it — which brain_check_routing is how you find out.",
	mutates: true,
	schema: z.object({
		from: z.string().describe("Current vault-relative path."),
		toFolder: z.string().describe("Destination folder, vault-relative."),
		newId: z.string().optional().describe("New routing label and filename stem."),
	}),
	run: (config, input) => ok(renderChangeSet(ops.moveNote(requireVault(config), input, opts(config)))),
});

const brainRemoveNote = defineTool({
	name: "brain_remove_note",
	description:
		"Remove a note from the brain by moving it to the vault's .trash/ folder, where it can be restored by moving " +
		"it back. Confirm with the user before calling. To refile a note rather than retire it, use brain_move_note.",
	mutates: true,
	destructive: true,
	schema: z.object({ path: z.string().describe("Vault-relative path of the note to remove.") }),
	run: (config, input) => ok(renderChangeSet(ops.removeNote(requireVault(config), input.path, opts(config)))),
});

const brainAddBranch = defineTool({
	name: "brain_add_branch",
	description:
		"Create a new folder (a routing branch) with its `_about.md` description. " +
		"Only needed when a genuinely new domain appears — prefer filing into an existing folder. " +
		"A folder with no notes routes nowhere, so add at least one note after creating it.",
	mutates: true,
	schema: z.object({
		parent: z.string().describe('Parent folder, vault-relative. Use "." for the root.'),
		title: z.string().describe("Folder title, also used as the folder name unless folderName is given."),
		criteria: z.string().describe(CRITERIA_HELP),
		id: z.string().optional().describe("Routing label. Defaults to a slug of the folder name."),
		folderName: z.string().optional().describe("Directory name on disk, if it should differ from the title."),
		about: z.string().optional().describe("Body of the folder's _about.md."),
	}),
	run: (config, input) => ok(renderChangeSet(ops.addBranch(requireVault(config), input, opts(config)))),
});

const brainUpdateBranch = defineTool({
	name: "brain_update_branch",
	description:
		"Change a folder's title, routing criteria, or `_about.md` body. " +
		"Use when prompts are being routed into (or away from) a folder incorrectly at the top level.",
	mutates: true,
	idempotent: true,
	schema: z.object({
		folder: z.string().describe("Vault-relative folder path."),
		title: z.string().optional(),
		criteria: z.string().optional().describe(CRITERIA_HELP),
		about: z.string().optional().describe("Replaces the _about.md body."),
	}),
	run: (config, input) => ok(renderChangeSet(ops.updateBranch(requireVault(config), input, opts(config)))),
});

const brainMoveBranch = defineTool({
	name: "brain_move_branch",
	description:
		"Move a folder under a different parent, rename it on disk, or change its routing id — any combination. " +
		"Use when a whole topic is filed in the wrong place, or its name no longer fits.",
	mutates: true,
	schema: z.object({
		folder: z.string().describe("The folder to move, vault-relative."),
		toParent: z.string().optional().describe('New parent folder, vault-relative ("." for the root). Defaults to where it is.'),
		newName: z.string().optional().describe("New directory name on disk."),
		newId: z.string().optional().describe("New routing label, written to its _about.md."),
	}),
	run: (config, input) => ok(renderChangeSet(ops.moveBranch(requireVault(config), input, opts(config)))),
});

const brainRemoveBranch = defineTool({
	name: "brain_remove_branch",
	description:
		"Remove a whole folder, and every note in it, by moving it to the vault's .trash/ folder. " +
		"Confirm with the user before calling — say how many notes it holds. Prefer brain_move_branch or " +
		"brain_split_branch when the notes are still useful.",
	mutates: true,
	destructive: true,
	schema: z.object({ folder: z.string().describe("Vault-relative folder to remove.") }),
	run: (config, input) => ok(renderChangeSet(ops.removeBranch(requireVault(config), input.folder, opts(config)))),
});

const brainSplitBranch = defineTool({
	name: "brain_split_branch",
	description:
		"Fix an over-full folder: create a subfolder and move a themed subset of its children into it, in one step. " +
		"This is the remedy brain_doctor points at for a folder above the 15-child limit. " +
		"Group the moved notes by an actual theme — an arbitrary split makes the new folder's criteria unwritable.",
	mutates: true,
	schema: z.object({
		folder: z.string().describe("The over-full folder, vault-relative."),
		newFolderTitle: z.string().describe("Title of the subfolder to create."),
		newFolderCriteria: z.string().describe(CRITERIA_HELP),
		moveIds: z
			.array(z.string())
			.min(2)
			.describe("Ids of the children to move. Must share a theme, and must leave at least one behind."),
		newFolderId: z.string().optional(),
		newFolderName: z.string().optional().describe("Directory name, if different from the title."),
		about: z.string().optional().describe("Body of the new folder's _about.md."),
	}),
	run: (config, input) => ok(renderChangeSet(ops.splitBranch(requireVault(config), input, opts(config)))),
});

const brainRebuild = defineTool({
	name: "brain_rebuild",
	description:
		"Regenerate every `_index.json` from note frontmatter. The other tools do this automatically, so you only " +
		"need it after editing the vault outside these tools — in Obsidian, in an editor, or via git.",
	mutates: true,
	idempotent: true,
	schema: z.object({
		folder: z.string().optional().describe("Limit to one subtree, vault-relative."),
		dryRun: z.boolean().optional().describe("Report what would change without writing."),
	}),
	run: (config, input) =>
		ok(renderChangeSet(ops.rebuild(requireVault(config), input.folder, input.dryRun === true, opts(config)))),
});

const brainEval = defineTool({
	name: "brain_eval",
	description:
		"Run routing regression evals against the vault to verify that sample developer prompts reach expected reference guides.",
	mutates: false,
	openWorld: true,
	schema: z.object({
		evalsFile: z.string().optional().describe("Path to an evals.json or evals.yaml file. Defaults to evals.json in vault root."),
		tag: z.string().optional().describe("Limit evaluation to tests matching this tag."),
	}),
	async run(config, input) {
		const vault = requireVault(config);
		let evalPath = input.evalsFile;
		if (!evalPath) {
			const jsonP = join(vault, "evals.json");
			const yamlP = join(vault, "evals.yaml");
			if (existsSync(jsonP)) evalPath = jsonP;
			else if (existsSync(yamlP)) evalPath = yamlP;
			else return { text: `No eval suite found in ${vault} (expected evals.json or evals.yaml)`, isError: true };
		}
		const suite = loadEvalSuite(resolve(vault, evalPath));
		const traverser = createTraverser(config, vault);
		const report = await runEvalSuite(suite, traverser, { tags: input.tag ? [input.tag] : undefined });
		return ok(renderEvalReport(report));
	},
});

const brainExport = defineTool({
	name: "brain_export",
	description:
		"Export vault reference guides into formats for external coding tools: Cursor (.cursor/rules/*.mdc), " +
		"Windsurf (.windsurfrules), Aider (.aider.conf.yml), or clean Markdown bundle.",
	mutates: true,
	idempotent: true,
	schema: z.object({
		format: z.enum(["cursor", "windsurf", "aider", "bundle"]).describe("Target export format."),
		outputDir: z.string().optional().describe("Destination directory. Defaults to standard project locations."),
		dryRun: z.boolean().optional().describe("Preview what files would be generated without writing to disk."),
	}),
	async run(config, input) {
		const vault = requireVault(config);
		let outDir = input.outputDir;
		if (!outDir) {
			if (input.format === "cursor") outDir = ".cursor/rules";
			else if (input.format === "windsurf") outDir = ".";
			else if (input.format === "aider") outDir = ".";
			else outDir = "dist/vault-bundle";
		}
		const result = await exportVault(vault, input.format, outDir, { dryRun: input.dryRun });
		const prefix = result.dryRun ? "[dry-run] " : "";
		return ok(
			`${prefix}Exported ${result.noteCount} notes to ${result.format} format at ${result.outDir}:\n` +
				result.filesWritten.map((f) => `  ${f}`).join("\n"),
		);
	},
});

export const TOOLS: ToolDefinition[] = [
	brainTree,
	brainGetNote,
	brainSearch,
	brainDoctor,
	brainCheckRouting,
	brainEval,
	brainExport,
	brainAddNote,
	brainUpdateNote,
	brainMoveNote,
	brainRemoveNote,
	brainAddBranch,
	brainUpdateBranch,
	brainMoveBranch,
	brainRemoveBranch,
	brainSplitBranch,
	brainRebuild,
];

export function findTool(name: string): ToolDefinition | undefined {
	return TOOLS.find((tool) => tool.name === name);
}

/** Run a tool and turn any thrown error into a readable failure result. */
export async function runTool(
	tool: ToolDefinition,
	config: KeeperConfig,
	input: unknown,
): Promise<ToolResult> {
	try {
		const parsed = tool.schema.parse(input);
		return await tool.run(config, parsed);
	} catch (error) {
		// Tool errors are feedback to the model, not crashes: say what went wrong
		// clearly enough that the next call can be right.
		if (error instanceof z.ZodError) {
			const details = error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
			return { text: `Invalid arguments for ${tool.name}:\n  ${details.join("\n  ")}`, isError: true };
		}
		return { text: `${tool.name} failed: ${(error as Error).message}`, isError: true };
	}
}
