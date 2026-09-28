/**
 * Reading and validating `_index.json` manifests.
 *
 * The traverser reads these instead of scanning the filesystem, so a hop costs
 * one stat plus a cached parse rather than a directory walk. brain-keeper
 * generates them from note frontmatter; nothing should hand-edit them.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { assertInsideVault, relativeToVault } from "./paths.js";
import type { ManifestEntry } from "./types.js";

export const MANIFEST_FILE = "_index.json";

/** The description file that gives a folder its routing criteria. */
export const ABOUT_FILE = "_about.md";

/**
 * The branching invariant. A decision model spreads a fixed option budget over
 * every label in a question (Laya reserves 192 tokens for all of them), so each
 * option gets too little room to describe itself above this.
 */
export const MAX_CHILDREN = 15;

/** Criteria shorter than this give the model too little to discriminate on. */
export const THIN_CRITERIA_WORDS = 4;
/** Criteria longer than this get cut by the option budget. */
export const VERBOSE_CRITERIA_WORDS = 40;

export function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

export class ManifestError extends Error {}

interface CacheRecord {
	/** mtime alone misses a rewrite on filesystems with coarse timestamps (FAT, some network shares). */
	mtimeMs: number;
	size: number;
	entries: ManifestEntry[];
}

/** A manifest kept together with the directory that owns it, so a
 * `targetPath` can never be resolved against the wrong parent. */
export interface LoadedManifest {
	dir: string;
	entries: ManifestEntry[];
}

export class ManifestStore {
	private cache = new Map<string, CacheRecord>();

	constructor(
		private readonly vaultRoot: string,
		private readonly watch: boolean = true,
	) {}

	/** Returns null when the directory has no manifest — a graceful stop, not an error. */
	load(dir: string): LoadedManifest | null {
		const absoluteDir = assertInsideVault(this.vaultRoot, dir, "directory");
		const path = resolve(absoluteDir, MANIFEST_FILE);

		let mtimeMs = 0;
		let size = 0;
		try {
			({ mtimeMs, size } = statSync(path));
		} catch {
			return null;
		}

		const cached = this.cache.get(path);
		if (cached && (!this.watch || (cached.mtimeMs === mtimeMs && cached.size === size))) {
			return { dir: absoluteDir, entries: cached.entries };
		}

		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new ManifestError(`${path}: invalid JSON (${(error as Error).message})`);
		}

		const entries = validateManifest(raw, path);
		this.cache.set(path, { mtimeMs, size, entries });
		return { dir: absoluteDir, entries };
	}

	resolveTarget(manifest: LoadedManifest, entry: ManifestEntry): string {
		return assertInsideVault(
			this.vaultRoot,
			resolve(manifest.dir, entry.targetPath),
			`target of entry '${entry.id}'`,
		);
	}

	relativeToVault(path: string): string {
		return relativeToVault(this.vaultRoot, path);
	}

	clear(): void {
		this.cache.clear();
	}
}

export function validateManifest(raw: unknown, source: string): ManifestEntry[] {
	if (!Array.isArray(raw)) {
		throw new ManifestError(`${source}: expected a JSON array of entries`);
	}

	const entries: ManifestEntry[] = [];
	const seen = new Set<string>();

	for (const [index, item] of raw.entries()) {
		const where = `${source}[${index}]`;
		if (typeof item !== "object" || item === null) {
			throw new ManifestError(`${where}: entry is not an object`);
		}
		const entry = item as Record<string, unknown>;

		for (const field of ["id", "type", "criteria", "targetPath"] as const) {
			if (typeof entry[field] !== "string" || (entry[field] as string).trim() === "") {
				throw new ManifestError(`${where}: missing or empty '${field}'`);
			}
		}

		if (entry.type !== "branch" && entry.type !== "leaf") {
			throw new ManifestError(`${where}: type must be 'branch' or 'leaf', got '${String(entry.type)}'`);
		}

		const id = (entry.id as string).trim();
		if (seen.has(id)) {
			// Duplicate ids make the probability map ambiguous and the chosen label
			// unresolvable — the traverser would pick the first match by accident.
			throw new ManifestError(`${where}: duplicate entry id '${id}'`);
		}
		seen.add(id);

		entries.push({
			id,
			type: entry.type,
			criteria: (entry.criteria as string).trim(),
			targetPath: (entry.targetPath as string).trim(),
			title: typeof entry.title === "string" ? entry.title : undefined,
			fallback: entry.fallback === true,
		});
	}

	if (entries.length === 0) {
		throw new ManifestError(`${source}: manifest is empty`);
	}

	return entries;
}

/** Non-fatal structural warnings, surfaced by the traverser's lint command. */
export function manifestWarnings(entries: ManifestEntry[], source: string): string[] {
	const warnings: string[] = [];

	if (entries.length > MAX_CHILDREN) {
		warnings.push(
			`${source}: ${entries.length} children exceeds the ${MAX_CHILDREN} limit; ` +
				`the decision model's option budget cannot describe them all. Split this node.`,
		);
	}

	const fallbacks = entries.filter((entry) => entry.fallback);
	if (fallbacks.length > 1) {
		warnings.push(`${source}: ${fallbacks.length} entries are marked as the fallback; mark exactly one.`);
	}

	for (const entry of entries) {
		const words = wordCount(entry.criteria);
		if (words < THIN_CRITERIA_WORDS) {
			warnings.push(
				`${source}: criteria for '${entry.id}' is ${words} word(s); ` +
					`aim for 10-25 words of distinct domain keywords.`,
			);
		}
		if (words > VERBOSE_CRITERIA_WORDS) {
			warnings.push(`${source}: criteria for '${entry.id}' is ${words} words; it will be truncated.`);
		}
	}

	return warnings;
}

/** Serialise entries the way brain-keeper writes them: stable key order, trailing newline. */
export function serialiseManifest(entries: ManifestEntry[]): string {
	const ordered = entries.map((entry) => {
		const out: Record<string, unknown> = {
			id: entry.id,
			type: entry.type,
			criteria: entry.criteria,
			targetPath: entry.targetPath,
		};
		if (entry.title) out.title = entry.title;
		if (entry.fallback) out.fallback = true;
		return out;
	});
	return JSON.stringify(ordered, null, 2) + "\n";
}
