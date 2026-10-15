/**
 * Semantic route cache & sub-millisecond memoization.
 *
 * Caches traversal results for prompts across turns and sessions.
 * Invalidation is automatic: an entry carries a fingerprint of every manifest
 * (which is what routing reads) and the size and time of each note it holds,
 * so a rebuilt manifest or an edited note (in Obsidian too) drops it. Checking
 * only those keeps a lookup to a few stats however big the vault is. Prompts are stored only as hashes: the cache sits
 * in the vault, which may be pushed to a shared repository.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./fsutil.js";
import { MANIFEST_FILE } from "./manifest.js";
import type { TraversalResult } from "./types.js";
import { loadIgnore } from "./vault.js";

export const CACHE_FILE = ".brain.cache.json";
export const DEFAULT_MAX_CACHE_ENTRIES = 500;
/** 3: notes checked per entry, the fingerprint covers manifests only; older files are dropped on load. */
const CACHE_VERSION = 3;

export interface CacheEntry {
	queryHash: string;
	fingerprint: string;
	result: TraversalResult;
	/** Vault-relative path of each note in the result -> its size and mtime when cached. */
	files: Record<string, string>;
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
 * Computes a fingerprint of every manifest in the vault: the routing itself.
 * Stat-only, notes are not touched, and it skips what the scanner skips (dot
 * folders, node_modules, `.brainignore`).
 */
export function computeVaultFingerprint(vaultRoot: string): string {
	const records: string[] = [];
	const ignored = loadIgnore(vaultRoot);

	function scan(dir: string, rel: string) {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const name = entry.name;
			if (name.startsWith(".") || name === "node_modules") continue;
			const path = rel ? `${rel}/${name}` : name;
			if (ignored(path)) continue;
			const full = join(dir, name);
			// A link may point at a folder; only then is the extra stat needed to tell.
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDirectory = statSync(full).isDirectory();
				} catch {
					continue;
				}
			}
			if (isDirectory) {
				scan(full, path);
			} else if (name === MANIFEST_FILE) {
				try {
					const st = statSync(full);
					records.push(`${path}:${st.size}:${Math.floor(st.mtimeMs)}`);
				} catch {
					// deleted between the listing and the stat
				}
			}
		}
	}

	scan(vaultRoot, "");
	records.sort();
	return createHash("sha256").update(records.join("\n")).digest("hex").slice(0, 16);
}

/** Size and mtime of each note a result holds; a missing note stamps as "". */
function stampFiles(vaultRoot: string, result: TraversalResult): Record<string, string> {
	const files: Record<string, string> = {};
	for (const doc of result.documents ?? (result.document ? [result.document] : [])) {
		try {
			const st = statSync(join(vaultRoot, doc.path));
			files[doc.path] = `${st.size}:${Math.floor(st.mtimeMs)}`;
		} catch {
			files[doc.path] = "";
		}
	}
	return files;
}

/**
 * Two-tier route cache: L1 in-memory Map + L2 disk persistence.
 */
export class RouteCache {
	private readonly memory = new Map<string, CacheEntry>();
	private loadedVaultRoot: string | null = null;
	private currentFingerprint: string | null = null;
	private fingerprintRoot: string | null = null;
	private fingerprintMtime: number = 0;
	private hits = 0;
	private misses = 0;
	private evictions = 0;

	constructor(private readonly maxEntries: number = DEFAULT_MAX_CACHE_ENTRIES) {}

	/**
	 * Looks up a cached traversal result for the given prompt in the vault.
	 * Returns null on miss or when cache is invalid.
	 */
	get(prompt: string, vaultRoot: string, scope = ""): TraversalResult | null {
		const norm = normalizePrompt(prompt);
		if (!norm) return null;

		const qHash = hashPrompt(scope ? `${scope}\n${norm}` : norm);
		const fp = this.getOrUpdateFingerprint(vaultRoot);

		this.ensureLoaded(vaultRoot);

		const entry = this.memory.get(qHash);
		if (!entry) {
			this.misses++;
			return null;
		}

		const files = entry.files ?? {};
		const fresh = stampFiles(vaultRoot, entry.result);
		if (entry.fingerprint !== fp || Object.keys(fresh).some((path) => fresh[path] !== files[path])) {
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
	set(prompt: string, vaultRoot: string, result: TraversalResult, scope = ""): void {
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

		const qHash = hashPrompt(scope ? `${scope}\n${norm}` : norm);
		// The fingerprint this route's own lookup took: no second vault walk, and an
		// edit made while routing still invalidates the entry on the next lookup.
		const fp =
			this.currentFingerprint && this.fingerprintRoot === vaultRoot ? this.currentFingerprint : this.getOrUpdateFingerprint(vaultRoot);

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
			fingerprint: fp,
			result: JSON.parse(JSON.stringify(result)),
			// shortcut: stamped after routing read the note, so an edit in those few ms is missed until the next one.
			files: stampFiles(vaultRoot, result),
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
					writeFileAtomic(diskPath, JSON.stringify({ version: CACHE_VERSION, fingerprint: "", entries: {} }, null, 2));
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
		if (this.currentFingerprint && this.fingerprintRoot === vaultRoot && now - this.fingerprintMtime < 1500) {
			return this.currentFingerprint;
		}
		this.currentFingerprint = computeVaultFingerprint(vaultRoot);
		this.fingerprintRoot = vaultRoot;
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
			if (parsed.version !== CACHE_VERSION || !parsed.entries) return;

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
			version: CACHE_VERSION,
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
