/**
 * Universal Rules Exporter (brain export).
 *
 * Translates an Obsidian brain vault into rules and configuration formats
 * for external coding assistants: Cursor (.cursor/rules/*.mdc), Windsurf (.windsurfrules),
 * Aider (.aider.conf.yml), and clean markdown bundles.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { splitFrontmatter } from "./frontmatter.js";
import { writeFileAtomic } from "./fsutil.js";
import { scanVault } from "./vault.js";
import type { ExportFormat, ExportOptions, ExportResult, VaultNode } from "./types.js";

interface CollectedNote {
	id: string;
	title: string;
	criteria: string;
	path: string;
	absolutePath: string;
	body: string;
	globs?: string;
}

/**
 * Exports vault notes to the specified target assistant format.
 */
export async function exportVault(
	vaultRoot: string,
	format: ExportFormat,
	outDir: string,
	options: ExportOptions = {},
): Promise<ExportResult> {
	const tree = scanVault(vaultRoot);
	const notes: CollectedNote[] = [];

	function collectLeaves(node: VaultNode) {
		if (node.kind === "leaf") {
			try {
				const raw = readFileSync(node.absolutePath, "utf8");
				const parsed = splitFrontmatter(raw);
				notes.push({
					id: node.id,
					title: node.title || node.id,
					criteria: node.criteria,
					path: node.path,
					absolutePath: node.absolutePath,
					body: parsed.body.trim(),
				});
			} catch {
				// Skip unreadable files
			}
		} else if (node.children) {
			for (const child of node.children) {
				collectLeaves(child);
			}
		}
	}

	collectLeaves(tree.root);

	const resolvedOutDir = resolve(outDir);
	const filesWritten: string[] = [];

	switch (format) {
		case "cursor": {
			// Write .cursor/rules/<id>.mdc files
			for (const note of notes) {
				const filename = `${note.id}.mdc`;
				const targetPath = join(resolvedOutDir, filename);
				const content = renderCursorMdc(note);
				filesWritten.push(targetPath);

				if (!options.dryRun) {
					mkdirSync(dirname(targetPath), { recursive: true });
					writeFileAtomic(targetPath, content);
				}
			}
			break;
		}

		case "windsurf": {
			// Write single .windsurfrules file
			const targetFile = resolvedOutDir.endsWith(".windsurfrules")
				? resolvedOutDir
				: join(resolvedOutDir, ".windsurfrules");
			const content = renderWindsurfRules(notes);
			filesWritten.push(targetFile);

			if (!options.dryRun) {
				mkdirSync(dirname(targetFile), { recursive: true });
				writeFileAtomic(targetFile, content);
			}
			break;
		}

		case "aider": {
			// Write .aider.conf.yml plus clean copies in a reference docs/ folder
			const docsDir = join(resolvedOutDir, ".brain-docs");
			const relativeDocPaths: string[] = [];

			for (const note of notes) {
				const targetPath = join(docsDir, note.path);
				const content = `# ${note.title}\n\n${note.body}\n`;
				filesWritten.push(targetPath);
				relativeDocPaths.push(`.brain-docs/${note.path.replace(/\\/g, "/")}`);

				if (!options.dryRun) {
					mkdirSync(dirname(targetPath), { recursive: true });
					writeFileAtomic(targetPath, content);
				}
			}

			const confPath = join(resolvedOutDir, ".aider.conf.yml");
			const aiderConfig = [
				"# Aider configuration generated from brain-traverse vault",
				"read:",
				...relativeDocPaths.map((p) => `  - ${p}`),
				"",
			].join("\n");
			filesWritten.push(confPath);

			if (!options.dryRun) {
				mkdirSync(dirname(confPath), { recursive: true });
				writeFileAtomic(confPath, aiderConfig);
			}
			break;
		}

		case "bundle": {
			// Export clean markdown documents with a Table of Contents index
			for (const note of notes) {
				const targetPath = join(resolvedOutDir, note.path);
				const content = `# ${note.title}\n\n${note.body}\n`;
				filesWritten.push(targetPath);

				if (!options.dryRun) {
					mkdirSync(dirname(targetPath), { recursive: true });
					writeFileAtomic(targetPath, content);
				}
			}

			// Generate README.md index
			const indexPath = join(resolvedOutDir, "README.md");
			const indexLines = [
				"# Reference Guides Index",
				"",
				"This bundle was generated from the knowledge vault by `brain-keeper export`.",
				"",
				"| Document | Criteria / Scope |",
				"|---|---|",
				...notes.map((n) => `| [${n.title}](${n.path.replace(/\\/g, "/")}) | ${n.criteria} |`),
				"",
			];
			filesWritten.push(indexPath);

			if (!options.dryRun) {
				mkdirSync(dirname(indexPath), { recursive: true });
				writeFileAtomic(indexPath, indexLines.join("\n"));
			}
			break;
		}
	}

	return {
		format,
		outDir: resolvedOutDir,
		filesWritten,
		noteCount: notes.length,
		dryRun: Boolean(options.dryRun),
	};
}

function renderCursorMdc(note: CollectedNote): string {
	const globs = deriveGlobs(note.path);
	return [
		"---",
		`description: ${note.title} - ${note.criteria}`,
		`globs: ${globs}`,
		"alwaysApply: false",
		"---",
		`# ${note.title}`,
		"",
		note.body,
		"",
	].join("\n");
}

function renderWindsurfRules(notes: CollectedNote[]): string {
	const sections: string[] = [
		"# Reference Rules & Architecture Guidelines",
		"",
		"<!-- Generated from Brain Vault by brain-keeper export -->",
		"",
	];

	for (const note of notes) {
		sections.push(`## ${note.title} (${note.id})`);
		sections.push(`> **Criteria**: ${note.criteria}`);
		sections.push("");
		sections.push(note.body);
		sections.push("");
		sections.push("---");
		sections.push("");
	}

	return sections.join("\n");
}

function deriveGlobs(relPath: string): string {
	const lower = relPath.toLowerCase().replace(/\\/g, "/");
	if (lower.includes("backend")) {
		return "**/*.py, **/*.ts, **/*.js, **/*.go, **/*.rs";
	}
	if (lower.includes("frontend")) {
		return "**/*.tsx, **/*.jsx, **/*.vue, **/*.svelte, **/*.css, **/*.html";
	}
	if (lower.includes("infra") || lower.includes("docker") || lower.includes("deploy")) {
		return "**/Dockerfile*, **/docker-compose*, **/*.ya?ml, **/*.sh";
	}
	return "**/*";
}
