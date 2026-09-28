/**
 * The routing log: one JSON line per routed prompt, so criteria can be tuned
 * from evidence rather than guesswork.
 *
 * It stores a hash of the prompt, never the prompt itself — the log is for
 * questions like "which notes are never reached?" and "where are hops close
 * calls?", and those need the trail and the probabilities, not the text.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveUserPath } from "./env.js";
import type { TraversalResult, VaultNode } from "./types.js";
import { flatten } from "./vault.js";

/** Rotate to `<file>.1` past this size, keeping one old generation. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Two options this close in probability are a coin toss the criteria should resolve. */
export const NEAR_TIE = 0.1;

export interface RouteRecord {
	ts: string;
	/** First 12 hex chars of the prompt's SHA-1: enough to spot repeats, useless for recovering text. */
	prompt: string;
	chars: number;
	status: TraversalResult["status"];
	trail: string;
	path?: string;
	gate?: number;
	totalMs: number;
	reason?: string;
	hops: { from: string; chosen: string; confidence: number; runnerUp?: string; gap?: number; options: number }[];
}

/** `"auto"` -> the per-user state directory; `""` -> no log; anything else is a path. */
export function resolveRouteLogPath(setting: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
	const value = setting.trim();
	if (!value) return undefined;
	if (value !== "auto") return resolveUserPath(value, cwd);
	const base = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
	return join(base, "brain-traverse", "routes.jsonl");
}

export function toRouteRecord(prompt: string, result: TraversalResult): RouteRecord {
	return {
		ts: new Date().toISOString(),
		prompt: createHash("sha1").update(prompt).digest("hex").slice(0, 12),
		chars: prompt.length,
		status: result.status,
		trail: result.trail,
		path: result.document?.path,
		gate: result.gate?.probability,
		totalMs: Math.round(result.totalMs),
		reason: result.status === "leaf" ? undefined : result.reason,
		hops: result.hops.map((hop) => {
			const ranked = Object.entries(hop.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
			const runnerUp = ranked.find(([label]) => label !== hop.chosen);
			return {
				from: hop.from,
				chosen: hop.chosen,
				confidence: Number(hop.confidence.toFixed(4)),
				runnerUp: runnerUp?.[0],
				gap: runnerUp ? Number((hop.confidence - runnerUp[1]).toFixed(4)) : undefined,
				options: hop.optionCount,
			};
		}),
	};
}

/** Append one record. Never throws: a full disk must not cost the user a turn. */
export function appendRouteLog(path: string, record: RouteRecord): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
		appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
	} catch {
		/* logging is best effort */
	}
}

export function readRouteLog(path: string): RouteRecord[] {
	const records: RouteRecord[] = [];
	for (const file of [`${path}.1`, path]) {
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line) as RouteRecord);
			} catch {
				/* a torn line from a crash; skip it */
			}
		}
	}
	return records;
}

/** A report over the log: what routes where, what is never reached, and where hops are close calls. */
export function renderRouteStats(records: RouteRecord[], root?: VaultNode): string {
	if (records.length === 0) return "The routing log is empty: nothing has been routed since it was enabled.";

	const lines: string[] = [];
	const statuses = new Map<string, number>();
	for (const record of records) statuses.set(record.status, (statuses.get(record.status) ?? 0) + 1);
	lines.push(
		`${records.length} routed prompt(s) since ${records[0].ts.slice(0, 10)}`,
		`  ${[...statuses].sort((a, b) => b[1] - a[1]).map(([status, count]) => `${status}=${count}`).join("  ")}`,
		"",
	);

	const hits = new Map<string, number>();
	for (const record of records) if (record.path) hits.set(record.path, (hits.get(record.path) ?? 0) + 1);
	lines.push("Most injected:");
	for (const [path, count] of [...hits].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`  ${String(count).padStart(5)}  ${path}`);
	lines.push("");

	if (root) {
		const never = flatten(root)
			.filter((node) => node.kind === "leaf" && !hits.has(node.path))
			.map((node) => node.path);
		lines.push(never.length ? `Never injected (${never.length}) - check their criteria:` : "Every note has been injected at least once.");
		for (const path of never.slice(0, 25)) lines.push(`  ${path}`);
		if (never.length > 25) lines.push(`  ... and ${never.length - 25} more`);
		lines.push("");
	}

	const weak = new Map<string, number>();
	const ties = new Map<string, number>();
	for (const record of records) {
		// Routing gives up at its last hop; the hops before it were confident.
		const last = record.hops[record.hops.length - 1];
		if (last && (record.status === "low-confidence" || record.status === "fallback")) {
			weak.set(last.from, (weak.get(last.from) ?? 0) + 1);
		}
		for (const hop of record.hops) {
			if (hop.runnerUp && hop.gap !== undefined && hop.gap < NEAR_TIE) {
				const pair = `${hop.from}: ${[hop.chosen, hop.runnerUp].sort().join(" vs ")}`;
				ties.set(pair, (ties.get(pair) ?? 0) + 1);
			}
		}
	}
	if (weak.size) {
		lines.push("Folders where routing most often gave up:");
		for (const [folder, count] of [...weak].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`  ${String(count).padStart(5)}  ${folder}`);
		lines.push("");
	}
	if (ties.size) {
		lines.push(`Near ties (top two within ${NEAR_TIE}) - sharpen these criteria against each other:`);
		for (const [pair, count] of [...ties].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`  ${String(count).padStart(5)}  ${pair}`);
	}

	return lines.join("\n").trimEnd();
}
