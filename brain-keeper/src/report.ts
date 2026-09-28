/**
 * Turning vault state into text an agent (or a person) can act on.
 *
 * Tool results are read by a model, so every report leads with the thing that
 * needs doing and states the remedy as an action. A wall of neutral facts costs
 * tokens and produces no next step.
 */

import { MAX_CHILDREN } from "../../brain-core/src/manifest.js";
import type { VaultIssue, VaultNode } from "../../brain-core/src/types.js";
import type { ChangeSet, SearchHit } from "./operations.js";

const SEVERITY_MARK = { error: "ERROR", warning: "warn ", info: "info " } as const;

export function renderTree(root: VaultNode, options: { maxDepth?: number; criteria?: boolean } = {}): string {
	const lines: string[] = [];
	const maxDepth = options.maxDepth ?? 3;

	const walk = (node: VaultNode, depth: number, prefix: string, last: boolean) => {
		if (depth > 0) {
			const connector = last ? "└─ " : "├─ ";
			const count = node.kind === "branch" ? ` (${node.children?.length ?? 0})` : "";
			const over =
				node.kind === "branch" && (node.children?.length ?? 0) > MAX_CHILDREN ? "  <-- over the limit" : "";
			const flags = node.fallback ? " [fallback]" : "";
			lines.push(`${prefix}${connector}${node.id}${count}${flags}${over}`);
			if (options.criteria) {
				lines.push(`${prefix}${last ? "   " : "│  "}   ${node.criteria}`);
			}
		} else {
			lines.push(`. (${node.children?.length ?? 0})`);
		}

		if (node.kind !== "branch" || depth >= maxDepth) return;
		const children = node.children ?? [];
		const childPrefix = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
		children.forEach((child, index) => walk(child, depth + 1, childPrefix, index === children.length - 1));
	};

	walk(root, 0, "", true);
	return lines.join("\n");
}

export function renderIssues(issues: VaultIssue[], limit = 40): string {
	if (issues.length === 0) return "No issues found.";

	const errors = issues.filter((issue) => issue.severity === "error").length;
	const warnings = issues.filter((issue) => issue.severity === "warning").length;
	const lines = [`${errors} error(s), ${warnings} warning(s):`, ""];

	for (const issue of issues.slice(0, limit)) {
		lines.push(`${SEVERITY_MARK[issue.severity]} ${issue.path} [${issue.code}]`);
		lines.push(`      ${issue.message}`);
		if (issue.remedy) lines.push(`      fix: ${issue.remedy}`);
	}

	if (issues.length > limit) lines.push(`... and ${issues.length - limit} more`);
	return lines.join("\n");
}

export function renderChangeSet(result: ChangeSet): string {
	const lines = [result.summary, ""];

	if (result.changes.length) {
		lines.push("Files:");
		for (const change of result.changes) {
			const arrow = change.from ? `${change.from} -> ${change.path}` : change.path;
			lines.push(`  ${change.action.padEnd(8)} ${arrow}${change.detail ? `  (${change.detail})` : ""}`);
		}
		lines.push("");
	}

	if (result.manifests.length) {
		lines.push("Manifests rebuilt:");
		for (const file of result.manifests) {
			lines.push(`  ${file.status.padEnd(9)} ${file.path}  (${file.entries} entries)${file.reason ? `; ${file.reason}` : ""}`);
		}
		lines.push("");
	} else if (result.changes.length) {
		lines.push("Manifests: no change needed.", "");
	}

	if (result.warnings.length) {
		lines.push("Warnings:");
		for (const warning of result.warnings) lines.push(`  ! ${warning}`);
		lines.push("");
	}

	const errors = result.issues.filter((issue) => issue.severity === "error");
	if (errors.length) {
		lines.push(`Vault now has ${errors.length} error(s) — run brain_doctor for the full report:`);
		for (const issue of errors.slice(0, 5)) lines.push(`  ${issue.path}: ${issue.message}`);
	}

	return lines.join("\n").trimEnd();
}

export function renderSearch(query: string, hits: SearchHit[]): string {
	if (hits.length === 0) return `Nothing in the brain matches "${query}".`;
	const lines = [`${hits.length} match(es) for "${query}", best first:`, ""];
	for (const hit of hits) {
		lines.push(`${hit.kind === "branch" ? "folder" : "note  "} ${hit.path}  (${hit.title}; score ${hit.score})`);
		lines.push(`       criteria: ${hit.criteria}`);
		if (hit.snippet) lines.push(`       "${hit.snippet}"`);
	}
	return lines.join("\n");
}
