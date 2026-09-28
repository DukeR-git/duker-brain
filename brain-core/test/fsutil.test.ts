import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LOCK_FILE, VaultLockedError, withVaultLock, writeFileAtomic } from "../src/fsutil.js";
import { tempDir } from "./helpers.js";

describe("writeFileAtomic", () => {
	it("replaces a file and leaves no temp file behind", () => {
		const dir = tempDir();
		const path = join(dir, "a.json");
		writeFileSync(path, "old");
		writeFileAtomic(path, "new");
		assert.equal(readFileSync(path, "utf8"), "new");
		assert.deepEqual(readdirSync(dir), ["a.json"]);
	});
});

describe("withVaultLock", () => {
	it("holds the lock for the duration and releases it", () => {
		const dir = tempDir();
		const result = withVaultLock(dir, () => {
			assert.ok(existsSync(join(dir, LOCK_FILE)));
			return 42;
		});
		assert.equal(result, 42);
		assert.ok(!existsSync(join(dir, LOCK_FILE)));
	});

	it("is re-entrant within one process", () => {
		const dir = tempDir();
		const value = withVaultLock(dir, () => withVaultLock(dir, () => "inner"));
		assert.equal(value, "inner");
		assert.ok(!existsSync(join(dir, LOCK_FILE)));
	});

	it("releases the lock when the work throws", () => {
		const dir = tempDir();
		assert.throws(() => withVaultLock(dir, () => {
			throw new Error("boom");
		}), /boom/);
		assert.ok(!existsSync(join(dir, LOCK_FILE)));
	});

	it("waits for another holder, then gives up with a clear message", () => {
		const dir = tempDir();
		writeFileSync(join(dir, LOCK_FILE), "99999 someone\n");
		assert.throws(() => withVaultLock(dir, () => "never", 100), VaultLockedError);
	});

	it("breaks a lock left behind by a dead process", () => {
		const dir = tempDir();
		const lock = join(dir, LOCK_FILE);
		writeFileSync(lock, "99999 long ago\n");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		assert.equal(withVaultLock(dir, () => "ran", 100), "ran");
	});
});
