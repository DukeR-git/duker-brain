/**
 * Per-session routing memory, shared by the two front ends: the Pi extension
 * (./extension.ts), which keeps it in memory, and the Claude Code hook
 * (./claude-hook.ts), which runs once per prompt and keeps it in a file.
 *
 * Both have to decide the same thing on every prompt: inject the routed guide,
 * or, when the same unchanged guide went in a few turns ago and is still in the
 * conversation, send a one-line reminder instead of another full copy.
 */

import { createHash } from "node:crypto";

import type { TraversalDocument, TraversalResult } from "../../brain-core/src/types.js";
import { formatInjection, formatReminder } from "./inject.js";

/** A guide already in the conversation: the turn it went in, and a hash of what was sent. */
export interface InjectedGuide {
	turn: number;
	hash: string;
}

export interface InjectionPlan {
	/** What to add to the conversation; null when there is nothing to add. */
	content: string | null;
	/** True when at least one guide went in as a reminder rather than in full. */
	repeat: boolean;
	/** The guides in this result, reminders included. */
	documents: TraversalDocument[];
}

/**
 * Trivial follow-up prompts that need no background manual (a one-word
 * confirmation, a greeting, "continue"). Short-circuiting them locally saves
 * the gate request, network round-trip, and avoids injecting noise.
 */
const TRIVIAL_PROMPT =
	/^(?:yes|yep|yeah|no|nope|ok|okay|sure|thanks|thank you|continue|proceed|go ahead|done|next|agree|looks good|lgtm)[.!]?$/i;

export function isTrivialFollowUp(prompt: string): boolean {
	const cleaned = prompt.replace(/\s+/g, " ").trim();
	return TRIVIAL_PROMPT.test(cleaned);
}

export function resultDocuments(result: TraversalResult): TraversalDocument[] {
	return result.documents && result.documents.length > 0 ? result.documents : result.document ? [result.document] : [];
}

/**
 * Decide what goes into the conversation for `result` on `turn`, and record
 * every guide sent in full in `injected`. A guide counts as a repeat when the
 * same path with the same content went in fewer than `reinjectAfterTurns`
 * turns ago; 0 re-injects every time.
 */
export function planInjection(
	result: TraversalResult,
	injected: Map<string, InjectedGuide>,
	turn: number,
	reinjectAfterTurns: number,
): InjectionPlan {
	const docs = resultDocuments(result);
	if (docs.length === 0) return { content: null, repeat: false, documents: docs };

	const statuses = docs.map((doc) => {
		const hash = createHash("sha1").update(doc.content).digest("hex");
		const previous = injected.get(doc.path);
		const repeat =
			reinjectAfterTurns > 0 && previous !== undefined && previous.hash === hash && turn - previous.turn < reinjectAfterTurns;
		return { doc, hash, repeat, previous };
	});

	const anyRepeat = statuses.some((status) => status.repeat);

	if (!anyRepeat) {
		for (const { doc, hash } of statuses) injected.set(doc.path, { turn, hash });
		return { content: formatInjection(result), repeat: false, documents: docs };
	}

	const blocks: string[] = [];
	for (const { doc, hash, repeat, previous } of statuses) {
		const single: TraversalResult = { ...result, document: doc, documents: [doc] };
		if (repeat && previous) {
			const reminder = formatReminder(single, turn - previous.turn);
			if (reminder) blocks.push(reminder);
		} else {
			const injection = formatInjection(single);
			if (injection) blocks.push(injection);
			injected.set(doc.path, { turn, hash });
		}
	}
	return { content: blocks.length > 0 ? blocks.join("\n\n") : null, repeat: true, documents: docs };
}
