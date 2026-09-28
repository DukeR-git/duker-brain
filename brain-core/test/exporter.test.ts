import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { exportVault } from "../src/exporter.js";
import { FIXTURE, scratch } from "./helpers.js";

describe("rules exporter", () => {
	it("exports Cursor MDC rules", async () => {
		const outDir = scratch();
		const result = await exportVault(FIXTURE, "cursor", outDir);

		assert.equal(result.format, "cursor");
		assert.ok(result.noteCount > 0);
		assert.equal(result.dryRun, false);

		const mdcPath = join(outDir, "asyncpg_pooling.mdc");
		assert.ok(existsSync(mdcPath));

		const content = readFileSync(mdcPath, "utf8");
		assert.match(content, /^---/);
		assert.match(content, /description: asyncpg Connection Pooling/);
		assert.match(content, /globs: \*\*\/\*\.py/);
		assert.match(content, /# asyncpg Connection Pooling/);
	});

	it("exports Windsurf rules", async () => {
		const outDir = scratch();
		const result = await exportVault(FIXTURE, "windsurf", outDir);

		assert.equal(result.format, "windsurf");
		const rulesPath = join(outDir, ".windsurfrules");
		assert.ok(existsSync(rulesPath));

		const content = readFileSync(rulesPath, "utf8");
		assert.match(content, /# Reference Rules & Architecture Guidelines/);
		assert.match(content, /## asyncpg Connection Pooling \(asyncpg_pooling\)/);
		assert.match(content, /> \*\*Criteria\*\*: /);
	});

	it("exports Aider configuration and doc files", async () => {
		const outDir = scratch();
		const result = await exportVault(FIXTURE, "aider", outDir);

		assert.equal(result.format, "aider");
		const confPath = join(outDir, ".aider.conf.yml");
		assert.ok(existsSync(confPath));

		const confContent = readFileSync(confPath, "utf8");
		assert.match(confContent, /read:/);
		assert.match(confContent, /\.brain-docs\/Backend\/asyncpg_pooling\.md/);

		const docPath = join(outDir, ".brain-docs", "Backend", "asyncpg_pooling.md");
		assert.ok(existsSync(docPath));
	});

	it("exports Markdown bundle with README index", async () => {
		const outDir = scratch();
		const result = await exportVault(FIXTURE, "bundle", outDir);

		assert.equal(result.format, "bundle");
		const indexPath = join(outDir, "README.md");
		assert.ok(existsSync(indexPath));

		const indexContent = readFileSync(indexPath, "utf8");
		assert.match(indexContent, /# Reference Guides Index/);
		assert.match(indexContent, /\[asyncpg Connection Pooling\]\(Backend\/asyncpg_pooling\.md\)/);

		const notePath = join(outDir, "Backend", "asyncpg_pooling.md");
		assert.ok(existsSync(notePath));
	});

	it("previews export with dryRun without writing files", async () => {
		const outDir = scratch();
		const result = await exportVault(FIXTURE, "cursor", outDir, { dryRun: true });

		assert.equal(result.dryRun, true);
		assert.ok(result.filesWritten.length > 0);
		assert.equal(existsSync(result.filesWritten[0]), false);
	});
});
