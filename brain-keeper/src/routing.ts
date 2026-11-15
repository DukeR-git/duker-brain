/**
 * Routing feedback: does the brain actually find what you just put in it?
 *
 * This runs the *real* traverser from brain-core with the *real* settings —
 * the same config the router loads — rather than a lookalike. The whole value
 * of the check is fidelity: a second implementation, or the same one with
 * different thresholds, that agreed with itself but not with pi-traverser
 * would be worse than no check at all.
 *
 * It is the closing half of the improvement loop: edit criteria, then ask
 * whether a prompt that should reach a note now reaches it.
 */

import { DecisionsClient } from "../../brain-core/src/decisions-client.js";
import { Logger } from "../../brain-core/src/logger.js";
import { BrainTraverser, type TraverserOptions } from "../../brain-core/src/traverser.js";
import type { TraversalResult } from "../../brain-core/src/types.js";
import type { KeeperConfig } from "./config.js";

export interface RoutingCheck {
	prompt: string;
	expected?: string;
	result: TraversalResult;
	/** Present when `expected` was supplied. */
	matched?: boolean;
}

/**
 * `placement` (the default) is the authoring check described below; `route` is
 * the router exactly as configured, gate, fallback and full note body included.
 */
export function createTraverser(
	config: KeeperConfig,
	vaultRoot: string,
	mode: "placement" | "route" = "placement",
): BrainTraverser {
	const logger = new Logger(config.logLevel);
	const client = new DecisionsClient({
		baseUrl: config.decisionsUrl,
		path: config.decisionsPath,
		apiKey: config.apiKey,
		model: config.model,
		timeoutMs: config.timeoutMs,
		retries: config.retries,
		logger,
	});

	// Everything the router uses at prompt time, except three deliberate changes
	// that make the check about *placement*: no gate (the question is where a
	// prompt lands, not whether a guide is wanted), no fallback (a fallback is
	// not the note you meant to reach), and the document body is not needed.
	// A traverser lives for one call here, so there is nothing to watch.
	if (mode === "route") return new BrainTraverser({ ...config, vaultRoot, watchManifests: false }, client, logger);

	const options: TraverserOptions = {
		vaultRoot,
		maxHops: config.maxHops,
		minConfidence: config.minConfidence,
		gateEnabled: false,
		gateThreshold: config.gateThreshold,
		fallbackDocument: "",
		maxDocumentChars: 200,
		maxPromptChars: config.maxPromptChars,
		watchManifests: false,
		routeBudgetMs: config.routeBudgetMs,
	};

	return new BrainTraverser(options, client, logger);
}

export async function checkRouting(
	config: KeeperConfig,
	vaultRoot: string,
	prompts: { prompt: string; expected?: string }[],
): Promise<RoutingCheck[]> {
	const traverser = createTraverser(config, vaultRoot);
	const checks: RoutingCheck[] = [];

	// One at a time: a burst of twenty requests is how a hosted API earns you a 429.
	for (const { prompt, expected } of prompts) {
		const result = await traverser.route(prompt);
		const docs =
			result.documents && result.documents.length > 0
				? result.documents
				: result.document
					? [result.document]
					: [];
		const matched =
			expected === undefined
				? undefined
				: docs.some((d) => d.id === expected || d.path === expected.replace(/\\/g, "/"));
		checks.push({ prompt, expected, result, matched });
	}

	return checks;
}

export function renderRoutingChecks(checks: RoutingCheck[]): string {
	const lines: string[] = [];
	let failures = 0;

	for (const check of checks) {
		const { result } = check;
		const docs =
			result.documents && result.documents.length > 0
				? result.documents
				: result.document
					? [result.document]
					: [];
		const landed =
			docs.length > 1
				? docs.map((d) => `${d.id} (${d.path})`).join(" + ")
				: docs.length === 1
					? `${docs[0].id} (${docs[0].path})`
					: `<${result.status}>`;
		const mark = check.matched === undefined ? "  " : check.matched ? "ok" : "NO";
		if (check.matched === false) failures++;

		lines.push(`${mark} "${check.prompt}"`);
		lines.push(`     -> ${landed}  conf=${result.minConfidence.toFixed(3)}  ${Math.round(result.totalMs)}ms`);
		if (check.expected !== undefined && check.matched === false) {
			lines.push(`     expected ${check.expected}`);
		}
		if (result.status !== "leaf" && result.status !== "composite") {
			lines.push(`     ${result.reason}`);
		}

		for (const hop of result.hops) {
			const ranked = Object.entries(hop.probabilities ?? {})
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([label, probability]) => `${label}=${probability.toFixed(2)}`)
				.join("  ");
			lines.push(`     hop ${hop.from || "."} -> ${hop.chosen} (${hop.confidence.toFixed(2)})   ${ranked}`);
		}
		lines.push("");
	}

	if (checks.some((check) => check.matched !== undefined)) {
		lines.push(failures === 0 ? "All expectations met." : `${failures} of ${checks.length} went elsewhere.`);
		if (failures > 0) {
			lines.push(
				"When a prompt lands in the wrong place the criteria are usually the problem, not the tree: " +
					"rewrite the losing note's criteria to name the terms that appeared in the prompt, " +
					"and the winning note's to exclude them.",
			);
		}
	}

	return lines.join("\n").trimEnd();
}

/** The routed note(s) as the text an agent reads, or why there is none. */
export function renderRoute(result: TraversalResult): string {
	const docs = result.documents?.length ? result.documents : result.document ? [result.document] : [];
	if (docs.length === 0) return `No guide for this prompt (${result.status}): ${result.reason}`;

	return docs
		.map((doc) => {
			const provenance =
				result.status === "fallback"
					? `catch-all guide (${result.reason})`
					: `${doc.trail ?? result.trail}, confidence ${(doc.confidence ?? result.minConfidence).toFixed(2)}`;
			return [
				`[Reference Guide: ${doc.title}]`,
				`Source: ${doc.path} — ${provenance}`,
				"Background reference selected for the prompt. Use it where it applies; ignore it if it is not about what was asked.",
				"",
				doc.content,
				"",
				doc.truncated
					? `[End Reference Guide — truncated: ${doc.content.length} of ${doc.originalLength} characters; brain_get_note has the rest]`
					: "[End Reference Guide]",
			].join("\n");
		})
		.join("\n\n");
}
