/**
 * The one test that talks to a real decisions service. Opt-in:
 *
 *   BRAIN_LIVE_URL=https://api.typesafe.ai TYPESAFE_API_KEY=sk-... npm test
 *   BRAIN_LIVE_URL=http://my-server:8081 npm test
 *
 * It checks the contract, not the model's taste: the service answers, the
 * answer is on the menu, and the fixture vault routes to *some* leaf or
 * fallback rather than erroring.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DECISIONS_PATH, DEFAULT_MODEL, defaultTimeout, resolveApiKey } from "../src/env.js";
import { DecisionsClient } from "../src/decisions-client.js";
import { Logger } from "../src/logger.js";
import { BrainTraverser } from "../src/traverser.js";
import { FIXTURE } from "./helpers.js";

const url = process.env.BRAIN_LIVE_URL?.trim();

describe("live decisions service", { skip: url ? false : "set BRAIN_LIVE_URL to run" }, () => {
	const logger = new Logger("silent");
	const client = new DecisionsClient({
		baseUrl: url ?? "",
		path: process.env.BRAIN_DECISIONS_PATH?.trim() || DEFAULT_DECISIONS_PATH,
		apiKey: resolveApiKey(process.env),
		model: process.env.BRAIN_DECISIONS_MODEL?.trim() || DEFAULT_MODEL,
		timeoutMs: Math.max(defaultTimeout(url ?? ""), 5000),
		retries: 1,
		logger,
	});

	it("is healthy", async () => {
		const health = await client.health();
		assert.equal(health.ok, true, health.error);
	});

	it("answers a choice with one of the offered labels", async () => {
		const outcome = await client.pickChoice(
			"How do I configure connection pooling for asyncpg in FastAPI?",
			"Select the reference manual most relevant to the developer prompt.",
			{
				fastapi_core: "FastAPI routing, request lifecycle, middleware, and dependency injection",
				asyncpg_pooling: "PostgreSQL database connections, asyncpg pools, and session management",
				docker_deploy: "Dockerfile setups, container networking, and compose files",
			},
		);
		assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
		if (outcome.ok) assert.ok(["fastapi_core", "asyncpg_pooling", "docker_deploy"].includes(outcome.choice));
	});

	it("routes through the fixture vault end to end", async () => {
		const traverser = new BrainTraverser(
			{
				vaultRoot: FIXTURE,
				maxHops: 4,
				minConfidence: 0.4,
				gateEnabled: true,
				gateThreshold: 0.5,
				fallbackDocument: "auto",
				maxDocumentChars: 12000,
				maxPromptChars: 1500,
				watchManifests: false,
			},
			client,
			logger,
		);
		const result = await traverser.route("How do I configure connection pooling for asyncpg in FastAPI?");
		assert.ok(["leaf", "fallback", "skipped", "low-confidence"].includes(result.status), `${result.status}: ${result.reason}`);
	});
});
