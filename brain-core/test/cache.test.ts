import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import {
	RouteCache,
	computeVaultFingerprint,
	hashPrompt,
	normalizePrompt,
} from "../src/cache.js";
import { FIXTURE, scratch } from "./helpers.js";
import type { TraversalResult } from "../src/types.js";

function dummyResult(leafId = "asyncpg_pooling"): TraversalResult {
	return {
		status: "leaf",
		trail: "Root -> Backend -> asyncpg_pooling.md",
		hops: [],
		minConfidence: 0.95,
		totalMs: 120,
		reason: "routed in 2 hop(s)",
		document: {
			id: leafId,
			title: "asyncpg Connection Pooling",
			path: `Backend/${leafId}.md`,
			content: "# asyncpg\n",
			truncated: false,
			originalLength: 10,
		},
	};
}

describe("route cache", () => {
	it("normalizes prompts consistently", () => {
		const p1 = "  How do I configure PgBouncer??  ";
		const p2 = "how do i configure pgbouncer";
		const p3 = "HOW DO I CONFIGURE   PGBOUNCER!";
		assert.equal(normalizePrompt(p1), normalizePrompt(p2));
		assert.equal(normalizePrompt(p2), normalizePrompt(p3));
		assert.equal(hashPrompt(normalizePrompt(p1)), hashPrompt(normalizePrompt(p3)));
	});

	it("computes vault fingerprint from manifests", () => {
		const fp = computeVaultFingerprint(FIXTURE);
		assert.ok(fp && fp.length === 16);
		// Same vault yields same fingerprint
		assert.equal(computeVaultFingerprint(FIXTURE), fp);
	});

	it("stores and retrieves cached routes", () => {
		const dir = scratch();
		const cache = new RouteCache(10);
		const prompt = "How do I configure asyncpg pooling?";
		const result = dummyResult();

		assert.equal(cache.get(prompt, dir), null);

		cache.set(prompt, dir, result);

		const cached = cache.get(prompt, dir);
		assert.ok(cached);
		assert.equal(cached.cached, true);
		assert.equal(cached.document?.id, "asyncpg_pooling");
		assert.ok(cached.totalMs < 10);

		const stats = cache.getStats();
		assert.equal(stats.hits, 1);
		assert.equal(stats.misses, 1);
		assert.equal(stats.size, 1);
	});

	it("evicts oldest entries when capacity is exceeded", () => {
		const dir = scratch();
		const cache = new RouteCache(2);

		cache.set("query 1", dir, dummyResult("note1"));
		cache.set("query 2", dir, dummyResult("note2"));
		assert.equal(cache.get("query 1", dir)?.document?.id, "note1");

		cache.set("query 3", dir, dummyResult("note3"));
		assert.equal(cache.get("query 2", dir), null); // Evicted
		assert.ok(cache.get("query 1", dir));
		assert.ok(cache.get("query 3", dir));
	});

	it("persists to and reloads from disk", () => {
		const dir = scratch();
		const cache1 = new RouteCache(10);
		cache1.set("persistent query", dir, dummyResult("note_disk"));

		const cache2 = new RouteCache(10);
		const cached = cache2.get("persistent query", dir);
		assert.ok(cached);
		assert.equal(cached.document?.id, "note_disk");
		assert.equal(cached.cached, true);
	});

	it("handles corrupted disk cache gracefully", () => {
		const dir = scratch();
		writeFileSync(join(dir, ".brain.cache.json"), "{ invalid json");

		const cache = new RouteCache(10);
		assert.equal(cache.get("some query", dir), null);
		// Writing a new value recovers cleanly
		cache.set("new query", dir, dummyResult("note_rec"));
		assert.ok(cache.get("new query", dir));
	});

	it("clears memory and disk cache", () => {
		const dir = scratch();
		const cache = new RouteCache(10);
		cache.set("to be cleared", dir, dummyResult());
		assert.ok(cache.get("to be cleared", dir));

		cache.clear(dir);
		assert.equal(cache.get("to be cleared", dir), null);
		assert.equal(cache.getStats().size, 0);
	});

	it("stores and retrieves composite routing results with multiple documents", () => {
		const dir = scratch();
		const cache = new RouteCache(10);
		const compositeRes: TraversalResult = {
			status: "composite",
			composite: true,
			trail: "Composite [Root -> Backend -> asyncpg.md, Root -> Infrastructure -> docker.md]",
			hops: [],
			minConfidence: 0.88,
			totalMs: 45,
			reason: "composite route resolved 2 complementary guides",
			document: {
				id: "asyncpg",
				title: "Asyncpg",
				path: "Backend/asyncpg.md",
				content: "# Asyncpg",
				truncated: false,
				originalLength: 9,
			},
			documents: [
				{
					id: "asyncpg",
					title: "Asyncpg",
					path: "Backend/asyncpg.md",
					content: "# Asyncpg",
					truncated: false,
					originalLength: 9,
				},
				{
					id: "docker",
					title: "Docker",
					path: "Infrastructure/docker.md",
					content: "# Docker",
					truncated: false,
					originalLength: 8,
				},
			],
		};

		cache.set("cross-cutting prompt", dir, compositeRes);

		const cached = cache.get("cross-cutting prompt", dir);
		assert.ok(cached);
		assert.equal(cached.status, "composite");
		assert.equal(cached.composite, true);
		assert.equal(cached.cached, true);
		assert.equal(cached.documents?.length, 2);
		assert.equal(cached.document?.id, "asyncpg");
		assert.equal(cached.documents?.[1]?.id, "docker");
	});
});
