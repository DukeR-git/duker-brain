/**
 * The `brain-traverse` CLI, run as a real process through its `.mjs` launcher.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FIXTURE, fixtureCopy, isolatedEnv } from "../../brain-core/test/helpers.js";
import { startMockDecisions, type MockServer } from "../../brain-core/test/mock-decisions.js";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "bin", "brain-traverse.mjs");

let mock: MockServer;
before(async () => {
	mock = await startMockDecisions();
});
after(async () => {
	await mock.close();
});

function run(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env, ...isolatedEnv({ BRAIN_DECISIONS_URL: mock.url, BRAIN_VAULT_ROOT: FIXTURE, BRAIN_USE_CACHE: "false", ...extra }) };
	delete env.BRAIN_CONFIG;
	return new Promise((done) => {
		execFile(process.execPath, [CLI, ...args], { env, timeout: 60_000 }, (error, stdout, stderr) => {
			done({ code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});
}

describe("brain-traverse", () => {
	it("routes a prompt and prints the trail and the document", async () => {
		mock.behaviour = {};
		const { code, stdout } = await run(["route", "How do I configure connection pooling for asyncpg in FastAPI?"]);
		assert.equal(code, 0);
		assert.match(stdout, /^leaf \| gate=/);
		assert.match(stdout, /\[Reference Guide: asyncpg Connection Pooling\]/);
	});

	it("rejects bad numbers instead of silently misbehaving", async () => {
		const minConf = await run(["route", "--min-conf=abc", "x"]);
		assert.equal(minConf.code, 2);
		assert.match(minConf.stderr, /--min-conf needs a number/);

		const bench = await run(["bench", "-n", "0"]);
		assert.equal(bench.code, 2);
		assert.match(bench.stderr, /-n must be at least 1/);
	});

	it("benches against a local host with the plan's budget", async () => {
		mock.behaviour = {};
		const { code, stdout } = await run(["bench", "-n", "3"]);
		assert.equal(code, 0);
		assert.match(stdout, /iterations 3/);
		assert.match(stdout, /Budget: p50 < 100ms\. {2}PASS/);
	});

	it("prints the configuration with where each value came from", async () => {
		const { code, stdout } = await run(["config"], { BRAIN_MAX_HOPS: "3" });
		assert.equal(code, 0);
		assert.match(stdout, /max hops {5}3 {3}\[env BRAIN_MAX_HOPS\]/);
	});

	it("lints a healthy vault, and catches a stale manifest", async () => {
		const clean = await run(["lint"]);
		assert.equal(clean.code, 0, clean.stdout);
		assert.match(clean.stdout, /0 error\(s\), 0 warning\(s\)/);

		const vault = fixtureCopy();
		writeFileSync(
			join(vault, "Backend", "redis.md"),
			"---\ncriteria: Redis keys, TTL policies, eviction and pipelines\n---\n\nbody\n",
		);
		const stale = await run(["lint", "--vault", vault]);
		assert.match(stale.stdout, /Backend\/_index\.json is stale/);
	});

	it("runs eval suite against fixture vault", async () => {
		mock.behaviour = {};
		const { code, stdout } = await run(["eval"]);
		assert.equal(code, 0, stdout);
		assert.match(stdout, /✔ \[PASS\] asyncpg-pool/);
		assert.match(stdout, /Summary: \d+\/\d+ passed/);
	});

	it("supports --no-cache flag on route", async () => {
		mock.behaviour = {};
		const { code, stdout } = await run(["route", "--no-cache", "How do I configure connection pooling for asyncpg in FastAPI?"]);
		assert.equal(code, 0);
		assert.match(stdout, /^leaf \| gate=/);
	});
});

