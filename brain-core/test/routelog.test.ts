import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { appendRouteLog, readRouteLog, renderRouteStats, resolveRouteLogPath, toRouteRecord } from "../src/routelog.js";
import type { TraversalResult } from "../src/types.js";
import { scanVault } from "../src/vault.js";
import { FIXTURE, tempDir } from "./helpers.js";

function result(overrides: Partial<TraversalResult> = {}): TraversalResult {
	return {
		status: "leaf",
		trail: "Root -> backend -> asyncpg_pooling.md",
		hops: [
			{ from: ".", chosen: "backend", type: "branch", confidence: 0.9, latencyMs: 10, optionCount: 4, probabilities: { backend: 0.9, frontend: 0.05 } },
			{
				from: "Backend",
				chosen: "asyncpg_pooling",
				type: "leaf",
				confidence: 0.48,
				latencyMs: 10,
				optionCount: 4,
				probabilities: { asyncpg_pooling: 0.48, sql_indexing: 0.44 },
			},
		],
		document: { id: "asyncpg_pooling", title: "t", path: "Backend/asyncpg_pooling.md", content: "x", truncated: false, originalLength: 1 },
		minConfidence: 0.48,
		totalMs: 30,
		reason: "routed in 2 hop(s)",
		...overrides,
	};
}

describe("the routing log", () => {
	it("stores a hash of the prompt, never the prompt", () => {
		const path = join(tempDir(), "routes.jsonl");
		appendRouteLog(path, toRouteRecord("my secret prompt about pools", result()));
		const text = readFileSync(path, "utf8");
		assert.ok(!text.includes("secret"));
		const [record] = readRouteLog(path);
		assert.match(record.prompt, /^[0-9a-f]{12}$/);
		assert.equal(record.hops[1].runnerUp, "sql_indexing");
		assert.equal(record.hops[1].gap, 0.04);
	});

	it("resolves auto to the state directory and empty to off", () => {
		const state = tempDir();
		assert.equal(resolveRouteLogPath("auto", { XDG_STATE_HOME: state }), join(state, "brain-traverse", "routes.jsonl"));
		assert.equal(resolveRouteLogPath("", {}), undefined);
	});

	it("reports what is injected, what never is, and near ties", () => {
		const path = join(tempDir(), "routes.jsonl");
		for (let index = 0; index < 3; index++) appendRouteLog(path, toRouteRecord(`p${index}`, result()));
		appendRouteLog(path, toRouteRecord("vague", result({ status: "low-confidence", document: undefined })));

		const report = renderRouteStats(readRouteLog(path), scanVault(FIXTURE).root);
		assert.match(report, /4 routed prompt\(s\)/);
		assert.match(report, /3 {2}Backend\/asyncpg_pooling\.md/);
		assert.match(report, /Never injected \(8\)/);
		assert.match(report, /Backend: asyncpg_pooling vs sql_indexing/);
		assert.match(report, /gave up:\n\s+1 {2}Backend/);
	});

	it("says so when the log is empty", () => {
		assert.match(renderRouteStats([]), /empty/);
	});
});
