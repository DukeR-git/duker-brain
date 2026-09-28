/**
 * `brain-keeper init`: create a vault that routes, and remember where it is.
 *
 * A fresh vault needs three things before the router can use it: a catch-all
 * note marked `fallback: true`, compiled `_index.json` manifests, and a config
 * entry pointing at it. Doing those by hand is where first-time setup usually
 * goes wrong, so this does all three - and never overwrites a note, so it is
 * also safe to run on an existing Obsidian vault. (The `_index.json` files are
 * build output and are regenerated; `--dry-run` shows which first.)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveUserPath, userConfigPath } from "../../brain-core/src/env.js";
import { withVaultLock, writeFileAtomic } from "../../brain-core/src/fsutil.js";
import { MANIFEST_FILE } from "../../brain-core/src/manifest.js";
import { IGNORE_FILE, compileVault, type CompileResult } from "../../brain-core/src/vault.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The fixture vault doubles as the example: three branches, nine leaves. */
export const EXAMPLE_VAULT = resolve(here, "..", "..", "pi-traverser", "fixtures", "vault");

const FALLBACK_NOTE = `---
id: general_instructions
title: General Instructions
criteria: General coding conventions and working agreements when no specific domain guide matches the request
fallback: true
---

# General Instructions

The catch-all guide: injected when routing is inconclusive. Keep it short and
true for every project - specific knowledge belongs in its own note.

- Match the surrounding code's style, naming and comment density.
- Prefer the smallest change that solves the stated problem.
- Check a library's installed version before assuming an API.
- Say so explicitly before adding a dependency.
`;

const IGNORE_TEMPLATE = `# Folders and notes that are not part of the brain, one pattern per line.
# A pattern with a "/" matches a vault-relative path; one without matches a name
# at any depth. *, ** and ? work as in .gitignore.
#
# Templates
# Attachments
# Daily Notes
`;

export interface InitOptions {
	/** Vault directory; created if missing. `~` and relative paths are resolved. */
	dir: string;
	/** Copy the example vault (Backend / Frontend / Infrastructure) in as well. */
	example?: boolean;
	/** Record the vault in the user config file. Default true. */
	saveConfig?: boolean;
	/** Report what would be created and compiled, without writing anything. */
	dryRun?: boolean;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface InitResult {
	vaultRoot: string;
	/** Vault-relative files this call created (or, in a dry run, would create). */
	created: string[];
	/** The user config file written, if any. */
	configPath?: string;
	compiled: CompileResult;
	dryRun: boolean;
}

/** Copy `from` into `to`, skipping manifests and any file that already exists; returns what was (or would be) copied. */
function copyMissing(from: string, to: string, root: string, dryRun: boolean): string[] {
	const copied: string[] = [];
	for (const name of readdirSync(from).sort()) {
		if (name === MANIFEST_FILE) continue; // build output; compiled fresh below
		const source = join(from, name);
		const target = join(to, name);
		if (statSync(source).isDirectory()) {
			if (!dryRun) mkdirSync(target, { recursive: true });
			copied.push(...copyMissing(source, target, root, dryRun));
		} else if (!existsSync(target)) {
			if (!dryRun) copyFileSync(source, target);
			copied.push(relative(root, target).split("\\").join("/"));
		}
	}
	return copied;
}

export function initVault(options: InitOptions): InitResult {
	const env = options.env ?? process.env;
	const dryRun = options.dryRun === true;
	const vaultRoot = resolveUserPath(options.dir, options.cwd ?? process.cwd());
	const created: string[] = [];

	if (!dryRun) mkdirSync(vaultRoot, { recursive: true });

	const run = (): CompileResult => {
		if (options.example) created.push(...copyMissing(EXAMPLE_VAULT, vaultRoot, vaultRoot, dryRun));

		const fallback = join(vaultRoot, "general_instructions.md");
		if (!existsSync(fallback) && !created.includes("general_instructions.md")) {
			if (!dryRun) writeFileAtomic(fallback, FALLBACK_NOTE);
			created.push("general_instructions.md");
		}

		const ignore = join(vaultRoot, IGNORE_FILE);
		if (!existsSync(ignore)) {
			if (!dryRun) writeFileAtomic(ignore, IGNORE_TEMPLATE);
			created.push(IGNORE_FILE);
		}

		// A dry run of a directory that does not exist yet has nothing to scan.
		if (dryRun && !existsSync(vaultRoot)) {
			return {
				files: [],
				issues: [],
				counts: { branches: 1, leaves: created.filter((path) => path.endsWith(".md")).length },
				tree: {
					root: { kind: "branch", id: "", title: "", criteria: "", fallback: false, absolutePath: vaultRoot, path: ".", children: [], issues: [] },
					issues: [],
					counts: { branches: 1, leaves: 0 },
				},
			};
		}
		return compileVault(vaultRoot, { dryRun });
	};
	const compiled = dryRun ? run() : withVaultLock(vaultRoot, run);

	let configPath: string | undefined;
	if (options.saveConfig !== false) {
		configPath = userConfigPath(env);
		let current: Record<string, unknown> = {};
		if (existsSync(configPath)) {
			try {
				current = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
			} catch (error) {
				throw new Error(`could not parse ${configPath}: ${(error as Error).message}`);
			}
		}
		if (!dryRun) {
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileAtomic(configPath, JSON.stringify({ ...current, vaultRoot }, null, 2) + "\n");
		}
	}

	return { vaultRoot, created, configPath, compiled, dryRun };
}

export function renderInit(result: InitResult): string {
	const verb = result.dryRun ? "would be" : "";
	const written = result.compiled.files.filter((file) => file.status === "written");
	const errors = result.compiled.issues.filter((issue) => issue.severity === "error").length;
	const createdList =
		result.created.length > 8 ? `${result.created.slice(0, 8).join(", ")} and ${result.created.length - 8} more` : result.created.join(", ");
	return [
		result.dryRun ? `Dry run: nothing was written. For ${result.vaultRoot}:` : `Vault ready at ${result.vaultRoot}`,
		result.created.length
			? `  created   ${createdList}${verb ? ` (${verb} created)` : ""}`
			: "  created   nothing (existing files kept)",
		`  compiled  ${written.length} manifest(s) ${result.dryRun ? "would be written" : "written"}; ` +
			`${result.compiled.counts.branches} folder(s), ${result.compiled.counts.leaves} note(s)`,
		result.dryRun && written.length ? `            ${written.map((file) => file.path).join(", ")}` : "",
		result.configPath
			? `  config    vaultRoot ${result.dryRun ? "would be saved" : "saved"} to ${result.configPath}`
			: "  config    not saved (--no-config)",
		errors ? `\n${errors} problem(s) to fix - run \`brain-keeper doctor\`.` : "",
		result.dryRun ? "" : `\nList folders that are not part of the brain (Templates, Attachments…) in ${IGNORE_FILE}.`,
	]
		.filter(Boolean)
		.join("\n");
}
