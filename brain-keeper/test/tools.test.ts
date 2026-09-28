/**
 * Drives the tool surface the way an MCP client does: by name, with raw JSON
 * arguments, checking the text a model would actually read back.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { fixtureCopy } from "../../brain-core/test/helpers.js";
import { startMockDecisions, type MockServer } from "../../brain-core/test/mock-decisions.js";
import { loadConfig, type KeeperConfig } from "../src/config.js";
import { TOOLS, annotationsFor, findTool, runTool } from "../src/tools.js";

let mock: MockServer;

before(async () => {
	mock = await startMockDecisions();
});

after(async () => {
	await mock.close();
});

function vault(): string {
	return fixtureCopy("brain-tools-");
}

function config(root: string, overrides: Partial<KeeperConfig> = {}): KeeperConfig {
	return loadConfig({
		skipFile: true,
		env: {},
		overrides: { vaultRoot: root, decisionsUrl: mock.url, logLevel: "silent", ...overrides },
	});
}

async function call(root: string, name: string, input: unknown, overrides: Partial<KeeperConfig> = {}) {
	const tool = findTool(name);
	assert.ok(tool, `no such tool: ${name}`);
	return runTool(tool, config(root, overrides), input);
}

describe("the tool surface", () => {
	it("exposes a stable set of brain_* tools", () => {
		const names = TOOLS.map((tool) => tool.name);
		assert.deepEqual(names, [
			"brain_tree",
			"brain_get_note",
			"brain_search",
			"brain_doctor",
			"brain_check_routing",
			"brain_eval",
			"brain_export",
			"brain_add_note",
			"brain_update_note",
			"brain_move_note",
			"brain_remove_note",
			"brain_add_branch",
			"brain_update_branch",
			"brain_move_branch",
			"brain_remove_branch",
			"brain_split_branch",
			"brain_rebuild",
		]);
		assert.ok(names.every((name) => name.startsWith("brain_")));
	});

	it("describes every tool and marks which ones write", () => {
		for (const tool of TOOLS) {
			assert.ok(tool.description.length > 80, `${tool.name} needs a description a model can act on`);
			assert.equal(typeof tool.mutates, "boolean");
		}
		assert.equal(TOOLS.filter((tool) => tool.mutates).length, 11);
	});

	it("tells MCP clients which tools only read and which remove things", () => {
		const read = annotationsFor(findTool("brain_tree")!);
		assert.equal(read.readOnlyHint, true);
		assert.equal(read.destructiveHint, false);

		const remove = annotationsFor(findTool("brain_remove_note")!);
		assert.equal(remove.readOnlyHint, false);
		assert.equal(remove.destructiveHint, true);

		assert.equal(annotationsFor(findTool("brain_add_note")!).destructiveHint, false);
		assert.equal(annotationsFor(findTool("brain_check_routing")!).openWorldHint, true);
		assert.equal(annotationsFor(findTool("brain_rebuild")!).idempotentHint, true);
	});

	it("reads only markdown notes, never vault settings", async () => {
		const root = vault();
		writeFileSync(join(root, "secrets.json"), JSON.stringify({ token: "sk-plugin-token" }));
		const result = await call(root, "brain_get_note", { path: "secrets.json" });
		assert.equal(result.isError, true);
		assert.ok(!result.text.includes("sk-plugin-token"));

		const about = await call(root, "brain_get_note", { path: "Backend/_about.md" });
		assert.ok(!about.isError, "a folder description is still readable");
	});

	it("turns bad arguments into feedback rather than a crash", async () => {
		const result = await call(vault(), "brain_add_note", { folder: "Backend" });
		assert.equal(result.isError, true);
		assert.match(result.text, /Invalid arguments for brain_add_note/);
		assert.match(result.text, /title/);
	});

	it("turns an operation failure into feedback too", async () => {
		const result = await call(vault(), "brain_get_note", { path: "Backend/nope.md" });
		assert.equal(result.isError, true);
		assert.match(result.text, /No such note/);
	});

	it("says what to do when no vault is configured", async () => {
		const tool = findTool("brain_tree")!;
		const result = await runTool(tool, loadConfig({ skipFile: true, env: {} }), {});
		assert.equal(result.isError, true);
		assert.match(result.text, /BRAIN_VAULT_ROOT/);
	});
});

describe("brain_tree", () => {
	it("renders the structure with child counts", async () => {
		const result = await call(vault(), "brain_tree", {});
		assert.match(result.text, /4 folder\(s\), 9 note\(s\)/);
		assert.match(result.text, /backend \(4\)/);
		assert.match(result.text, /general_instructions \[fallback\]/);
	});

	it("flags a folder over the routing limit inline", async () => {
		const root = vault();
		for (let index = 0; index < 12; index++) {
			await call(root, "brain_add_note", {
				folder: "Backend",
				id: `filler_${index}`,
				title: `Filler ${index}`,
				criteria: `a distinct backend topic number ${index} with its own trigger words`,
				content: "body\n",
			});
		}
		const result = await call(root, "brain_tree", {});
		assert.match(result.text, /backend \(16\).*over the limit/);
		assert.match(result.text, /structural error\(s\) — run brain_doctor/);
	});

	it("accepts a folder written with a trailing slash or backslashes", async () => {
		for (const folder of ["Backend/", "./Backend", "Backend"]) {
			const result = await call(vault(), "brain_tree", { folder });
			assert.ok(!result.isError, folder);
			assert.match(result.text, /asyncpg_pooling/);
		}
	});

	it("can show criteria and scope to a subtree", async () => {
		const result = await call(vault(), "brain_tree", { folder: "Backend", criteria: true });
		assert.match(result.text, /asyncpg pool sizing and lifespan setup/);
		assert.ok(!result.text.includes("css_layout"));
	});
});

describe("brain_doctor", () => {
	it("is clean on a healthy brain", async () => {
		const result = await call(vault(), "brain_doctor", {});
		assert.match(result.text, /No issues found/);
	});

	it("reports each problem with the action that fixes it", async () => {
		const root = vault();
		writeFileSync(join(root, "Backend", "thin.md"), "---\nid: thin\ncriteria: db\n---\n\nbody\n", "utf8");
		await call(root, "brain_rebuild", {});

		const result = await call(root, "brain_doctor", {});
		assert.match(result.text, /thin-criteria/);
		assert.match(result.text, /fix: aim for 10-25 words/);
	});

	it("notices manifests that no longer match the notes", async () => {
		const root = vault();
		writeFileSync(join(root, "Backend", "_index.json"), "[]", "utf8");

		const result = await call(root, "brain_doctor", {});
		assert.match(result.text, /1 manifest\(s\) are stale/);
		assert.match(result.text, /Run brain_rebuild/);
	});
});

describe("capture and maintenance flow", () => {
	it("adds a note and reports the files and manifests it touched", async () => {
		const root = vault();
		const result = await call(root, "brain_add_note", {
			folder: "Infrastructure",
			title: "Terraform Modules",
			criteria: "Terraform providers, module composition, remote state, plan and apply workflows",
			content: "# Terraform Modules\n\nPin provider versions.\n",
		});

		assert.ok(!result.isError);
		assert.match(result.text, /Added Infrastructure\/terraform_modules\.md/);
		assert.match(result.text, /created {2}Infrastructure\/terraform_modules\.md/);
		assert.match(result.text, /written {3}Infrastructure\/_index\.json {2}\(3 entries\)/);
	});

	it("splits an over-full folder and reports the new shape", async () => {
		const root = vault();
		const result = await call(root, "brain_split_branch", {
			folder: "Backend",
			newFolderTitle: "Databases",
			newFolderCriteria: "PostgreSQL connections, pooling, query plans, indexes and transaction handling",
			moveIds: ["asyncpg_pooling", "sql_indexing"],
		});

		assert.match(result.text, /moved 2 children into Backend\/Databases/);
		assert.match(result.text, /moved {4}Backend\/asyncpg_pooling\.md -> Backend\/Databases\/asyncpg_pooling\.md/);
		const after = await call(root, "brain_doctor", {});
		assert.match(after.text, /No issues found/);
	});

	it("rebuild picks up a note written outside the tools", async () => {
		const root = vault();
		// Simulate writing a note in Obsidian rather than through the tools.
		writeFileSync(
			join(root, "Frontend", "web_components.md"),
			"---\nid: web_components\ntitle: Web Components\ncriteria: custom elements, shadow DOM, slots and templates in the browser\n---\n\nbody\n",
			"utf8",
		);

		// brain_tree scans the filesystem, so it sees the note at once — but the
		// router reads manifests, and that one is now stale.
		const tree = await call(root, "brain_tree", { folder: "Frontend" });
		assert.match(tree.text, /web_components/);

		const before = await call(root, "brain_doctor", {});
		assert.match(before.text, /1 manifest\(s\) are stale/);

		const rebuilt = await call(root, "brain_rebuild", {});
		assert.match(rebuilt.text, /Rebuilt 1 manifest\(s\)/);

		const after = await call(root, "brain_doctor", {});
		assert.ok(!after.text.includes("stale"));
	});

	it("dry-run rebuild reports without writing", async () => {
		const root = vault();
		writeFileSync(join(root, "Backend", "_index.json"), "[]", "utf8");

		const result = await call(root, "brain_rebuild", { dryRun: true });
		assert.match(result.text, /1 manifest\(s\) would change/);
		assert.equal(readFileSync(join(root, "Backend", "_index.json"), "utf8"), "[]");
	});
});

describe("brain_check_routing", () => {
	it("reports where each prompt lands, with the losing options", async () => {
		mock.behaviour = {};
		const result = await call(vault(), "brain_check_routing", {
			prompts: [{ prompt: "How do I configure connection pooling for asyncpg in FastAPI?" }],
		});

		assert.ok(!result.isError);
		assert.match(result.text, /asyncpg_pooling \(Backend\/asyncpg_pooling\.md\)/);
		assert.match(result.text, /hop \. -> backend/);
	});

	it("marks an expectation that was not met and says how to fix it", async () => {
		mock.behaviour = { chooseBy: (options) => (options.includes("frontend") ? "frontend" : "css_layout") };
		const result = await call(vault(), "brain_check_routing", {
			prompts: [{ prompt: "how do I pool database connections?", expected: "asyncpg_pooling" }],
		});

		assert.match(result.text, /^NO /m);
		assert.match(result.text, /expected asyncpg_pooling/);
		assert.match(result.text, /1 of 1 went elsewhere/);
		// The remedy the agent should act on is criteria, not tree surgery.
		assert.match(result.text, /rewrite the losing note's criteria/);
		mock.behaviour = {};
	});

	it("confirms an expectation that was met", async () => {
		mock.behaviour = {};
		const result = await call(vault(), "brain_check_routing", {
			prompts: [
				{ prompt: "How do I configure connection pooling for asyncpg in FastAPI?", expected: "asyncpg_pooling" },
			],
		});
		assert.match(result.text, /All expectations met/);
	});

	it("says the service is down rather than blaming the vault", async () => {
		const result = await call(
			vault(),
			"brain_check_routing",
			{ prompts: [{ prompt: "anything" }] },
			{ decisionsUrl: "http://127.0.0.1:1", timeoutMs: 200, retries: 0 },
		);

		assert.equal(result.isError, true);
		assert.match(result.text, /failed to reach the decisions service/);
		assert.match(result.text, /Check that the Laya host is running/, "a local URL points at the host");

		const remote = await call(
			vault(),
			"brain_check_routing",
			{ prompts: [{ prompt: "anything" }] },
			{ decisionsUrl: "http://203.0.113.1:9", timeoutMs: 100, retries: 0 },
		);
		assert.match(remote.text, /Set TYPESAFE_API_KEY/, "a remote URL without a key points at the key");
	});

	it("routes with the same thresholds the router uses", async () => {
		// The whole point of the check is predicting the router: a tuned
		// minConfidence must change the verdict here too.
		mock.behaviour = { confidence: 0.5 };
		const prompt = { prompt: "How do I configure connection pooling for asyncpg in FastAPI?", expected: "asyncpg_pooling" };
		const loose = await call(vault(), "brain_check_routing", { prompts: [prompt] }, { minConfidence: 0.4 });
		assert.match(loose.text, /All expectations met/);

		const strict = await call(vault(), "brain_check_routing", { prompts: [prompt] }, { minConfidence: 0.6 });
		assert.match(strict.text, /^NO /m);
		assert.match(strict.text, /below threshold 0\.6/);
		mock.behaviour = {};
	});
});

describe("brain_search", () => {
	it("finds an existing note before a duplicate gets written", async () => {
		const result = await call(vault(), "brain_search", { query: "pgbouncer statement cache" });
		assert.ok(!result.isError);
		assert.match(result.text, /^1 match\(es\)|match\(es\) for "pgbouncer statement cache"/);
		assert.match(result.text, /note {3}Backend\/asyncpg_pooling\.md/);
	});
});

describe("brain_eval and brain_export", () => {
	it("runs evals through brain_eval tool", async () => {
		mock.behaviour = {};
		const v = vault();
		const result = await call(v, "brain_eval", {});
		assert.ok(!result.isError);
		assert.match(result.text, /✔ \[PASS\] asyncpg-pool/);
		assert.match(result.text, /Summary: \d+\/\d+ passed/);
	});

	it("exports rules through brain_export tool", async () => {
		const v = vault();
		const result = await call(v, "brain_export", { format: "cursor", dryRun: true });
		assert.ok(!result.isError);
		assert.match(result.text, /Exported \d+ notes to cursor format/);
	});
});
