import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseNote } from "../../brain-core/src/frontmatter.js";
import { validateManifest } from "../../brain-core/src/manifest.js";
import { VaultPathError } from "../../brain-core/src/paths.js";
import { collectIssues, scanVault } from "../../brain-core/src/vault.js";
import { fixtureCopy } from "../../brain-core/test/helpers.js";
import * as ops from "../src/operations.js";

/** A throwaway copy of the fixture vault, so every test starts from a known good brain. */
function vault(): string {
	return fixtureCopy("brain-keeper-");
}

function manifest(root: string, folder = ""): ReturnType<typeof validateManifest> {
	const path = folder ? join(root, folder, "_index.json") : join(root, "_index.json");
	return validateManifest(JSON.parse(readFileSync(path, "utf8")), path);
}

function ids(root: string, folder = ""): string[] {
	return manifest(root, folder).map((entry) => entry.id);
}

describe("addNote", () => {
	it("writes the note and regenerates the folder's manifest", () => {
		const root = vault();
		const result = ops.addNote(root, {
			folder: "Backend",
			title: "Redis Caching",
			criteria: "Redis keys, TTL policies, eviction, pipelines and cache invalidation strategies",
			content: "# Redis Caching\n\nSet a TTL on everything.\n",
		});

		assert.equal(result.changes[0].action, "created");
		assert.equal(result.changes[0].path, "Backend/redis_caching.md");
		assert.deepEqual(
			result.manifests.map((file) => file.path),
			["Backend/_index.json"],
		);
		assert.ok(ids(root, "Backend").includes("redis_caching"));

		const note = parseNote(readFileSync(join(root, "Backend", "redis_caching.md"), "utf8"));
		assert.equal(note.frontmatter.id, "redis_caching");
		assert.equal(note.frontmatter.title, "Redis Caching");
		assert.match(note.body, /Set a TTL/);
	});

	it("derives the id from the title but accepts an explicit one", () => {
		const root = vault();
		ops.addNote(root, {
			folder: "Backend",
			id: "kafka",
			title: "Message Queues & Kafka",
			criteria: "Kafka topics, consumer groups, offsets, partitions and rebalancing behaviour",
			content: "body\n",
		});
		assert.ok(existsSync(join(root, "Backend", "kafka.md")));
	});

	it("refuses to clobber an existing note unless told to", () => {
		const root = vault();
		const input = {
			folder: "Backend",
			id: "fastapi_core",
			title: "FastAPI Core",
			criteria: "FastAPI routing, middleware, dependency injection and uvicorn configuration",
			content: "replaced\n",
		};

		assert.throws(() => ops.addNote(root, input), /already exists/);
		const result = ops.addNote(root, { ...input, overwrite: true });
		assert.equal(result.changes[0].action, "updated");
		assert.match(readFileSync(join(root, "Backend", "fastapi_core.md"), "utf8"), /replaced/);
	});

	it("demands criteria, and says what good criteria look like", () => {
		const root = vault();
		assert.throws(
			() => ops.addNote(root, { folder: "Backend", title: "T", criteria: "  ", content: "x" }),
			/needs a `criteria`/,
		);
	});

	it("warns rather than refuses when a folder goes over the limit", () => {
		const root = vault();
		// Backend starts with 4 notes; push it to 16.
		for (let index = 0; index < 11; index++) {
			ops.addNote(root, {
				folder: "Backend",
				id: `filler_${index}`,
				title: `Filler ${index}`,
				criteria: `a distinct backend topic number ${index} with its own trigger words`,
				content: "body\n",
			});
		}
		const result = ops.addNote(root, {
			folder: "Backend",
			id: "one_too_many",
			title: "One Too Many",
			criteria: "the note that tips this folder over the branching limit for routing",
			content: "body\n",
		});

		// Refusing would block legitimate capture; the note lands and the caller is
		// told to split.
		assert.equal(result.changes[0].action, "created");
		assert.match(result.warnings[0], /over the 15 limit/);
		assert.match(result.warnings[0], /brain_split_branch/);
	});

	it("refuses a folder that does not exist", () => {
		const root = vault();
		assert.throws(
			() => ops.addNote(root, { folder: "Nope", title: "T", criteria: "some criteria words here", content: "x" }),
			/no such folder/,
		);
	});

	it("refuses to escape the vault", () => {
		const root = vault();
		assert.throws(
			() => ops.addNote(root, { folder: "../..", title: "T", criteria: "some criteria words here", content: "x" }),
			VaultPathError,
		);
	});
});

describe("updateNote", () => {
	it("rewrites criteria without touching the body", () => {
		const root = vault();
		const before = parseNote(readFileSync(join(root, "Backend", "sql_indexing.md"), "utf8")).body;

		const result = ops.updateNote(root, {
			path: "Backend/sql_indexing.md",
			criteria: "EXPLAIN ANALYZE, B-tree and partial indexes, query plans, vacuum and slow query tuning",
		});

		const after = parseNote(readFileSync(join(root, "Backend", "sql_indexing.md"), "utf8"));
		assert.equal(after.body, before);
		assert.match(after.frontmatter.criteria!, /EXPLAIN ANALYZE/);
		assert.deepEqual(result.manifests.map((file) => file.path), ["Backend/_index.json"]);
	});

	it("appends without losing what was there", () => {
		const root = vault();
		ops.updateNote(root, { path: "Backend/celery_jobs.md", append: "## Dead letter queues\n\nRoute them." });

		const body = parseNote(readFileSync(join(root, "Backend", "celery_jobs.md"), "utf8")).body;
		assert.match(body, /## Task design/);
		assert.match(body, /## Dead letter queues/);
	});

	it("preserves frontmatter it does not own", () => {
		const root = vault();
		const path = join(root, "Backend", "fastapi_core.md");
		const raw = readFileSync(path, "utf8").replace("---\nid:", "---\ntags:\n  - api\nid:");
		writeFileSync(path, raw, "utf8");

		ops.updateNote(root, { path: "Backend/fastapi_core.md", title: "FastAPI Fundamentals" });

		const after = readFileSync(path, "utf8");
		assert.match(after, /tags:\n {2}- api/);
		assert.match(after, /title: FastAPI Fundamentals/);
	});

	it("rejects content and append together", () => {
		const root = vault();
		assert.throws(
			() => ops.updateNote(root, { path: "Backend/celery_jobs.md", content: "a", append: "b" }),
			/not both/,
		);
	});

	it("rejects an empty update", () => {
		const root = vault();
		assert.throws(() => ops.updateNote(root, { path: "Backend/celery_jobs.md" }), /nothing to update/);
	});

	it("refuses to edit generated or structural files", () => {
		const root = vault();
		assert.throws(() => ops.updateNote(root, { path: "Backend/_index.json", title: "x" }), /generated/);
		assert.throws(() => ops.updateNote(root, { path: "Backend/_about.md", title: "x" }), /brain_update_branch/);
	});
});

describe("moveNote", () => {
	it("moves the file and updates both manifests", () => {
		const root = vault();
		const result = ops.moveNote(root, { from: "Backend/celery_jobs.md", toFolder: "Infrastructure" });

		assert.equal(result.changes[0].from, "Backend/celery_jobs.md");
		assert.equal(result.changes[0].path, "Infrastructure/celery_jobs.md");
		assert.ok(!ids(root, "Backend").includes("celery_jobs"));
		assert.ok(ids(root, "Infrastructure").includes("celery_jobs"));
	});

	it("keeps the frontmatter id in step with a rename", () => {
		const root = vault();
		ops.moveNote(root, { from: "Backend/celery_jobs.md", toFolder: "Backend", newId: "background_jobs" });

		const note = parseNote(readFileSync(join(root, "Backend", "background_jobs.md"), "utf8"));
		// A stale id would compile into a label that disagrees with the filename.
		assert.equal(note.frontmatter.id, "background_jobs");
		assert.ok(ids(root, "Backend").includes("background_jobs"));
	});

	it("refuses a destination that is already taken", () => {
		const root = vault();
		assert.throws(
			() => ops.moveNote(root, { from: "Backend/celery_jobs.md", toFolder: "Backend", newId: "sql_indexing" }),
			/already/,
		);
	});
});

describe("removeNote", () => {
	it("moves the note to .trash/ and recompiles", () => {
		const root = vault();
		const result = ops.removeNote(root, "Frontend/react_state.md");

		assert.equal(result.changes[0].action, "trashed");
		assert.equal(result.changes[0].path, ".trash/react_state.md");
		assert.ok(!existsSync(join(root, "Frontend", "react_state.md")));
		assert.ok(existsSync(join(root, ".trash", "react_state.md")), "recoverable");
		assert.deepEqual(ids(root, "Frontend"), ["css_layout"]);
	});

	it("numbers a clash in the trash the way Obsidian does", () => {
		const root = vault();
		mkdirSync(join(root, ".trash"));
		writeFileSync(join(root, ".trash", "react_state.md"), "older");
		const result = ops.removeNote(root, "Frontend/react_state.md");
		assert.equal(result.changes[0].path, ".trash/react_state 2.md");
	});

	it("warns when the catch-all note is removed", () => {
		const root = vault();
		const result = ops.removeNote(root, "general_instructions.md");
		assert.match(result.warnings[0], /was a catch-all note/);
	});
});

describe("addBranch", () => {
	it("creates the folder with an _about.md and warns that it routes nowhere yet", () => {
		const root = vault();
		const result = ops.addBranch(root, {
			parent: ".",
			title: "Data",
			criteria: "Data pipelines, ETL jobs, warehouse modelling, dbt transforms and scheduled loads",
		});

		assert.ok(existsSync(join(root, "Data", "_about.md")));
		assert.match(result.warnings[0], /no notes yet/);
		// A folder with nothing to route to is left out of its parent's manifest,
		// rather than offered as a dead end.
		assert.ok(!ids(root).includes("data"));
		assert.ok(!existsSync(join(root, "Data", "_index.json")));

		ops.addNote(root, {
			folder: "Data",
			title: "dbt Models",
			criteria: "dbt models, incremental materialisation, sources and tests in the warehouse",
			content: "body\n",
		});
		assert.ok(ids(root).includes("data"), "offered once it holds a note");
	});

	it("refuses to collide with an existing folder or id", () => {
		const root = vault();
		assert.throws(
			() => ops.addBranch(root, { parent: ".", title: "Backend", criteria: "some criteria words here now" }),
			/already exists/,
		);
	});
});

describe("updateBranch", () => {
	it("rewrites the folder's routing criteria", () => {
		const root = vault();
		ops.updateBranch(root, {
			folder: "Frontend",
			criteria: "React hooks, CSS layout, bundlers, accessibility, browser state and client routing",
		});

		const entry = manifest(root).find((item) => item.id === "frontend")!;
		assert.match(entry.criteria, /bundlers/);
	});

	it("has nothing to update at the vault root", () => {
		const root = vault();
		assert.throws(() => ops.updateBranch(root, { folder: ".", title: "x" }), /vault root/);
	});
});

describe("splitBranch", () => {
	it("moves a themed subset into a new subfolder in one step", () => {
		const root = vault();
		const result = ops.splitBranch(root, {
			folder: "Backend",
			newFolderTitle: "Databases",
			newFolderCriteria: "PostgreSQL connections, pooling, query plans, indexes and transaction handling",
			moveIds: ["asyncpg_pooling", "sql_indexing"],
		});

		assert.deepEqual(ids(root, "Backend"), ["databases", "celery_jobs", "fastapi_core"]);
		assert.deepEqual(ids(root, join("Backend", "Databases")), ["asyncpg_pooling", "sql_indexing"]);
		assert.equal(result.changes.filter((change) => change.action === "moved").length, 2);
		assert.deepEqual(collectIssues(scanVault(root)), []);
	});

	it("refuses a split that leaves nothing behind", () => {
		const root = vault();
		assert.throws(
			() =>
				ops.splitBranch(root, {
					folder: "Frontend",
					newFolderTitle: "All",
					newFolderCriteria: "every single note that used to live in the frontend folder",
					moveIds: ["react_state", "css_layout"],
				}),
			/at least one behind/,
		);
	});

	it("refuses ids that are not children of the folder", () => {
		const root = vault();
		assert.throws(
			() =>
				ops.splitBranch(root, {
					folder: "Backend",
					newFolderTitle: "Mixed",
					newFolderCriteria: "a grab bag of notes that do not all live here",
					moveIds: ["asyncpg_pooling", "css_layout"],
				}),
			/not children of 'Backend'/,
		);
	});
});

describe("rebuild and doctor", () => {
	it("rebuild is a no-op on a healthy vault", () => {
		const root = vault();
		assert.equal(ops.rebuild(root).manifests.length, 0);
		assert.match(ops.rebuild(root).summary, /already up to date/);
	});

	it("rebuild repairs a manifest edited by hand", () => {
		const root = vault();
		writeFileSync(join(root, "Backend", "_index.json"), "[]", "utf8");

		const result = ops.rebuild(root);
		assert.deepEqual(result.manifests.map((file) => file.path), ["Backend/_index.json"]);
		assert.equal(ids(root, "Backend").length, 4);
	});

	it("doctor reports a stale manifest without writing one", () => {
		const root = vault();
		writeFileSync(join(root, "Backend", "_index.json"), "[]", "utf8");

		const report = ops.doctor(root);
		assert.deepEqual(report.stale.map((file) => file.path), ["Backend/_index.json"]);
		assert.equal(readFileSync(join(root, "Backend", "_index.json"), "utf8"), "[]");
	});

	it("doctor finds a folder that was created but never described", () => {
		const root = vault();
		mkdirSync(join(root, "Orphan"));
		writeFileSync(join(root, "Orphan", "note.md"), "---\nid: n\ncriteria: a note in an undescribed folder\n---\n\nx\n");

		const codes = ops.doctor(root).issues.map((issue) => issue.code);
		assert.ok(codes.includes("missing-about"));
	});

	it("doctor is clean on the fixture vault", () => {
		assert.deepEqual(ops.doctor(vault()).issues, []);
	});
});
