import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { DecisionsClient } from "../src/decisions-client.js";
import { loadEvalSuite, renderEvalReport, runEvalSuite } from "../src/eval.js";
import { Logger } from "../src/logger.js";
import { BrainTraverser } from "../src/traverser.js";
import { FIXTURE, scratch } from "./helpers.js";
import { startMockDecisions, type MockServer } from "./mock-decisions.js";
import type { EvalSuite } from "../src/types.js";

let mock: MockServer;

before(async () => {
	mock = await startMockDecisions();
});

after(async () => {
	await mock.close();
});

function createTraverser(vaultRoot = FIXTURE): BrainTraverser {
	const logger = new Logger("silent");
	const client = new DecisionsClient({
		baseUrl: mock.url,
		path: "/v1/systemone",
		timeoutMs: 500,
		retries: 0,
		logger,
	});

	return new BrainTraverser(
		{
			vaultRoot,
			maxHops: 4,
			minConfidence: 0.4,
			gateEnabled: false,
			gateThreshold: 0.5,
			fallbackDocument: "auto",
			maxDocumentChars: 12000,
			maxPromptChars: 800,
			watchManifests: false,
		},
		client,
		logger,
	);
}

describe("eval suite", () => {
	it("loads and validates JSON eval suites", () => {
		const dir = scratch();
		const filePath = join(dir, "evals.json");
		writeFileSync(
			filePath,
			JSON.stringify({
				version: 1,
				evals: [
					{
						id: "test1",
						prompt: "How do I size an asyncpg pool?",
						expected: "asyncpg_pooling",
						tags: ["db"],
					},
				],
			}),
		);

		const suite = loadEvalSuite(filePath);
		assert.equal(suite.version, 1);
		assert.equal(suite.evals.length, 1);
		assert.equal(suite.evals[0].id, "test1");
	});

	it("refuses malformed eval suites", () => {
		const dir = scratch();
		const filePath = join(dir, "bad.json");
		writeFileSync(filePath, JSON.stringify({ version: 1, evals: [] })); // min(1) violated
		assert.throws(() => loadEvalSuite(filePath), /Invalid eval suite schema/);
	});

	it("runs eval suite and reports passes, failures, and metrics", async () => {
		const traverser = createTraverser();
		const suite: EvalSuite = {
			version: 1,
			defaults: { minConfidence: 0.5 },
			evals: [
				{
					id: "asyncpg",
					prompt: "How do I size an asyncpg pool?",
					expected: "asyncpg_pooling",
					tags: ["backend"],
				},
				{
					id: "should_fail",
					prompt: "How do I size an asyncpg pool?",
					expected: "react_state", // Intentional mismatch
					tags: ["frontend"],
				},
			],
		};

		const report = await runEvalSuite(suite, traverser);
		assert.equal(report.total, 2);
		assert.equal(report.passed, 1);
		assert.equal(report.failed, 1);
		assert.equal(report.accuracy, 0.5);
		assert.ok(report.p50LatencyMs >= 0);
		assert.ok(report.p95LatencyMs >= 0);

		const rendered = renderEvalReport(report);
		assert.match(rendered, /✔ \[PASS\] asyncpg/);
		assert.match(rendered, /✖ \[FAIL\] should_fail/);
		assert.match(rendered, /Summary: 1\/2 passed \(50.0% accuracy\)/);
	});

	it("filters test cases by tag", async () => {
		const traverser = createTraverser();
		const suite: EvalSuite = {
			version: 1,
			evals: [
				{
					id: "backend_only",
					prompt: "How do I size an asyncpg pool?",
					expected: "asyncpg_pooling",
					tags: ["backend"],
				},
				{
					id: "frontend_only",
					prompt: "How do I use React state?",
					expected: "react_state",
					tags: ["frontend"],
				},
			],
		};

		const report = await runEvalSuite(suite, traverser, { tags: ["backend"] });
		assert.equal(report.total, 1);
		assert.equal(report.results[0].id, "backend_only");
	});
});
