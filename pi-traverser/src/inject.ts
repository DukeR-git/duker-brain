/**
 * Formatting the retrieved leaf into the block the agent's model actually reads.
 *
 * This goes in as an LLM-visible *message*, not as a system-prompt edit. Pi
 * replaces the entire system prompt for a turn when an extension returns one,
 * and diffs it into a cache miss - which on a large local model means
 * reprocessing the whole prefix on every prompt that routes somewhere new.
 * Appending a message leaves the provider's prefix cache intact.
 */

import type { TraversalDocument, TraversalResult } from "../../brain-core/src/types.js";

export const CUSTOM_TYPE = "brain-traverse";

function formatSingleDocument(
	document: TraversalDocument,
	provenance: string,
	index?: { current: number; total: number },
): string {
	const guideLabel = index ? `Reference Guide ${index.current}/${index.total}` : "Reference Guide";
	const header = [
		`[${guideLabel}: ${document.title}]`,
		`Source: ${document.path} — routed via ${provenance}`,
		"This is background reference material selected automatically for the prompt above.",
		"Use it where it applies. If it is not relevant to what was asked, ignore it.",
	].join("\n");

	const footer = document.truncated
		? `[End ${guideLabel} — truncated: showing ${document.content.length} of ${document.originalLength} characters]`
		: `[End ${guideLabel}]`;

	return `${header}\n\n${document.content}\n\n${footer}`;
}

/**
 * The block is explicitly framed as reference material rather than instruction,
 * so the model treats a mis-routed guide as something to ignore instead of
 * something to obey.
 */
export function formatInjection(result: TraversalResult): string | null {
	const docs =
		result.documents && result.documents.length > 0
			? result.documents
			: result.document
				? [result.document]
				: [];
	if (docs.length === 0) return null;

	if (docs.length === 1) {
		const document = docs[0];
		const confidence = result.hops.length ? result.minConfidence.toFixed(2) : "n/a";
		const provenance =
			result.status === "fallback"
				? `fallback guide (${result.reason})`
				: `${result.trail}, min confidence ${confidence}`;
		return formatSingleDocument(document, provenance);
	}

	const formatted = docs.map((doc, i) => {
		const docTrail = doc.trail ?? result.trail;
		const docConf = doc.confidence !== undefined ? doc.confidence.toFixed(2) : result.minConfidence.toFixed(2);
		const provenance = `${docTrail}, min confidence ${docConf}`;
		return formatSingleDocument(doc, provenance, { current: i + 1, total: docs.length });
	});

	return formatted.join("\n\n");
}

/**
 * What goes in instead of a guide the conversation already holds: one line, so
 * a long session on one topic does not carry the same document ten times over.
 */
export function formatReminder(result: TraversalResult, turnsAgo: number): string | null {
	const docs =
		result.documents && result.documents.length > 0
			? result.documents
			: result.document
				? [result.document]
				: [];
	if (docs.length === 0) return null;

	if (docs.length === 1) {
		const document = docs[0];
		return (
			`[Reference Guide: ${document.title} — already provided ${turnsAgo} turn(s) ago (Source: ${document.path}); ` +
			`it still applies to this prompt.]`
		);
	}

	return docs
		.map(
			(document) =>
				`[Reference Guide: ${document.title} — already provided ${turnsAgo} turn(s) ago (Source: ${document.path}); ` +
				`it still applies to this prompt.]`,
		)
		.join("\n");
}

/** One-line trace for the debug console and the CLI. */
export function formatTrace(result: TraversalResult): string {
	const hops = result.hops
		.map((hop) => {
			const act = hop.actProbability === undefined ? "" : `, act ${hop.actProbability.toFixed(2)}`;
			return `${hop.chosen}(${hop.confidence.toFixed(2)}${act}, ${Math.round(hop.latencyMs)}ms)`;
		})
		.join(" -> ");

	const parts = [`${result.status}${result.cached ? " (cache)" : ""}`];
	if (result.gate) parts.push(`gate=${result.gate.probability.toFixed(2)}`);
	if (hops) parts.push(hops);
	parts.push(`${Math.round(result.totalMs)}ms total`);

	const docs =
		result.documents && result.documents.length > 0
			? result.documents
			: result.document
				? [result.document]
				: [];
	if (docs.length > 1) {
		parts.push(docs.map((d) => d.path).join(" + "));
	} else if (docs.length === 1) {
		parts.push(docs[0].path);
	}

	if (result.status !== "leaf" && result.status !== "composite") parts.push(`(${result.reason})`);
	if (result.warnings?.length) parts.push(`service warnings: ${result.warnings.join("; ")}`);

	return parts.join(" | ");
}

/** Compact status line for Pi's footer. */
export function formatStatus(result: TraversalResult): string {
	const cacheTag = result.cached ? " (cache)" : "";
	switch (result.status) {
		case "leaf":
			return `brain: ${result.document?.id ?? "?"} ${result.minConfidence.toFixed(2)}${cacheTag} ${Math.round(result.totalMs)}ms`;
		case "composite": {
			const docs =
				result.documents && result.documents.length > 0
					? result.documents
					: result.document
						? [result.document]
						: [];
			const ids = docs.map((d) => d.id).join("+");
			return `brain: ${ids} ${result.minConfidence.toFixed(2)}${cacheTag} ${Math.round(result.totalMs)}ms`;
		}
		case "fallback":
			return `brain: fallback${cacheTag} ${Math.round(result.totalMs)}ms`;
		case "skipped":
			return `brain: no guide needed${cacheTag}`;
		default:
			return `brain: ${result.status}`;
	}
}
