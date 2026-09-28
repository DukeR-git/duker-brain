import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { describe, it } from "node:test";

import { ManifestStore, validateManifest } from "../src/manifest.js";
import { assertInsideVault, isInsideVaultOn, normaliseVaultPath, resolveInVault, VaultPathError } from "../src/paths.js";
import { collectIssues, compareText, compileVault, findNode, flatten, scanVault } from "../src/vault.js";
import type { VaultIssueCode } from "../src/types.js";
import { FIXTURE, fixtureCopy, note, scratch } from "./helpers.js";

function codes(root: string): VaultIssueCode[] {
	return collectIssues(scanVault(root)).map((issue) => issue.code);
}

describe("scanVault", () => {
	it("reads branch criteria from _about.md and leaf criteria from frontmatter", () => {
		const tree = scanVault(FIXTURE);
		const backend = findNode(tree.root, "Backend")!;

		assert.equal(backend.kind, "branch");
		assert.equal(backend.id, "backend");
		assert.equal(backend.title, "Backend");
		assert.match(backend.criteria, /connection pooling/);
		assert.ok(backend.aboutPath);

		const leaf = findNode(tree.root, "Backend/asyncpg_pooling.md")!;
		assert.equal(leaf.kind, "leaf");
		assert.equal(leaf.id, "asyncpg_pooling");
		assert.equal(leaf.title, "asyncpg Connection Pooling");
	});

	it("counts the fixture vault and finds nothing wrong with it", () => {
		const tree = scanVault(FIXTURE);
		assert.deepEqual(tree.counts, { branches: 4, leaves: 9 });
		assert.deepEqual(collectIssues(tree), []);
	});

	it("never treats _about.md or _index.json as a leaf", () => {
		const paths = flatten(scanVault(FIXTURE).root).map((node) => node.path);
		assert.ok(!paths.some((path) => path.endsWith("_about.md")));
		assert.ok(!paths.some((path) => path.endsWith("_index.json")));
	});

	it("ignores dotfiles, .obsidian, and non-markdown attachments", () => {
		const root = scratch({
			"a.md": note({ id: "a", criteria: "the first note about things" }),
			"diagram.png": "not markdown",
			".hidden.md": note({ id: "hidden", criteria: "should not appear at all" }),
			".obsidian/workspace.json": "{}",
		});
		const leaves = flatten(scanVault(root).root).filter((node) => node.kind === "leaf");
		assert.deepEqual(leaves.map((leaf) => leaf.id), ["a"]);
	});

	it("marks the fallback note and orders it last", () => {
		const children = scanVault(FIXTURE).root.children!;
		assert.equal(children.at(-1)!.id, "general_instructions");
		assert.equal(children.at(-1)!.fallback, true);
	});
});

describe("issues", () => {
	it("flags a folder with no _about.md", () => {
		const root = scratch({
			"root.md": note({ id: "r", criteria: "a root level note about something" }),
			"Sub/a.md": note({ id: "a", criteria: "a note inside the subfolder here" }),
		});
		assert.ok(codes(root).includes("missing-about"));
	});

	it("flags a note with no criteria", () => {
		const root = scratch({ "a.md": note({ id: "a", title: "A" }) });
		assert.ok(codes(root).includes("missing-criteria"));
	});

	it("flags a folder over the 15-child limit", () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 16; index++) {
			files[`n${index}.md`] = note({ id: `n${index}`, criteria: `note number ${index} about a distinct topic` });
		}
		const issues = collectIssues(scanVault(scratch(files)));
		const issue = issues.find((item) => item.code === "too-many-children")!;

		assert.equal(issue.severity, "error");
		assert.match(issue.message, /16 children exceeds the 15 limit/);
		assert.match(issue.remedy!, /brain_split_branch/);
	});

	it("flags thin and verbose criteria", () => {
		const root = scratch({
			"thin.md": note({ id: "thin", criteria: "code stuff" }),
			"verbose.md": note({ id: "verbose", criteria: "word ".repeat(45).trim() }),
		});
		const found = codes(root);
		assert.ok(found.includes("thin-criteria"));
		assert.ok(found.includes("verbose-criteria"));
	});

	it("flags siblings the model cannot tell apart", () => {
		const root = scratch({
			"a.md": note({ id: "a", criteria: "database connections and pooling behaviour" }),
			"b.md": note({ id: "b", criteria: "Database  Connections and pooling behaviour" }),
		});
		assert.ok(codes(root).includes("duplicate-criteria"));
	});

	it("flags two notes that slugify to the same id", () => {
		const root = scratch({
			"my note.md": note({ criteria: "the first note with a clashing name" }),
			"my-note.md": note({ criteria: "the second note with a clashing name" }),
		});
		assert.ok(codes(root).includes("duplicate-id"));
	});

	it("flags an empty folder and an empty note", () => {
		const root = scratch({
			"a.md": note({ id: "a", criteria: "a note that does have some content" }),
			"Empty/_about.md": note({ id: "empty", criteria: "a folder with nothing inside it at all" }, ""),
			"blank.md": note({ id: "blank", criteria: "a note with no body content at all" }, ""),
		});
		const found = codes(root);
		assert.ok(found.includes("empty-branch"));
		assert.ok(found.includes("empty-body"));
	});

	it("flags a vault with no fallback note", () => {
		const root = scratch({ "a.md": note({ id: "a", criteria: "the only note in this whole vault" }) });
		assert.ok(codes(root).includes("no-fallback"));
	});

	it("orders issues worst-first", () => {
		const root = scratch({
			"thin.md": note({ id: "thin", criteria: "two words" }),
			"nocrit.md": note({ id: "nocrit" }),
		});
		const issues = collectIssues(scanVault(root));
		assert.equal(issues[0].severity, "error");
	});
});

describe("compileVault", () => {
	it("is a no-op on an already-compiled vault", () => {
		// The manifests in the fixture vault were produced by this compiler, so a
		// second run must not produce a diff. Without a stable ordering this would
		// churn on every write.
		const result = compileVault(FIXTURE, { dryRun: true });
		assert.deepEqual(
			result.files.filter((file) => file.status !== "unchanged"),
			[],
		);
	});

	it("emits manifests the traverser's own validator accepts", () => {
		const root = scratch({
			"general.md": note({ id: "general", criteria: "the catch all note for anything else", fallback: "true" }),
			"Sub/_about.md": note({ id: "sub", title: "Sub", criteria: "a subfolder holding related notes about things" }),
			"Sub/a.md": note({ id: "a", title: "A Note", criteria: "the first note inside the subfolder" }),
		});
		compileVault(root);

		const rootEntries = validateManifest(JSON.parse(readFileSync(join(root, "_index.json"), "utf8")), "root");
		assert.deepEqual(
			rootEntries.map((entry) => [entry.id, entry.type, entry.targetPath]),
			[
				["sub", "branch", "Sub"],
				["general", "leaf", "general.md"],
			],
		);
		assert.equal(rootEntries[1].fallback, true);

		const subEntries = validateManifest(JSON.parse(readFileSync(join(root, "Sub", "_index.json"), "utf8")), "sub");
		assert.equal(subEntries[0].title, "A Note");
	});

	it("does not write a manifest for an empty folder", () => {
		const root = scratch({ "a.md": note({ id: "a", criteria: "a note that keeps the root non empty" }) });
		mkdirSync(join(root, "Empty"));
		const result = compileVault(root);
		const empty = result.files.find((file) => file.path === "Empty/_index.json")!;

		// An empty array is not a valid manifest; writing one would make the
		// traverser throw instead of fall back.
		assert.equal(empty.status, "skipped");
		assert.match(empty.reason!, /no children/);
	});

	it("dryRun reports changes without touching disk", () => {
		const root = scratch({ "a.md": note({ id: "a", criteria: "a note in a vault with no manifests yet" }) });
		const result = compileVault(root, { dryRun: true });

		assert.equal(result.files[0].status, "written");
		assert.throws(() => readFileSync(join(root, "_index.json"), "utf8"));
	});

	it("can compile a single subtree", () => {
		const root = fixtureCopy();
		writeFileSync(join(root, "Backend", "_index.json"), "[]", "utf8");

		const result = compileVault(root, { subtree: "Backend" });
		assert.deepEqual(result.files.map((file) => file.path), ["Backend/_index.json"]);
		assert.equal(result.files[0].status, "written");
	});

	it("refuses a subtree outside the vault", () => {
		const root = scratch({ "a.md": note({ id: "a", criteria: "a note to keep the vault valid" }) });
		assert.throws(() => compileVault(root, { subtree: "../.." }), VaultPathError);
	});
});

describe("path safety", () => {
	it("refuses a path outside the vault", () => {
		const root = scratch();
		assert.throws(() => assertInsideVault(root, join(root, "..", "elsewhere"), "target"), VaultPathError);
		assert.throws(() => resolveInVault(root, "../../etc/passwd"), VaultPathError);
	});

	it("accepts the root itself and paths below it", () => {
		const root = scratch();
		assert.equal(resolveInVault(root, "."), resolve(root));
		assert.equal(resolveInVault(root, ""), resolve(root));
		assert.equal(resolveInVault(root, "Sub/a.md"), resolve(root, "Sub/a.md"));
	});

	it("strips a leading slash rather than escaping to the filesystem root", () => {
		const root = scratch();
		assert.equal(resolveInVault(root, "/Sub/a.md"), resolve(root, "Sub/a.md"));
	});
});

describe("the compiler never writes a manifest the traverser rejects", () => {
	it("gives a note with no Latin letters a hashed id, and says so", () => {
		const root = scratch({
			"general.md": note({ criteria: "the catch all note for anything else here", fallback: "true" }),
			"日本語.md": note({ criteria: "japanese notes about something in particular" }),
		});
		compileVault(root);

		const manifest = new ManifestStore(root, false).load(root)!;
		assert.ok(manifest.entries.some((entry) => /^id_[0-9a-f]{8}$/.test(entry.id)));
		assert.ok(codes(root).includes("hashed-id"));
	});

	it("leaves a duplicate id out of the manifest instead of breaking the folder", () => {
		const root = scratch({
			"my note.md": note({ criteria: "the first note with a clashing name here" }),
			"my-note.md": note({ criteria: "the second note with a clashing name here" }),
			"other.md": note({ criteria: "a third note that has a name of its own" }),
		});
		const result = compileVault(root);

		const manifest = new ManifestStore(root, false).load(root)!;
		assert.deepEqual(manifest.entries.map((entry) => entry.id), ["my_note", "other"]);
		assert.match(result.files[0].reason ?? "", /left out duplicate id\(s\): my-note\.md/);
		assert.ok(codes(root).includes("duplicate-id"), "and the doctor still reports it");
	});

	it("leaves empty folders out of their parent, however deeply empty", () => {
		const root = scratch({
			"general.md": note({ criteria: "the catch all note for anything else here", fallback: "true" }),
			"Empty/_about.md": note({ criteria: "a folder with no notes inside it yet at all" }),
			"Hollow/Inner/_about.md": note({ criteria: "a folder whose only child is itself empty" }),
			"Hollow/_about.md": note({ criteria: "a folder holding only an empty subfolder here" }),
		});
		compileVault(root);
		const ids = validateManifest(JSON.parse(readFileSync(join(root, "_index.json"), "utf8")), "root").map((e) => e.id);
		assert.deepEqual(ids, ["general"]);
	});

	it("writes manifests atomically, leaving no temp files behind", () => {
		const root = fixtureCopy();
		writeFileSync(join(root, "Backend", "_index.json"), "[]", "utf8");
		compileVault(root);
		const names = flatten(scanVault(root).root).map((node) => node.path);
		assert.ok(!names.some((path) => path.endsWith(".tmp")));
		assert.equal(validateManifest(JSON.parse(readFileSync(join(root, "Backend", "_index.json"), "utf8")), "b").length, 4);
	});
});

describe("more issues", () => {
	it("reports frontmatter the parser had to guess at", () => {
		const root = scratch({ "a.md": "---\ncriteria: one thing\ncriteria: another thing entirely\n---\nx\n" });
		assert.ok(codes(root).includes("bad-frontmatter"));
	});

	it("normalises a non-slug id and says what the router will see", () => {
		const root = scratch({ "a.md": note({ id: "My Note", criteria: "a note with a human written identifier" }) });
		const tree = scanVault(root);
		assert.equal(tree.root.children![0].id, "my_note");
		const info = collectIssues(tree).find((item) => item.code === "non-slug-id")!;
		assert.equal(info.severity, "info");
	});

	it("flags folders the router cannot reach within maxHops", () => {
		const files: Record<string, string> = {};
		let path = "";
		for (const level of ["A", "B", "C"]) {
			path = path ? `${path}/${level}` : level;
			files[`${path}/_about.md`] = note({ criteria: `folder level ${level} with its own distinct topic words` });
			files[`${path}/n.md`] = note({ criteria: `a note at level ${level} about its own distinct topic` });
		}
		const root = scratch(files);
		assert.ok(!codes(root).includes("too-deep"), "three levels fit in four hops");

		const issues = collectIssues(scanVault(root, { maxHops: 2 })).filter((item) => item.code === "too-deep");
		assert.deepEqual(issues.map((item) => item.path), ["A/B"]);

		const tooDeepToScan = collectIssues(scanVault(root, { maxDepth: 1 })).filter((item) => item.code === "too-deep");
		assert.deepEqual(tooDeepToScan.map((item) => item.path), ["A/B"]);
	});

	it("allows one catch-all per folder, and warns about two", () => {
		const root = scratch({
			"general.md": note({ criteria: "the root catch all note for any request", fallback: "true" }),
			"Sub/_about.md": note({ criteria: "a subfolder holding related notes about things" }),
			"Sub/a.md": note({ criteria: "the sub folder's own catch all note here", fallback: "true" }),
			"Sub/b.md": note({ criteria: "a second catch all note in the same folder", fallback: "true" }),
		});
		const issues = collectIssues(scanVault(root)).filter((item) => item.code === "multiple-fallbacks");
		assert.deepEqual(issues.map((item) => item.path), ["Sub"]);
	});
});

describe(".brainignore", () => {
	it("keeps listed folders and notes out of the tree", () => {
		const root = scratch({
			".brainignore": "# not part of the brain\nTemplates\nDaily */\nNotes/draft_*.md\n",
			"general.md": note({ criteria: "the catch all note for anything else here", fallback: "true" }),
			"Templates/t.md": note({ criteria: "a template that is not knowledge at all" }),
			"Daily 2026/day.md": note({ criteria: "a daily note that is not knowledge either" }),
			"Notes/_about.md": note({ criteria: "a folder of real notes about real topics" }),
			"Notes/real.md": note({ criteria: "a real note about a real topic here" }),
			"Notes/draft_x.md": note({ criteria: "a draft that should stay out for now" }),
		});
		const paths = flatten(scanVault(root).root).map((node) => node.path);
		assert.deepEqual(paths.sort(compareText), [".", "Notes", "Notes/real.md", "general.md"]);
	});
});

describe("ordering", () => {
	it("sorts by code point, not by the machine's locale", () => {
		assert.deepEqual(["b", "B", "a_b", "ab", "a"].sort(compareText), ["B", "a", "a_b", "ab", "b"]);
	});
});

describe("path safety on Windows", () => {
	it("refuses a path on another drive", () => {
		// relative("C:\\vault", "D:\\x") is the absolute "D:\\x": no "..", but outside.
		assert.equal(isInsideVaultOn(win32, "C:\\vault", "D:\\secret.md"), false);
		assert.equal(isInsideVaultOn(win32, "C:\\vault", "c:\\VAULT\\notes\\a.md"), true, "drive letters and case are not a difference");
		assert.equal(isInsideVaultOn(win32, "C:\\vault", "C:\\vault2\\a.md"), false);
		assert.equal(isInsideVaultOn(win32, "C:\\vault", "C:\\vault\\..foo\\a.md"), true, "a name starting with .. is still inside");
	});

	it("refuses another drive through the real resolver when running on Windows", { skip: process.platform !== "win32" }, () => {
		const root = scratch();
		const other = root.toUpperCase().startsWith("Z:") ? "Y:\\x.md" : "Z:\\x.md";
		assert.throws(() => resolveInVault(root, other), VaultPathError);
		assert.throws(() => assertInsideVault(root, other, "note"), VaultPathError);
	});

	it("normalises vault-relative paths for lookups", () => {
		assert.equal(normaliseVaultPath("Backend\\sub/"), "Backend/sub");
		assert.equal(normaliseVaultPath("./"), ".");
		assert.equal(normaliseVaultPath(""), ".");
		assert.equal(normaliseVaultPath("./Backend//x"), "Backend/x");
	});
});
