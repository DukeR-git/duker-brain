import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isHashedId, parseNote, serialiseNote, slugify } from "../src/frontmatter.js";

describe("parseNote", () => {
	it("reads the owned fields", () => {
		const note = parseNote("---\nid: x\ntitle: My Guide\ncriteria: when to pick it\nfallback: true\n---\n\nbody\n");
		assert.deepEqual(note.frontmatter, {
			id: "x",
			title: "My Guide",
			criteria: "when to pick it",
			fallback: true,
		});
		assert.equal(note.body, "body\n");
		assert.equal(note.hadFrontmatter, true);
	});

	it("keeps frontmatter it does not own", () => {
		// An Obsidian vault is full of tags, aliases and plugin keys. Losing them
		// on every tool write would be worse than not writing at all.
		const note = parseNote("---\ntitle: T\ntags:\n  - one\n  - two\naliases: [a, b]\n---\nbody");
		assert.deepEqual(note.extraLines, ["tags:", "  - one", "  - two", "aliases: [a, b]"]);
	});

	it("treats a missing block as an empty one", () => {
		const note = parseNote("# Just a heading\n");
		assert.equal(note.hadFrontmatter, false);
		assert.deepEqual(note.frontmatter, {});
		assert.equal(note.body, "# Just a heading\n");
	});

	it("strips quotes and reads falsey fallback values", () => {
		assert.equal(parseNote('---\ntitle: "Quoted: Title"\n---\nx').frontmatter.title, "Quoted: Title");
		assert.equal(parseNote("---\nfallback: false\n---\nx").frontmatter.fallback, false);
	});

	it("handles CRLF line endings", () => {
		const note = parseNote("---\r\ntitle: T\r\n---\r\nbody");
		assert.equal(note.frontmatter.title, "T");
		assert.equal(note.body, "body");
	});
});

describe("serialiseNote", () => {
	it("round-trips a note without losing anything", () => {
		const original = "---\nid: x\ntitle: T\ncriteria: some criteria words\ntags:\n  - a\n---\n\n# Body\n\ntext\n";
		const note = parseNote(original);
		const written = serialiseNote(note);

		const reparsed = parseNote(written);
		assert.deepEqual(reparsed.frontmatter, note.frontmatter);
		assert.deepEqual(reparsed.extraLines, note.extraLines);
		assert.equal(reparsed.body, note.body);
	});

	it("puts the owned keys first, in a stable order", () => {
		const note = parseNote("---\ntags:\n  - a\ncriteria: c words here\ntitle: T\nid: i\n---\nbody");
		const lines = serialiseNote(note).split("\n");
		assert.deepEqual(lines.slice(1, 5), ["id: i", "title: T", "criteria: c words here", "tags:"]);
	});

	it("omits fallback when it is false", () => {
		const note = parseNote("---\nid: x\nfallback: false\n---\nbody");
		assert.ok(!serialiseNote(note).includes("fallback"));
	});

	it("quotes a value that would otherwise be misread as YAML", () => {
		const note = parseNote("---\nid: x\n---\nbody");
		note.frontmatter.title = "Note: a subtitle";
		note.frontmatter.criteria = "- starts with a dash";
		const written = serialiseNote(note);

		assert.ok(written.includes('title: "Note: a subtitle"'));
		assert.ok(written.includes('criteria: "- starts with a dash"'));
		assert.equal(parseNote(written).frontmatter.title, "Note: a subtitle");
		assert.equal(parseNote(written).frontmatter.criteria, "- starts with a dash");
	});

	it("emits a bare body when there is no frontmatter to write", () => {
		assert.equal(serialiseNote({ frontmatter: {}, extraLines: [], hadFrontmatter: false, body: "hi" }), "hi");
	});
});

describe("round trips that used to lose data", () => {
	it("keeps backslashes stable across any number of writes", () => {
		// quote() escapes a backslash; unquote() must undo exactly that, or every
		// write doubles them (C:\Users -> C:\\Users -> C:\\\\Users).
		let note = parseNote("---\nid: x\n---\nbody");
		note.frontmatter.criteria = "Windows paths: C:\\Users and \\\\server\\share";
		for (let write = 0; write < 3; write++) note = parseNote(serialiseNote(note));
		assert.equal(note.frontmatter.criteria, "Windows paths: C:\\Users and \\\\server\\share");
	});

	it("reads YAML escapes in double quotes and doubled quotes in single quotes", () => {
		assert.equal(parseNote('---\ntitle: "say \\"hi\\"\\tthere"\n---\n').frontmatter.title, 'say "hi"\tthere');
		assert.equal(parseNote("---\ntitle: 'it''s here'\n---\n").frontmatter.title, "it's here");
	});

	it("folds block scalars, wrapped scalars and keyword lists into one line", () => {
		const folded = parseNote("---\nid: a\ncriteria: >\n  long folded\n  criteria text\ntags:\n  - x\n---\nbody\n");
		assert.equal(folded.frontmatter.criteria, "long folded criteria text");
		assert.deepEqual(folded.extraLines, ["tags:", "  - x"], "the continuation lines are not orphaned");

		const literal = parseNote("---\ncriteria: |-\n  line one\n\n  line two\n---\n");
		assert.equal(literal.frontmatter.criteria, "line one line two");

		const wrapped = parseNote("---\ncriteria: PostgreSQL pooling,\n  PgBouncer transaction mode\n---\n");
		assert.equal(wrapped.frontmatter.criteria, "PostgreSQL pooling, PgBouncer transaction mode");

		const list = parseNote("---\ncriteria:\n  - postgres\n  - \"pool sizing\"\n---\n");
		assert.equal(list.frontmatter.criteria, "postgres, pool sizing");
	});

	it("writes a folded value back as valid single-line YAML", () => {
		const note = parseNote("---\nid: a\ncriteria: >\n  long folded\n  criteria text\ntags:\n  - x\n---\nbody\n");
		const written = serialiseNote(note);
		assert.match(written, /^---\nid: a\ncriteria: long folded criteria text\ntags:\n {2}- x\n---\n/);
		assert.deepEqual(parseNote(written).frontmatter, note.frontmatter);
	});

	it("drops a trailing YAML comment the way YAML does", () => {
		assert.equal(parseNote("---\ncriteria: pools, sizing # tune later\n---\n").frontmatter.criteria, "pools, sizing");
		assert.equal(parseNote('---\ntitle: "a # b"  # note\n---\n').frontmatter.title, "a # b");
		assert.equal(parseNote("---\ntitle: C# tips\n---\n").frontmatter.title, "C# tips", "no space before #, not a comment");
	});

	it("quotes values YAML would read as something other than a string", () => {
		const note = parseNote("---\nid: x\n---\nbody");
		for (const title of ["2024", "true", "null", "[draft]", "{x}", "a # b", "'quoted'", "ends with:", "1.5e3"]) {
			note.frontmatter.title = title;
			const written = serialiseNote(note);
			assert.match(written, /^---\nid: x\ntitle: "/m, `${title} is quoted`);
			assert.equal(parseNote(written).frontmatter.title, title);
		}
		note.frontmatter.title = "Plain words";
		assert.match(serialiseNote(note), /title: Plain words\n/);
	});

	it("handles a BOM, an empty block and an unclosed block", () => {
		const bom = parseNote("\uFEFF---\ntitle: T\n---\nbody");
		assert.equal(bom.frontmatter.title, "T");
		assert.equal(bom.body, "body");

		const empty = parseNote("---\n---\nbody");
		assert.equal(empty.hadFrontmatter, true);
		assert.equal(empty.body, "body");

		const unclosed = parseNote("---\ntitle: T\nbody without a closing fence");
		assert.equal(unclosed.hadFrontmatter, false);
		assert.match(unclosed.problems?.[0] ?? "", /never closed/);
	});

	it("reports frontmatter it had to guess at", () => {
		const note = parseNote("---\ntitle: A\ntitle: B\nfallback: maybe\n---\n");
		assert.equal(note.frontmatter.title, "B");
		assert.equal(note.frontmatter.fallback, false);
		assert.equal(note.problems?.length, 2);
	});
});

describe("slugify", () => {
	it("produces ids that read as words to the model", () => {
		assert.equal(slugify("asyncpg Connection Pooling"), "asyncpg_connection_pooling");
		assert.equal(slugify("CI/CD & Deploys"), "ci_cd_deploys");
		assert.equal(slugify("  spaced  out  "), "spaced_out");
	});

	it("strips diacritics rather than dropping the letters", () => {
		assert.equal(slugify("Härtefälle"), "hartefalle");
	});

	it("caps the length without leaving a trailing underscore", () => {
		assert.ok(slugify("x".repeat(200)).length <= 60);
		assert.equal(slugify(`${"a".repeat(59)} b`), "a".repeat(59));
	});

	it("gives a name with no Latin letters a stable, non-empty id", () => {
		const id = slugify("日本語");
		assert.match(id, /^id_[0-9a-f]{8}$/);
		assert.ok(isHashedId(id));
		assert.equal(slugify("日本語"), id, "stable across calls");
		assert.notEqual(slugify("数据库"), id);
		assert.equal(slugify("   "), "", "only blank input stays empty");
	});
});
