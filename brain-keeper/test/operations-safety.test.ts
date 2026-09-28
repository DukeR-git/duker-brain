/**
 * The keeper's safety properties: nothing half-done, nothing invisible, nothing
 * destroyed, one catch-all per folder, and one writer at a time.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseNote } from "../../brain-core/src/frontmatter.js";
import { LOCK_FILE, VaultLockedError } from "../../brain-core/src/fsutil.js";
import { validateManifest } from "../../brain-core/src/manifest.js";
import { collectIssues, scanVault } from "../../brain-core/src/vault.js";
import { fixtureCopy } from "../../brain-core/test/helpers.js";
import * as ops from "../src/operations.js";

function ids(root: string, folder = ""): string[] {
	const path = folder ? join(root, folder, "_index.json") : join(root, "_index.json");
	return validateManifest(JSON.parse(readFileSync(path, "utf8")), path).map((entry) => entry.id);
}

const CRITERIA = "a distinct topic with its own trigger words and intents";

describe("folder names", () => {
	it("keeps a folder visible when its title starts with a dot", () => {
		const root = fixtureCopy();
		const result = ops.addBranch(root, { parent: ".", title: ".NET", criteria: "C# dotnet runtime, NuGet packages, ASP.NET Core" });
		assert.equal(result.changes[0].path, "NET/_about.md");
		ops.addNote(root, { folder: "NET", title: "NuGet", criteria: CRITERIA, content: "x" });
		assert.ok(ids(root).includes("net"), "the scanner sees it");
	});

	it("makes names every platform accepts", () => {
		assert.equal(ops.safeFolderName("  CI/CD: pipelines?  "), "CI-CD- pipelines-");
		assert.equal(ops.safeFolderName("Notes. "), "Notes");
		assert.equal(ops.safeFolderName("con"), "con_");
		assert.throws(() => ops.safeFolderName("..."), /cannot make a folder name/);
	});
});

describe("titles and catch-alls", () => {
	it("refuses an empty title on update", () => {
		const root = fixtureCopy();
		assert.throws(() => ops.updateNote(root, { path: "Backend/celery_jobs.md", title: "  " }), /non-empty title/);
	});

	it("allows one catch-all per folder", () => {
		const root = fixtureCopy();
		assert.throws(
			() => ops.addNote(root, { folder: ".", title: "Another", criteria: CRITERIA, content: "x", fallback: true }),
			/general_instructions\.md is already the catch-all/,
		);
		assert.throws(
			() => ops.updateNote(root, { path: "Backend/celery_jobs.md", fallback: true }) && ops.updateNote(root, { path: "Backend/sql_indexing.md", fallback: true }),
			/already the catch-all for 'Backend'/,
		);
	});
});

describe("moveNote", () => {
	it("leaves the source untouched when the move is refused", () => {
		const root = fixtureCopy();
		const before = readFileSync(join(root, "Backend", "celery_jobs.md"), "utf8");
		assert.throws(() => ops.moveNote(root, { from: "Backend/celery_jobs.md", toFolder: "Nope" }), /no such folder/);
		assert.equal(readFileSync(join(root, "Backend", "celery_jobs.md"), "utf8"), before);
	});
});

describe("splitBranch", () => {
	it("de-duplicates the ids to move", () => {
		const root = fixtureCopy();
		assert.throws(
			() =>
				ops.splitBranch(root, {
					folder: "Frontend",
					newFolderTitle: "Styling",
					newFolderCriteria: "CSS layout and styling concerns in the browser",
					moveIds: ["css_layout", "css_layout"],
				}),
			/at least 2 distinct children/,
		);
		assert.ok(!existsSync(join(root, "Frontend", "Styling")), "nothing was created");
	});

	it("refuses a new folder name that collides with a child it would move", () => {
		const root = fixtureCopy();
		assert.throws(
			() =>
				ops.splitBranch(root, {
					folder: "Backend",
					newFolderTitle: "sql_indexing.md",
					newFolderCriteria: "a folder whose name collides with a note being moved into it",
					moveIds: ["asyncpg_pooling", "sql_indexing"],
				}),
			/collides with a child being moved/,
		);
		assert.deepEqual(ids(root, "Backend"), ["asyncpg_pooling", "celery_jobs", "fastapi_core", "sql_indexing"]);
		assert.deepEqual(collectIssues(scanVault(root)), []);
	});

	it("compiles once, leaving a healthy brain", () => {
		const root = fixtureCopy();
		const result = ops.splitBranch(root, {
			folder: "Backend",
			newFolderTitle: "Databases",
			newFolderCriteria: "PostgreSQL connections, pooling, query plans, indexes and transaction handling",
			moveIds: ["asyncpg_pooling", "sql_indexing", "asyncpg_pooling"],
		});
		assert.equal(result.changes.filter((change) => change.action === "moved").length, 2);
		assert.deepEqual(collectIssues(scanVault(root)), []);
	});
});

describe("branches", () => {
	it("moves and renames a folder, keeping its id in step", () => {
		const root = fixtureCopy();
		ops.moveBranch(root, { folder: "Frontend", toParent: "Backend", newName: "Web", newId: "web_ui" });

		assert.ok(existsSync(join(root, "Backend", "Web", "css_layout.md")));
		assert.ok(ids(root, "Backend").includes("web_ui"));
		assert.ok(!ids(root).includes("frontend"));
		assert.equal(parseNote(readFileSync(join(root, "Backend", "Web", "_about.md"), "utf8")).frontmatter.id, "web_ui");
	});

	it("refuses to move a folder into itself", () => {
		const root = fixtureCopy();
		assert.throws(() => ops.moveBranch(root, { folder: "Backend", toParent: "Backend" }), /into itself/);
	});

	it("removes a folder to .trash/, notes and all", () => {
		const root = fixtureCopy();
		const result = ops.removeBranch(root, "Frontend");
		assert.match(result.summary, /\(2 note\(s\)\) to \.trash\/Frontend/);
		assert.ok(existsSync(join(root, ".trash", "Frontend", "css_layout.md")));
		assert.ok(!ids(root).includes("frontend"));
		assert.throws(() => ops.removeBranch(root, "."), /cannot be removed/);
	});
});

describe("search", () => {
	it("finds notes by body, criteria and title, best match first", () => {
		const root = fixtureCopy();
		const hits = ops.searchNotes(root, "statement cache pgbouncer");
		assert.equal(hits[0].path, "Backend/asyncpg_pooling.md");
		assert.match(hits[0].snippet ?? "", /PgBouncer/);

		assert.equal(ops.searchNotes(root, "flexbox")[0].path, "Frontend/css_layout.md");
		assert.deepEqual(ops.searchNotes(root, "kubernetes helm"), []);
		assert.throws(() => ops.searchNotes(root, "a"), /at least one word/);
	});
});

describe("the vault lock", () => {
	it("refuses to write while another writer holds the vault", () => {
		const root = fixtureCopy();
		writeFileSync(join(root, LOCK_FILE), "99999 another writer\n");
		// The lock waits up to five seconds by default; a held lock ends in a clear error.
		assert.throws(
			() => ops.addNote(root, { folder: "Backend", title: "Redis", criteria: CRITERIA, content: "x" }),
			VaultLockedError,
		);
		assert.ok(!existsSync(join(root, "Backend", "redis.md")));
	});

	it("leaves no lock or temp files behind after a write", () => {
		const root = fixtureCopy();
		ops.addNote(root, { folder: "Backend", title: "Redis", criteria: CRITERIA, content: "x" });
		assert.ok(!existsSync(join(root, LOCK_FILE)));
		assert.ok(!readdirSync(join(root, "Backend")).some((name) => name.endsWith(".tmp")));
	});
});
