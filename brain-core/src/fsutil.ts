/**
 * Filesystem writes that other readers can safely race with.
 *
 * The router reads manifests while the keeper rewrites them, Obsidian (or its
 * sync plugin) may be writing the same notes, and a crash mid-write must not
 * leave a truncated file behind. Every write therefore goes to a temporary file
 * in the same directory and is renamed into place, which is atomic on one
 * filesystem. Temp files start with `.` so the vault scanner never sees them.
 */

import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write `data` to `path` atomically: readers see the old file or the new one, never half of it. */
export function writeFileAtomic(path: string, data: string): void {
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	writeFileSync(temp, data, "utf8");
	try {
		// Windows refuses to replace a file another process has open for a moment
		// (an indexer, antivirus, Obsidian reading it); a short retry covers that.
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(temp, path);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 5) throw error;
				sleepSync(20 * (attempt + 1));
			}
		}
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export const LOCK_FILE = ".brain.lock";

/** A lock older than this is assumed to belong to a process that died holding it. */
const STALE_LOCK_MS = 30_000;

export class VaultLockedError extends Error {}

/**
 * Run `fn` holding an exclusive lock on the vault, so two writers (the MCP
 * server, Pi's native tools, a `brain-keeper` CLI, the watcher) cannot
 * interleave a write with another's recompile.
 */
export function withVaultLock<T>(vaultRoot: string, fn: () => T, timeoutMs = 5_000): T {
	const lock = join(vaultRoot, LOCK_FILE);

	// Re-entrant within this process: an operation built from other operations
	// (a split creates a branch, then moves notes) must not deadlock on itself.
	const depth = held.get(lock) ?? 0;
	if (depth > 0) {
		held.set(lock, depth + 1);
		try {
			return fn();
		} finally {
			held.set(lock, depth);
		}
	}

	const deadline = Date.now() + timeoutMs;

	for (;;) {
		try {
			const fd = openSync(lock, "wx");
			writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
			closeSync(fd);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
					rmSync(lock, { force: true });
					continue;
				}
			} catch {
				continue; // released between our open and our stat
			}
			if (Date.now() >= deadline) {
				let holder = "another process";
				try {
					holder = `process ${readFileSync(lock, "utf8").split(" ")[0]}`;
				} catch {
					/* ignore */
				}
				throw new VaultLockedError(
					`the vault is locked by ${holder} (${lock}); retry in a moment, or delete the file if no brain tool is running`,
				);
			}
			sleepSync(25);
		}
	}

	held.set(lock, 1);
	try {
		return fn();
	} finally {
		held.delete(lock);
		rmSync(lock, { force: true });
	}
}

const held = new Map<string, number>();
