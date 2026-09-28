/**
 * Shared brains: parsing sources, adding a brain as a folder, and updating it
 * without losing local edits. Git sources are real repositories created in a
 * temp directory and fetched over file://, so the clone path is exercised
 * without the network.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { SOURCES_FILE, STARTERS_DIR, addBrain, listStarters, parseSource, readSources, updateBrains } from "../src/brains.js";
import { initVault } from "../src/init.js";
import { compileVault, flatten, scanVault } from "../../brain-core/src/vault.js";
import { isolatedEnv, note, scratch, tempDir } from "../../brain-core/test/helpers.js";

function vault(): string {
	const dir = join(tempDir(), "brain");
	initVault({ dir, saveConfig: false, env: isolatedEnv() });
	return dir;
}

function write(root: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), content, "utf8");
	}
}

const git = (cwd: string, ...args: string[]) => {
	const run = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout.trim();
};

/** A git repository holding a small brain; returns its file:// URL and a way to commit changes. */
function repo(files: Record<string, string>, name = "go-brain") {
	const dir = join(tempDir(), name);
	mkdirSync(dir, { recursive: true });
	write(dir, files);
	git(dir, "init", "--quiet", "--initial-branch=main");
	git(dir, "add", "-A");
	git(dir, "commit", "--quiet", "-m", "initial");
	return {
		dir,
		url: pathToFileURL(dir).href,
		commit(changes: Record<string, string>) {
			write(dir, changes);
			git(dir, "add", "-A");
			git(dir, "commit", "--quiet", "-m", "change");
			return git(dir, "rev-parse", "HEAD");
		},
	};
}

const GO_BRAIN = {
	"README.md": "# A Go brain\n\nRepository readme, not a note.\n",
	"LICENSE": "MIT\n",
	"install.sh": "echo never copied\n",
	"_about.md": note({ id: "go", title: "Go", criteria: "Go services: goroutines, channels, error handling, modules and testing" }),
	"go_errors.md": note({ id: "go_errors", title: "Go Errors", criteria: "Wrapping and checking errors in Go with errors.Is, errors.As and fmt.Errorf %w" }, "Wrap with %w.\n"),
	"go_modules.md": note({ id: "go_modules", title: "Go Modules", criteria: "go.mod, go get, replace directives, minimal version selection and vendoring" }, "Run go mod tidy.\n"),
	"concurrency/_about.md": note({ id: "go_concurrency", title: "Concurrency", criteria: "Goroutines, channels, sync primitives and context cancellation in Go" }),
	"concurrency/go_context.md": note({ id: "go_context", title: "Context", criteria: "Passing context.Context, deadlines, cancellation and request-scoped values" }, "Pass ctx first.\n"),
	"evals.json": JSON.stringify({ version: 1, evals: [{ id: "wrap", prompt: "How do I wrap an error in Go?", expected: "go_errors" }] }),
};

describe("parseSource", () => {
	it("reads a bare name as a starter brain", () => {
		assert.deepEqual(parseSource("python-backend"), { kind: "starter", spec: "python-backend", name: "python-backend" });
	});

	it("reads GitHub shorthand, with a folder and a ref", () => {
		const source = parseSource("someone/monorepo/brains/go#v2");
		assert.equal(source.kind, "git");
		assert.deepEqual(source.kind === "git" && [source.url, source.subdir, source.ref, source.name], [
			"https://github.com/someone/monorepo.git",
			"brains/go",
			"v2",
			"go",
		]);
	});

	it("reads GitHub web URLs, including /tree/<ref>/<folder>", () => {
		const source = parseSource("https://github.com/someone/brains/tree/main/python");
		assert.ok(source.kind === "git");
		assert.equal(source.url, "https://github.com/someone/brains.git");
		assert.equal(source.ref, "main");
		assert.equal(source.subdir, "python");
		assert.equal(parseSource("https://github.com/someone/their-brain").name, "their-brain");
	});

	it("takes any other git URL", () => {
		const source = parseSource("https://gitlab.com/team/infra-brain.git#stable");
		assert.ok(source.kind === "git");
		assert.equal(source.url, "https://gitlab.com/team/infra-brain.git");
		assert.equal(source.ref, "stable");
		assert.equal(source.name, "infra-brain");
	});

	it("resolves a local folder to an absolute path", () => {
		const source = parseSource("./my-brain", "/work");
		assert.ok(source.kind === "local");
		assert.equal(source.name, "my-brain");
		assert.ok(source.path.replace(/\\/g, "/").endsWith("/work/my-brain"));
	});

	it("refuses things that are not sources, and names that could become git options", () => {
		assert.throws(() => parseSource("not a source"), /not a brain source/);
		assert.throws(() => parseSource("-oops/repo"), /not a GitHub name/);
		assert.throws(() => parseSource("someone/repo#--upload-pack=x"), /not a branch or tag/);
		assert.throws(() => parseSource("someone/repo/../../etc"), /'\.\.'/);
	});
});

describe("starter brains", () => {
	it("are found in this repository's brains/ folder", () => {
		assert.ok(STARTERS_DIR, "brains/ was found");
		assert.ok(listStarters().some((starter) => starter.name === "python-backend"));
	});

	for (const starter of listStarters()) {
		it(`${starter.name} adds cleanly to an empty vault, and its evals point at its notes`, () => {
			const root = vault();
			const result = addBrain({ vaultRoot: root, source: starter.name });

			const problems = result.compiled!.issues.filter((issue) => issue.severity !== "info");
			assert.deepEqual(problems, [], "no errors or warnings");

			const nodes = flatten(scanVault(root).root).filter((node) => node.path !== ".");
			const ids = new Set(nodes.map((node) => node.id));
			const suite = JSON.parse(readFileSync(join(STARTERS_DIR!, starter.name, "evals.json"), "utf8"));
			assert.ok(suite.evals.length >= 5, "at least five eval cases");
			for (const entry of suite.evals) assert.ok(ids.has(entry.expected), `${entry.id} expects ${entry.expected}, which exists`);
			for (const id of ids) {
				if (id && id !== "general_instructions") assert.match(id, /^(py_|python_)/, `${id} is prefixed so it cannot collide with a user's notes`);
			}
		});
	}
});

describe("adding a brain", () => {
	it("copies a starter's notes into their own folder and records the source", () => {
		const root = vault();
		const result = addBrain({ vaultRoot: root, source: "python-backend", now: () => new Date("2026-01-01T00:00:00Z") });

		assert.equal(result.folder, "python-backend");
		assert.ok(existsSync(join(root, "python-backend", "_about.md")));
		assert.ok(existsSync(join(root, "python-backend", "data", "py_sqlalchemy_async.md")));
		assert.equal(existsSync(join(root, "python-backend", "brain.json")), false, "metadata is recorded, not copied");

		const record = readSources(root).brains["python-backend"];
		assert.equal(record.kind, "starter");
		assert.equal(record.version, "1.0.0");
		assert.equal(record.installedAt, "2026-01-01T00:00:00.000Z");
		assert.ok(record.files["api/py_fastapi_auth.md"], "every file is hashed");
	});

	it("merges the brain's evals into the vault's suite, prefixed by its folder", () => {
		const root = vault();
		writeFileSync(join(root, "evals.json"), JSON.stringify({ version: 1, evals: [{ id: "mine", prompt: "p", expected: "general_instructions" }] }));

		const result = addBrain({ vaultRoot: root, source: "python-backend" });

		const suite = JSON.parse(readFileSync(join(root, "evals.json"), "utf8"));
		assert.equal(suite.evals[0].id, "mine", "your own cases are kept");
		assert.ok(suite.evals.some((entry: { id: string }) => entry.id === "python-backend/jwt"));
		assert.equal(result.evals, suite.evals.length - 1);
	});

	it("fetches a git repository and copies only notes and evals", () => {
		const root = vault();
		const source = repo(GO_BRAIN);

		const result = addBrain({ vaultRoot: root, source: source.url });

		assert.equal(result.folder, "go-brain");
		assert.match(result.commit ?? "", /^[0-9a-f]{40}$/);
		const copied = readdirSync(join(root, "go-brain")).sort();
		assert.deepEqual(copied, ["_about.md", "_index.json", "concurrency", "go_errors.md", "go_modules.md"]);
		assert.equal(result.compiled!.issues.filter((issue) => issue.severity === "error").length, 0);
	});

	// Creating symbolic links needs extra rights on Windows, and git checks them out there as plain files anyway.
	it("never follows a symbolic link out of the brain", { skip: process.platform === "win32" }, () => {
		const secret = join(tempDir(), "credentials");
		writeFileSync(secret, "aws_secret_access_key = do-not-copy\n");
		const outside = tempDir();
		writeFileSync(join(outside, "_about.md"), note({ id: "outside", title: "Outside", criteria: "outside" }));
		const source = repo(GO_BRAIN);
		symlinkSync(secret, join(source.dir, "leak.md"));
		symlinkSync(outside, join(source.dir, "escape"));
		source.commit({});

		const root = vault();
		addBrain({ vaultRoot: root, source: source.url });
		assert.equal(existsSync(join(root, "go-brain", "leak.md")), false, "a linked file is skipped");
		assert.equal(existsSync(join(root, "go-brain", "escape")), false, "a linked folder is skipped");
	});

	it("puts a brain where --as says, including inside an existing folder", () => {
		const root = vault();
		mkdirSync(join(root, "Languages"));
		write(root, { "Languages/_about.md": note({ id: "languages", title: "Languages", criteria: "Programming language specific guides" }) });

		const result = addBrain({ vaultRoot: root, source: repo(GO_BRAIN).url, as: "Languages/go" });

		assert.equal(result.folder, "Languages/go");
		assert.ok(existsSync(join(root, "Languages", "go", "go_errors.md")));
	});

	it("writes an _about.md from brain.json when the brain has none", () => {
		const root = vault();
		const files: Record<string, string> = { ...GO_BRAIN, "brain.json": JSON.stringify({ name: "go", title: "Go", description: "Go services and tooling" }) };
		delete files["_about.md"];

		const result = addBrain({ vaultRoot: root, source: repo(files).url });

		assert.equal(result.folder, "go", "the name from brain.json");
		assert.match(readFileSync(join(root, "go", "_about.md"), "utf8"), /criteria: Go services and tooling/);
	});

	it("adds a folder on disk, for trying a brain before publishing it", () => {
		const root = vault();
		const local = scratch(GO_BRAIN, "my-brain-");

		const result = addBrain({ vaultRoot: root, source: local });

		assert.equal(result.source.kind, "local");
		assert.ok(existsSync(join(root, result.folder, "go_errors.md")));
	});

	it("reports without writing on a dry run", () => {
		const root = vault();
		const result = addBrain({ vaultRoot: root, source: "python-backend", dryRun: true });

		assert.ok(result.added.includes("api/py_fastapi_auth.md"));
		assert.equal(existsSync(join(root, "python-backend")), false);
		assert.equal(existsSync(join(root, SOURCES_FILE)), false);
	});

	it("refuses a folder that already exists or already holds a brain", () => {
		const root = vault();
		addBrain({ vaultRoot: root, source: "python-backend" });
		assert.throws(() => addBrain({ vaultRoot: root, source: "python-backend" }), /already holds python-backend/);

		write(root, { "Mine/note.md": note({ id: "mine", title: "Mine", criteria: "mine" }) });
		assert.throws(() => addBrain({ vaultRoot: root, source: "python-backend", as: "Mine" }), /already exists/);
	});

	it("refuses a brain with nothing to route by", () => {
		const files: Record<string, string> = { ...GO_BRAIN };
		delete files["_about.md"];
		assert.throws(() => addBrain({ vaultRoot: vault(), source: repo(files).url }), /no _about\.md/);
	});

	it("refuses to push a folder past the 15-entry limit", () => {
		const root = vault();
		const notes: Record<string, string> = {};
		for (let i = 0; i < 14; i++) notes[`note_${i}.md`] = note({ id: `note_${i}`, title: `Note ${i}`, criteria: `topic number ${i}` });
		write(root, notes);
		compileVault(root);

		assert.throws(() => addBrain({ vaultRoot: root, source: "python-backend" }), /already has 15 entries.*--as/s);
	});

	it("says clearly when a starter does not exist", () => {
		assert.throws(() => addBrain({ vaultRoot: vault(), source: "no-such-brain" }), /no starter brain 'no-such-brain'.*python-backend/);
	});
});

describe("updating a brain", () => {
	it("adds new notes and replaces untouched ones, but keeps the ones you edited", () => {
		const root = vault();
		const source = repo(GO_BRAIN);
		const first = addBrain({ vaultRoot: root, source: source.url });

		// Upstream: both notes change and a new one appears. Locally: one of the two is edited.
		const edited = "---\nid: go_modules\ntitle: Go Modules\ncriteria: my own criteria\n---\n\nMy notes.\n";
		writeFileSync(join(root, "go-brain", "go_modules.md"), edited);
		const next = source.commit({
			"go_errors.md": note({ id: "go_errors", title: "Go Errors", criteria: "Wrapping and checking errors in Go" }, "Wrap with %w, check with errors.Is.\n"),
			"go_modules.md": note({ id: "go_modules", title: "Go Modules", criteria: "go.mod and go get" }, "Upstream change.\n"),
			"go_testing.md": note({ id: "go_testing", title: "Go Testing", criteria: "Table-driven tests, t.Run subtests and benchmarks in Go" }, "Use t.Run.\n"),
		});

		const result = updateBrains({ vaultRoot: root });
		const update = result.updates[0];

		assert.deepEqual(update.updated, ["go_errors.md"]);
		assert.deepEqual(update.added, ["go_testing.md"]);
		assert.deepEqual(update.kept, ["go_modules.md"]);
		assert.equal(update.from, first.commit);
		assert.equal(update.to, next);
		assert.match(readFileSync(join(root, "go-brain", "go_errors.md"), "utf8"), /errors\.Is/);
		assert.equal(readFileSync(join(root, "go-brain", "go_modules.md"), "utf8"), edited, "your edit survives");
		assert.equal(readSources(root).brains["go-brain"].commit, next);

		const again = updateBrains({ vaultRoot: root }).updates[0];
		assert.deepEqual([again.added, again.updated], [[], []], "already up to date");
		assert.deepEqual(again.kept, ["go_modules.md"], "and still keeps your edit");
	});

	it("does not bring back a note you deleted", () => {
		const root = vault();
		const source = repo(GO_BRAIN);
		addBrain({ vaultRoot: root, source: source.url });
		const path = join(root, "go-brain", "go_modules.md");
		rmSync(path);

		updateBrains({ vaultRoot: root });

		assert.equal(existsSync(path), false);
	});

	it("changes nothing on a dry run", () => {
		const root = vault();
		const source = repo(GO_BRAIN);
		addBrain({ vaultRoot: root, source: source.url });
		source.commit({ "go_new.md": note({ id: "go_new", title: "New", criteria: "something new in Go" }) });

		const result = updateBrains({ vaultRoot: root, dryRun: true });

		assert.deepEqual(result.updates[0].added, ["go_new.md"]);
		assert.equal(existsSync(join(root, "go-brain", "go_new.md")), false);
	});

	it("reports a source that cannot be fetched without failing the others", () => {
		const root = vault();
		addBrain({ vaultRoot: root, source: "python-backend" });
		addBrain({ vaultRoot: root, source: repo(GO_BRAIN).url });
		const record = JSON.parse(readFileSync(join(root, SOURCES_FILE), "utf8"));
		record.brains["go-brain"].source = pathToFileURL(join(tempDir(), "gone")).href;
		writeFileSync(join(root, SOURCES_FILE), JSON.stringify(record));

		const result = updateBrains({ vaultRoot: root });

		assert.match(result.updates.find((update) => update.folder === "go-brain")!.error ?? "", /could not fetch/);
		assert.equal(result.updates.find((update) => update.folder === "python-backend")!.error, undefined);
	});

	it("refuses a folder that was not added as a brain", () => {
		assert.throws(() => updateBrains({ vaultRoot: vault(), folder: "Backend" }), /not a brain added/);
	});
});
