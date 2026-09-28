/**
 * The client's two backends: a Laya host (answers /healthz) and the hosted Jev
 * API (no /healthz, bearer key required). The same client must work against both.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { DecisionsClient } from "../src/decisions-client.js";
import { Logger } from "../src/logger.js";
import { startMockDecisions, type MockServer } from "./mock-decisions.js";

let mock: MockServer;

before(async () => {
	mock = await startMockDecisions();
});

after(async () => {
	await mock.close();
});

function client(options: { apiKey?: string; model?: string; baseUrl?: string } = {}): DecisionsClient {
	return new DecisionsClient({
		baseUrl: options.baseUrl ?? mock.url,
		path: "/v1/systemone",
		apiKey: options.apiKey,
		model: options.model,
		timeoutMs: 500,
		retries: 0,
		logger: new Logger("silent"),
	});
}

describe("health", () => {
	it("recognises a Laya host by its /healthz", async () => {
		mock.behaviour = {};
		const health = await client().health();
		assert.equal(health.ok, true);
		assert.equal(health.backend, "laya");
		assert.equal(health.model, "mock");
		assert.equal(health.device, "cpu");
	});

	it("falls back to /v1/models for Jev, and checks the key", async () => {
		mock.behaviour = { jevKey: "sk-test" };
		const health = await client({ apiKey: "sk-test", model: "jev-1.13.0" }).health();
		assert.equal(health.ok, true);
		assert.equal(health.backend, "jev");
		assert.equal(health.model, "jev-1.13.0");
		mock.behaviour = {};
	});

	it("names the missing key rather than calling the service down", async () => {
		mock.behaviour = { jevKey: "sk-test" };
		const health = await client().health();
		assert.equal(health.ok, false);
		assert.match(health.error ?? "", /TYPESAFE_API_KEY/);
		mock.behaviour = {};
	});

	it("says the key was rejected when one was sent", async () => {
		mock.behaviour = { jevKey: "sk-test" };
		const health = await client({ apiKey: "sk-wrong" }).health();
		assert.equal(health.ok, false);
		assert.match(health.error ?? "", /rejected/);
		mock.behaviour = {};
	});

	it("tells a Laya host that is still loading from one that failed", async () => {
		mock.behaviour = { health: "loading" };
		const loading = await client().health();
		assert.equal(loading.ok, false);
		assert.equal(loading.loading, true, "worth probing again soon");

		mock.behaviour = { health: "failed" };
		const failed = await client().health();
		assert.equal(failed.ok, false);
		assert.equal(failed.loading, undefined);
		assert.match(failed.error ?? "", /failed to load its checkpoint: no XPU device/);
		mock.behaviour = {};
	});

	it("checks the key of a Laya host started with LAYA_API_KEY", async () => {
		mock.behaviour = { layaKey: "laya-secret" };
		assert.match((await client().health()).error ?? "", /requires an API key/);
		assert.match((await client({ apiKey: "wrong" }).health()).error ?? "", /rejected the API key/);
		assert.equal((await client({ apiKey: "laya-secret" }).health()).ok, true);
		mock.behaviour = {};
	});

	it("reports an unreachable host without throwing", async () => {
		const health = await client({ baseUrl: "http://127.0.0.1:1" }).health();
		assert.equal(health.ok, false);
		assert.match(health.error ?? "", /unreachable/);
	});
});

describe("requests", () => {
	it("sends the configured model and the bearer key", async () => {
		mock.behaviour = { jevKey: "sk-test" };
		mock.requests.length = 0;
		const outcome = await client({ apiKey: "sk-test", model: "jev-preview" }).pickChoice("state", "pick", {
			a: "first",
			b: "second",
		});
		assert.equal(outcome.ok, true);
		assert.equal(mock.requests[0].model, "jev-preview");
		mock.behaviour = {};
	});

	it("defaults the model to jev-latest", async () => {
		mock.behaviour = {};
		mock.requests.length = 0;
		await client().pickChoice("state", "pick", { a: "first", b: "second" });
		assert.equal(mock.requests[0].model, "jev-latest");
	});
});
