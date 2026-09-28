/**
 * Semantic route cache & sub-millisecond memoization.
 *
 * Caches traversal results for prompts across turns and sessions.
 * Invalidation is automatic: cache entries carry a fingerprint of all
 * `_index.json` manifests in the vault. If any note or folder criteria
 * changes, the fingerprint changes, invalidating stale cache entries.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeFileAtomic } from "./fsutil.js";
import { MANIFEST_FILE } from "./manifest.js";
import type { TraversalResult } from "./types.js";

export const CACHE_FILE = ".brain.cache.json";
export const DEFAULT_MAX_CACHE_ENTRIES = 500;

export interface CacheEntry {
	queryHash: string;
	normalizedPrompt: string;
	fingerprint: string;
	result: TraversalResult;
	createdAt: number;
	hits: number;
}

export interface SerializedCache {
	version: number;
	fingerprint: string;
	entries: Record<string, CacheEntry>;
}

export interface CacheStats {
	hits: number;
	misses: number;
	size: number;
	evictions: number;
}

/**
 * Normalizes prompt text for consistent cache lookup:
 * - Lowercases and trims
 * - Collapses multiple whitespaces into a single space
 * - Strips leading/trailing punctuation
 */
export function normalizePrompt(prompt: string): string {
	return prompt
		.toLowerCase()
		.trim()
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.replace(/^[\s.,!?;:()"'`]+|[\s.,!?;:()"'`]+$/g, "");
}

/** Computes a SHA-256 hash of the normalized prompt. */
export function hashPrompt(normalized: string): string {
	return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Computes a fingerprint representing the state of all `_index.json` manifests in the vault.
 * Fast stat-only check: reads size and mtimeMs of every manifest.
 */
export function computeVaultFingerprint(vaultRoot: string): string {
	const records: string[] = [];

	function scan(dir: string) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const name of entries) {
			if (name === ".git" || name === "node_modules" || name === ".trash" || name.startsWith(".")) {
				continue;
			}
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				scan(full);
			} else if (name === MANIFEST_FILE) {
				const rel = full.slice(vaultRoot.length).replace(/\\/g, "/");
				records.push(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}`);
			}
		}
	}

	scan(vaultRoot);
	records.sort();
	return createHash("sha256").update(records.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Two-tier route cache: L1 in-memory Map + L2 disk persistence.
 */
export class RouteCache {
	private readonly memory = new Map<string, CacheEntry>();
	private loadedVaultRoot: string | null = null;
	private currentFingerprint: string | null = null;
	private fingerprintMtime: number = 0;
	private hits = 0;
	private misses = 0;
	private evictions = 0;

	constructor(private readonly maxEntries: number = DEFAULT_MAX_CACHE_ENTRIES) {}

	/**
	 * Looks up a cached traversal result for the given prompt in the vault.
	 * Returns null on miss or when cache is invalid.
	 */
	get(prompt: string, vaultRoot: string): TraversalResult | null {
		const norm = normalizePrompt(prompt);
		if (!norm) return null;

		const qHash = hashPrompt(norm);
		const fp = this.getOrUpdateFingerprint(vaultRoot);

		this.ensureLoaded(vaultRoot);

		const entry = this.memory.get(qHash);
		if (!entry) {
			this.misses++;
			return null;
		}

		if (entry.fingerprint !== fp) {
			this.memory.delete(qHash);
			this.misses++;
			return null;
		}

		entry.hits++;
		this.hits++;

		// Refresh LRU order: delete and re-insert at end of Map
		this.memory.delete(qHash);
		this.memory.set(qHash, entry);

		// Return a fresh clone with cached: true and negligible latency
		const cloned: TraversalResult = JSON.parse(JSON.stringify(entry.result));
		cloned.cached = true;
		cloned.totalMs = 0.5;
		return cloned;
	}

	/**
	 * Stores a successful traversal result in the cache.
	 * Only caches stable outcomes ("leaf", "fallback", "skipped").
	 */
	set(prompt: string, vaultRoot: string, result: TraversalResult): void {
		if (
			result.status !== "leaf" &&
			result.status !== "composite" &&
			result.status !== "fallback" &&
			result.status !== "skipped"
		) {
			return;
		}

		const norm = normalizePrompt(prompt);
		if (!norm) return;

		const qHash = hashPrompt(norm);
		const fp = this.getOrUpdateFingerprint(vaultRoot);

		this.ensureLoaded(vaultRoot);

		// LRU eviction if full
		if (this.memory.size >= this.maxEntries && !this.memory.has(qHash)) {
			const oldestKey = this.memory.keys().next().value;
			if (oldestKey) {
				this.memory.delete(oldestKey);
				this.evictions++;
			}
		}

		const entry: CacheEntry = {
			queryHash: qHash,
			normalizedPrompt: norm,
			fingerprint: fp,
			result: JSON.parse(JSON.stringify(result)),
			createdAt: Date.now(),
			hits: 0,
		};

		this.memory.delete(qHash);
		this.memory.set(qHash, entry);
		this.persistToDisk(vaultRoot);
	}

	/** Clears in-memory and disk cache for the vault. */
	clear(vaultRoot?: string): void {
		this.memory.clear();
		this.hits = 0;
		this.misses = 0;
		this.evictions = 0;
		this.currentFingerprint = null;
		this.fingerprintMtime = 0;

		if (vaultRoot) {
			const diskPath = join(vaultRoot, CACHE_FILE);
			try {
				if (existsSync(diskPath)) {
					writeFileAtomic(diskPath, JSON.stringify({ version: 1, fingerprint: "", entries: {} }, null, 2));
				}
			} catch {
				// Non-fatal if disk clear fails
			}
		}
	}

	getStats(): CacheStats {
		return {
			hits: this.hits,
			misses: this.misses,
			size: this.memory.size,
			evictions: this.evictions,
		};
	}

	private getOrUpdateFingerprint(vaultRoot: string): string {
		const now = Date.now();
		// Cache fingerprint calculation for 1.5 seconds to avoid hammering filesystem
		if (this.currentFingerprint && now - this.fingerprintMtime < 1500) {
			return this.currentFingerprint;
		}
		this.currentFingerprint = computeVaultFingerprint(vaultRoot);
		this.fingerprintMtime = now;
		return this.currentFingerprint;
	}

	private ensureLoaded(vaultRoot: string): void {
		if (this.loadedVaultRoot === vaultRoot) return;
		this.loadedVaultRoot = vaultRoot;
		this.loadFromDisk(vaultRoot);
	}

	private loadFromDisk(vaultRoot: string): void {
		const diskPath = join(vaultRoot, CACHE_FILE);
		if (!existsSync(diskPath)) return;

		try {
			const content = readFileSync(diskPath, "utf8");
			const parsed = JSON.parse(content) as SerializedCache;
			if (parsed.version !== 1 || !parsed.entries) return;

			const fp = this.getOrUpdateFingerprint(vaultRoot);
			for (const [key, entry] of Object.entries(parsed.entries)) {
				if (entry && entry.fingerprint === fp) {
					this.memory.set(key, entry);
				}
			}
		} catch {
			// Corrupt cache file: ignore and overwrite on next write
		}
	}

	private persistToDisk(vaultRoot: string): void {
		const diskPath = join(vaultRoot, CACHE_FILE);
		const entriesObj: Record<string, CacheEntry> = {};
		for (const [k, v] of this.memory.entries()) {
			entriesObj[k] = v;
		}

		const data: SerializedCache = {
			version: 1,
			fingerprint: this.currentFingerprint ?? "",
			entries: entriesObj,
		};

		try {
			writeFileAtomic(diskPath, JSON.stringify(data, null, 2));
		} catch {
			// Atomic write failed: non-fatal, cache remains in-memory
		}
	}
}

/** Global default route cache singleton. */
export const defaultRouteCache = new RouteCache();
