/**
 * The block the agent's model reads. These live here, beside inject.ts, rather
 * than in brain-core: the core package must not depend on the Pi extension.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TraversalResult } from "../../brain-core/src/types.js";
import { formatInjection, formatReminder, formatStatus, formatTrace } from "../src/inject.js";

function result(overrides: Partial<TraversalResult> = {}): TraversalResult {
	return {
		status: "leaf",
		trail: "Root -> backend -> asyncpg_pooling.md",
		hops: [
			{ from: ".", chosen: "backend", type: "branch", confidence: 0.95, latencyMs: 12.3, optionCount: 4 },
			{ from: "Backend", chosen: "asyncpg_pooling", type: "leaf", confidence: 0.93, latencyMs: 12.3, optionCount: 4 },
		],
		document: {
			id: "asyncpg_pooling",
			title: "asyncpg Connection Pooling",
			path: "Backend/asyncpg_pooling.md",
			content: "# asyncpg Connection Pooling\n\nbody",
			truncated: false,
			originalLength: 34,
		},
		gate: { needed: true, probability: 0.95 },
		minConfidence: 0.93,
		totalMs: 40,
		reason: "routed in 2 hop(s)",
		...overrides,
	};
}

describe("formatInjection", () => {
	it("frames the block as reference material with its provenance", () => {
		const block = formatInjection(result())!;

		assert.match(block, /^\[Reference Guide: asyncpg Connection Pooling\]/);
		assert.match(block, /Source: Backend\/asyncpg_pooling\.md/);
		assert.match(block, /Root -> backend -> asyncpg_pooling\.md/);
		assert.match(block, /If it is not relevant to what was asked, ignore it\./);
		assert.match(block, /\[End Reference Guide\]$/);
	});

	it("labels a fallback injection as such", () => {
		const block = formatInjection(result({ status: "fallback", reason: "confidence 0.1 below threshold 0.4" }))!;
		assert.match(block, /fallback guide \(confidence 0\.1 below threshold 0\.4\)/);
	});

	it("says how much of a truncated document was kept", () => {
		const base = result();
		const block = formatInjection(result({ document: { ...base.document!, truncated: true, content: "x".repeat(200), originalLength: 985 } }))!;
		assert.match(block, /truncated: showing 200 of 985 characters\]$/);
	});

	it("injects nothing without a document", () => {
		assert.equal(formatInjection(result({ status: "skipped", document: undefined })), null);
	});
});

describe("formatReminder", () => {
	it("is one line that names the guide and where it came from", () => {
		const reminder = formatReminder(result(), 3)!;
		assert.equal(reminder.split("\n").length, 1);
		assert.match(reminder, /asyncpg Connection Pooling — already provided 3 turn\(s\) ago \(Source: Backend\/asyncpg_pooling\.md\)/);
	});
});

describe("formatTrace", () => {
	it("produces a one-line trace", () => {
		const trace = formatTrace(result());
		assert.match(trace, /^leaf \| gate=0\.95 \| backend\(0\.95, 12ms\) -> asyncpg_pooling\(0\.93, 12ms\)/);
		assert.match(trace, /Backend\/asyncpg_pooling\.md/);
	});

	it("shows Laya's act probability and the service's warnings", () => {
		const base = result();
		const trace = formatTrace(
			result({
				hops: [{ ...base.hops[0], actProbability: 0.81 }],
				warnings: ["question offers 16 options"],
			}),
		);
		assert.match(trace, /backend\(0\.95, act 0\.81, 12ms\)/);
		assert.match(trace, /service warnings: question offers 16 options/);
	});
});

describe("formatStatus", () => {
	it("summarises each outcome for the footer", () => {
		assert.match(formatStatus(result()), /^brain: asyncpg_pooling 0\.93 40ms$/);
		assert.equal(formatStatus(result({ status: "skipped" })), "brain: no guide needed");
		assert.equal(formatStatus(result({ status: "error" })), "brain: error");
	});

	it("formats composite status with multiple note IDs", () => {
		const compResult = result({
			status: "composite",
			composite: true,
			documents: [
				{ id: "asyncpg", title: "Asyncpg", path: "Backend/asyncpg.md", content: "a", truncated: false, originalLength: 1 },
				{ id: "docker", title: "Docker", path: "Infrastructure/docker.md", content: "b", truncated: false, originalLength: 1 },
			],
		});
		assert.match(formatStatus(compResult), /^brain: asyncpg\+docker 0\.93 40ms$/);
	});
});

describe("composite formatInjection and formatTrace", () => {
	it("formats composite guides with indexed banners and combined paths", () => {
		const compResult = result({
			status: "composite",
			composite: true,
			trail: "Composite [Root -> Backend -> asyncpg.md, Root -> Infrastructure -> docker.md]",
			documents: [
				{ id: "asyncpg", title: "Asyncpg Pooling", path: "Backend/asyncpg.md", content: "pooling rules", truncated: false, originalLength: 13 },
				{ id: "docker", title: "Docker Setup", path: "Infrastructure/docker.md", content: "docker rules", truncated: false, originalLength: 12 },
			],
		});

		const injection = formatInjection(compResult)!;
		assert.match(injection, /\[Reference Guide 1\/2: Asyncpg Pooling\]/);
		assert.match(injection, /\[Reference Guide 2\/2: Docker Setup\]/);
		assert.match(injection, /\[End Reference Guide 1\/2\]/);
		assert.match(injection, /\[End Reference Guide 2\/2\]/);

		const trace = formatTrace(compResult);
		assert.match(trace, /composite/);
		assert.match(trace, /Backend\/asyncpg\.md \+ Infrastructure\/docker\.md/);
	});
});
