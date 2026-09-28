import assert from "node:assert/strict";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { splitFrontmatter } from "../src/frontmatter.js";
import { ManifestError, ManifestStore, manifestWarnings, validateManifest } from "../src/manifest.js";
import { FIXTURE as VAULT, scratch as scratchVault } from "./helpers.js";

describe("validateManifest", () => {
	const good = [{ id: "a", type: "leaf", criteria: "some criteria text", targetPath: "a.md" }];

	it("accepts a well-formed manifest", () => {
		const entries = validateManifest(good, "test");
		assert.equal(entries.length, 1);
		assert.equal(entries[0].fallback, false);
	});

	it("rejects a non-array", () => {
		assert.throws(() => validateManifest({}, "test"), ManifestError);
	});

	it("rejects an empty manifest", () => {
		assert.throws(() => validateManifest([], "test"), /empty/);
	});

	it("rejects a missing field", () => {
		assert.throws(() => validateManifest([{ id: "a", type: "leaf", criteria: "x" }], "test"), /targetPath/);
	});

	it("rejects an unknown node type", () => {
		assert.throws(
			() => validateManifest([{ ...good[0], type: "twig" }], "test"),
			/must be 'branch' or 'leaf'/,
		);
	});

	it("rejects duplicate ids", () => {
		// Two entries with one id make the probability map ambiguous.
		assert.throws(() => validateManifest([good[0], { ...good[0] }], "test"), /duplicate entry id/);
	});
});

describe("manifestWarnings", () => {
	it("flags a node with more than 15 children", () => {
		const entries = Array.from({ length: 16 }, (_, index) => ({
			id: `n${index}`,
			type: "leaf" as const,
			criteria: "a reasonably descriptive criteria string here",
			targetPath: `n${index}.md`,
		}));
		const warnings = manifestWarnings(entries, "big");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /16 children exceeds the 15 limit/);
	});

	it("flags criteria too thin to discriminate", () => {
		const warnings = manifestWarnings(
			[{ id: "a", type: "leaf", criteria: "code stuff", targetPath: "a.md" }],
			"thin",
		);
		assert.match(warnings[0], /2 word\(s\)/);
	});

	it("flags more than one fallback entry", () => {
		const warnings = manifestWarnings(
			[
				{ id: "a", type: "leaf", criteria: "a reasonably descriptive criteria string", targetPath: "a.md", fallback: true },
				{ id: "b", type: "leaf", criteria: "another reasonably descriptive criteria string", targetPath: "b.md", fallback: true },
			],
			"two",
		);
		assert.match(warnings.join("\n"), /2 entries are marked as the fallback/);
	});

	it("is quiet about the fixture vault", () => {
		const store = new ManifestStore(VAULT, false);
		for (const dir of [VAULT, join(VAULT, "Backend"), join(VAULT, "Frontend"), join(VAULT, "Infrastructure")]) {
			const manifest = store.load(dir)!;
			assert.deepEqual(manifestWarnings(manifest.entries, dir), []);
		}
	});
});

describe("ManifestStore", () => {
	it("returns null for a directory without a manifest", () => {
		const store = new ManifestStore(VAULT, false);
		assert.equal(store.load(join(VAULT, "Backend", "nope")), null);
	});

	it("reports paths relative to the vault with forward slashes", () => {
		const store = new ManifestStore(VAULT, false);
		assert.equal(store.relativeToVault(join(VAULT, "Backend", "fastapi_core.md")), "Backend/fastapi_core.md");
		assert.equal(store.relativeToVault(VAULT), ".");
	});

	it("refuses a targetPath that escapes the vault", () => {
		// A generated manifest is still data; a stray `../..` must not hand the
		// agent an arbitrary file off the disk.
		const root = scratchVault({
			"_index.json": JSON.stringify([
				{ id: "escape", type: "leaf", criteria: "malicious entry here", targetPath: "../../../etc/passwd" },
			]),
		});
		const store = new ManifestStore(root, false);
		const manifest = store.load(root)!;

		assert.throws(() => store.resolveTarget(manifest, manifest.entries[0]), /escapes the vault root/);
	});

	it("re-reads a manifest after it changes on disk", async () => {
		const root = scratchVault({
			"_index.json": JSON.stringify([
				{ id: "one", type: "leaf", criteria: "the first entry here", targetPath: "one.md" },
			]),
		});
		const store = new ManifestStore(root, true);
		assert.equal(store.load(root)!.entries[0].id, "one");

		await new Promise((done) => setTimeout(done, 15));
		writeFileSync(
			join(root, "_index.json"),
			JSON.stringify([{ id: "two", type: "leaf", criteria: "the second entry here", targetPath: "two.md" }]),
			"utf8",
		);

		assert.equal(store.load(root)!.entries[0].id, "two");
	});

	it("notices a rewrite that kept the old mtime", () => {
		// FAT and some network shares store coarse timestamps, so a rewrite can land
		// on the same mtime; the size is part of the cache key for that reason.
		const root = scratchVault({
			"_index.json": JSON.stringify([{ id: "one", type: "leaf", criteria: "the first entry here", targetPath: "one.md" }]),
		});
		const store = new ManifestStore(root, true);
		assert.equal(store.load(root)!.entries[0].id, "one");

		const path = join(root, "_index.json");
		const { atime, mtime } = statSync(path);
		writeFileSync(
			path,
			JSON.stringify([{ id: "three", type: "leaf", criteria: "a longer third entry here", targetPath: "three.md" }]),
			"utf8",
		);
		utimesSync(path, atime, mtime);

		assert.equal(store.load(root)!.entries[0].id, "three");
	});

	it("keeps the cached parse when watching is off", async () => {
		const root = scratchVault({
			"_index.json": JSON.stringify([
				{ id: "one", type: "leaf", criteria: "the first entry here", targetPath: "one.md" },
			]),
		});
		const store = new ManifestStore(root, false);
		store.load(root);

		await new Promise((done) => setTimeout(done, 15));
		writeFileSync(
			join(root, "_index.json"),
			JSON.stringify([{ id: "two", type: "leaf", criteria: "the second entry here", targetPath: "two.md" }]),
			"utf8",
		);

		assert.equal(store.load(root)!.entries[0].id, "one");
		store.clear();
		assert.equal(store.load(root)!.entries[0].id, "two");
	});

	it("reports malformed JSON with the offending path", () => {
		const root = scratchVault({ "_index.json": "{ not json" });
		const store = new ManifestStore(root, false);
		assert.throws(() => store.load(root), /invalid JSON/);
	});
});

describe("splitFrontmatter", () => {
	it("extracts the title and strips the block", () => {
		const { title, body } = splitFrontmatter("---\nid: x\ntitle: My Guide\n---\n\n# Heading\n");
		assert.equal(title, "My Guide");
		assert.equal(body.trim(), "# Heading");
	});

	it("strips surrounding quotes from the title", () => {
		assert.equal(splitFrontmatter('---\ntitle: "Quoted: Title"\n---\nbody').title, "Quoted: Title");
	});

	it("passes a document without frontmatter through untouched", () => {
		const markdown = "# Heading\n\nbody\n";
		const { title, body } = splitFrontmatter(markdown);
		assert.equal(title, undefined);
		assert.equal(body, markdown);
	});

	it("survives frontmatter with no title", () => {
		const { title, body } = splitFrontmatter("---\nid: x\n---\nbody");
		assert.equal(title, undefined);
		assert.equal(body, "body");
	});
});
