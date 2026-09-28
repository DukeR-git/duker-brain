import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { DecisionsClient } from "../src/decisions-client.js";
import { Logger } from "../src/logger.js";
import {
	allocateUnifiedContextBudget,
	BrainTraverser,
	closeOpenFence,
	isTrivialFollowUp,
	sliceCodePoints,
	type TraverserOptions,
} from "../src/traverser.js";
import { compileVault } from "../src/vault.js";
import { FIXTURE, note, scratch } from "./helpers.js";
import { startMockDecisions, type MockServer } from "./mock-decisions.js";

let mock: MockServer;

before(async () => {
	mock = await startMockDecisions();
});

after(async () => {
	await mock.close();
});

interface Overrides extends Partial<TraverserOptions> {
	decisionsUrl?: string;
	timeoutMs?: number;
	retries?: number;
}

function route(prompt: string, overrides: Overrides = {}) {
	mock.requests.length = 0;
	mock.paths.length = 0;
	mock.hits = 0;

	const logger = new Logger("silent");
	const client = new DecisionsClient({
		baseUrl: overrides.decisionsUrl ?? mock.url,
		path: "/v1/systemone",
		timeoutMs: overrides.timeoutMs ?? 500,
		retries: overrides.retries ?? 1,
		logger,
	});

	const options: TraverserOptions = {
		vaultRoot: FIXTURE,
		maxHops: 4,
		minConfidence: 0.4,
		gateEnabled: true,
		gateThreshold: 0.5,
		fallbackDocument: "general_instructions.md",
		maxDocumentChars: 12000,
		maxPromptChars: 1500,
		watchManifests: true,
		...overrides,
	};

	return new BrainTraverser(options, client, logger).route(prompt);
}

describe("happy path", () => {
	it("routes a backend prompt to the right leaf in two hops", async () => {
		mock.behaviour = {}; // lexical matching
		const result = await route("How do I configure connection pooling for asyncpg in FastAPI?");

		assert.equal(result.status, "leaf");
		assert.equal(result.document?.id, "asyncpg_pooling");
		assert.equal(result.document?.path, "Backend/asyncpg_pooling.md");
		assert.equal(result.trail, "Root -> backend -> asyncpg_pooling.md");
		assert.equal(result.hops.length, 2);
		assert.equal(result.hops[0].optionCount, 4);
		assert.ok(result.document!.content.includes("statement_cache_size=0"));
		assert.deepEqual(mock.paths, ["/v1/systemone", "/v1/systemone"], "posts to the configured path");
	});

	it("prefers the manifest title over the frontmatter title", async () => {
		mock.behaviour = { chooseBy: (options) => (options.includes("frontend") ? "frontend" : "css_layout") };
		const result = await route("my flexbox sidebar collapses");
		assert.equal(result.document?.title, "CSS Layout");
	});

	it("reports per-hop confidence and the weakest link", async () => {
		mock.behaviour = {
			chooseBy: (options) => (options.includes("backend") ? "backend" : "sql_indexing"),
			confidence: (hop) => (hop === 0 ? 0.91 : 0.66),
		};
		const result = await route("why is my query slow");

		assert.equal(result.hops[0].confidence, 0.91);
		assert.equal(result.hops[1].confidence, 0.66);
		assert.equal(result.minConfidence, 0.66);
	});

	it("reads confidence from the probabilities when the backend omits it", async () => {
		// A backend that reports only the distribution must not look like zero
		// confidence and send every hop to the fallback.
		mock.behaviour = { omitConfidence: true, confidence: 0.8 };
		const result = await route("How do I configure connection pooling for asyncpg in FastAPI?");
		assert.equal(result.status, "leaf");
		assert.equal(result.hops[0].confidence, 0.8);
	});

	it("passes service warnings through to the result", async () => {
		mock.behaviour = { warnings: ["question 'route_selection' offers 16 options"] };
		const result = await route("How do I configure connection pooling for asyncpg in FastAPI?");
		assert.deepEqual(result.warnings, ["question 'route_selection' offers 16 options"]);
	});
});

describe("the gate", () => {
	it("rides in the first request rather than costing a round trip", async () => {
		mock.behaviour = {};
		await route("How do I pool asyncpg connections in FastAPI?");

		assert.equal(mock.requests.length, 2, "two hops = two requests, not three");
		assert.deepEqual(Object.keys(mock.requests[0].questions).sort(), [
			"needs_reference",
			"route_selection",
		]);
		assert.deepEqual(Object.keys(mock.requests[1].questions), ["route_selection"]);
	});

	it("skips traversal when no reference is needed", async () => {
		mock.behaviour = { gate: 0.1 };
		const result = await route("hey, morning");

		assert.equal(result.status, "skipped");
		assert.equal(result.document, undefined);
		assert.equal(result.gate?.needed, false);
		assert.equal(mock.requests.length, 1, "stops after the gate says no");
	});

	it("skips a bare acknowledgement without asking the service at all", async () => {
		mock.behaviour = {};
		for (const prompt of ["yes", "thanks!", "ok, continue", "LGTM"]) {
			const result = await route(prompt);
			assert.equal(result.status, "skipped", prompt);
			assert.equal(mock.hits, 0, `${prompt}: no request`);
		}
		assert.equal(isTrivialFollowUp("yes, but how do I size the asyncpg pool?"), false);
	});

	it("can be turned off entirely", async () => {
		mock.behaviour = { gate: 0.1 };
		const result = await route("hey, morning", { gateEnabled: false });

		assert.notEqual(result.status, "skipped");
		assert.equal(Object.keys(mock.requests[0].questions).length, 1);
	});

	it("respects a custom threshold", async () => {
		mock.behaviour = { gate: 0.6 };
		assert.equal((await route("borderline", { gateThreshold: 0.8 })).status, "skipped");
		assert.notEqual((await route("borderline", { gateThreshold: 0.4 })).status, "skipped");
	});
});

describe("guardrails", () => {
	it("falls back when a hop is below the confidence threshold", async () => {
		mock.behaviour = { confidence: 0.2 };
		const result = await route("something vague");

		assert.equal(result.status, "fallback");
		assert.equal(result.document?.id, "fallback");
		assert.equal(result.document?.path, "general_instructions.md");
		assert.match(result.reason, /below threshold/);
		assert.equal(mock.requests.length, 1, "stops traversing at the weak hop");
	});

	it("treats a low act probability as an unsure hop when asked to", async () => {
		mock.behaviour = { actProbability: 0.2 };
		const result = await route("How do I configure connection pooling for asyncpg in FastAPI?", { minActProbability: 0.5 });
		assert.equal(result.status, "fallback");
		assert.match(result.reason, /act probability 0\.200 below threshold 0\.5/);
		assert.equal(result.hops[0].actProbability, 0.2);

		const ignored = await route("How do I configure connection pooling for asyncpg in FastAPI?");
		assert.equal(ignored.status, "leaf", "off by default");
	});

	it("falls back when the model answers with a label that is not on the menu", async () => {
		mock.behaviour = { offMenu: true };
		const result = await route("anything");

		assert.equal(result.status, "fallback");
		assert.match(result.reason, /not in .*_index\.json/);
	});

	it("stops at the max-hop ceiling", async () => {
		mock.behaviour = { chooseBy: () => "backend" };
		const result = await route("backend things", { maxHops: 1 });

		assert.equal(result.status, "fallback");
		assert.match(result.reason, /1-hop ceiling/);
	});

	it("returns no-index when the vault root has no manifest", async () => {
		mock.behaviour = {};
		const result = await route("anything", { vaultRoot: scratch(), fallbackDocument: "" });

		assert.equal(result.status, "no-index");
		assert.equal(result.document, undefined);
	});

	it("does not inject a guide when the decisions API is down", async () => {
		mock.behaviour = { failWith: 500 };
		const result = await route("anything", { retries: 0 });

		assert.equal(result.status, "error");
		assert.equal(result.document, undefined, "no evidence any guide is right, so inject none");
		assert.match(result.reason, /HTTP 500/);
	});

	it("gives up on a slow service rather than stalling the turn", async () => {
		mock.behaviour = { delayMs: 200 };
		const result = await route("anything", { timeoutMs: 40, retries: 0 });

		assert.equal(result.status, "error");
		assert.match(result.reason, /timed out after 40ms/);
	});

	it("keeps the whole route inside its budget, retries included", async () => {
		mock.behaviour = { delayMs: 150 };
		const started = performance.now();
		const result = await route("anything", { timeoutMs: 1000, retries: 3, routeBudgetMs: 100 });

		assert.equal(result.status, "error");
		assert.ok(performance.now() - started < 400, "does not wait for four slow attempts");
		mock.behaviour = {};
	});

	it("retries a 5xx once by default, and not more", async () => {
		// 503 is what the Laya host returns while its checkpoint is still loading,
		// so one retry is worth it - but the turn must not wait for three.
		mock.behaviour = { failWith: 503 };
		const result = await route("anything");

		assert.equal(result.status, "error");
		assert.equal(mock.hits, 2, "one attempt plus one retry");

		await route("anything", { retries: 0 });
		assert.equal(mock.hits, 1, "retries: 0 means a single attempt");

		mock.behaviour = {};
	});

	it("does not retry when Retry-After would outlast the budget", async () => {
		mock.behaviour = { failWith: 429, retryAfter: "30" };
		const result = await route("anything", { routeBudgetMs: 500 });
		assert.equal(mock.hits, 1);
		assert.match(result.reason, /no time left to retry/);
		mock.behaviour = {};
	});

	it("does not retry a body that is not JSON", async () => {
		mock.behaviour = { notJson: true };
		const result = await route("anything", { retries: 2 });
		assert.equal(result.status, "error");
		assert.equal(mock.hits, 1);
		assert.match(result.reason, /not JSON/);
		mock.behaviour = {};
	});

	it("handles a response with no choice answer", async () => {
		mock.behaviour = { omitChoice: true };
		const result = await route("anything", { retries: 0 });

		assert.equal(result.status, "fallback");
		assert.match(result.reason, /no choice answer/);
	});

	it("reports the failure status when there is no fallback document", async () => {
		mock.behaviour = { confidence: 0.1 };
		const result = await route("vague", { fallbackDocument: "" });

		assert.equal(result.status, "low-confidence");
		assert.equal(result.document, undefined);
	});

	it("refuses a fallback document outside the vault", async () => {
		mock.behaviour = { confidence: 0.1 };
		const result = await route("vague", { fallbackDocument: "../../package.json" });
		assert.equal(result.status, "low-confidence");
		assert.match(result.reason, /not found/);
	});
});

describe("fallback: auto", () => {
	it("uses the note marked fallback: true at the root", async () => {
		mock.behaviour = { confidence: 0.1 };
		const result = await route("vague", { fallbackDocument: "auto" });

		assert.equal(result.status, "fallback");
		assert.equal(result.document?.path, "general_instructions.md");
		assert.equal(result.document?.id, "general_instructions");
	});

	it("follows the fallback flag, not a hard-coded file name", async () => {
		const root = scratch({
			"catch_all.md": note({ criteria: "the vault's own catch all note for anything", fallback: "true" }, "# Catch all\n"),
			"other.md": note({ criteria: "a normal note about a specific topic here" }),
		});
		compileVault(root);
		mock.behaviour = { confidence: 0.1 };
		const result = await route("vague", { vaultRoot: root, fallbackDocument: "auto" });
		assert.equal(result.document?.path, "catch_all.md");
	});

	it("prefers the catch-all of the folder routing got to over the root's", async () => {
		const root = scratch({
			"general.md": note({ criteria: "the root catch all note for any request at all", fallback: "true" }, "# Root\n"),
			"Backend/_about.md": note({ criteria: "server side code, databases, queues and background jobs" }),
			"Backend/pooling.md": note({ criteria: "database connection pools and their sizing rules" }),
			"Backend/queues.md": note({ criteria: "message queues, brokers, retries and dead letters" }),
			"Backend/backend_general.md": note({ criteria: "general backend conventions when nothing else fits", fallback: "true" }, "# Backend\n"),
		});
		compileVault(root);
		mock.behaviour = {
			chooseBy: (options) => (options.includes("backend") ? "backend" : "pooling"),
			confidence: (hop) => (hop === 0 ? 0.9 : 0.1),
		};
		const result = await route("something about the backend", { vaultRoot: root, fallbackDocument: "auto" });

		assert.equal(result.status, "fallback");
		assert.equal(result.document?.path, "Backend/backend_general.md");
		assert.match(result.reason, /used the 'Backend' catch-all/);
	});

	it("says so when no note is marked", async () => {
		const root = scratch({
			"a.md": note({ criteria: "a note about one particular topic in depth" }),
			"b.md": note({ criteria: "a note about another particular topic in depth" }),
		});
		compileVault(root);
		mock.behaviour = { confidence: 0.1 };
		const result = await route("vague", { vaultRoot: root, fallbackDocument: "auto" });
		assert.equal(result.status, "low-confidence");
		assert.match(result.reason, /no note is marked/);
	});
});

describe("document handling", () => {
	it("strips frontmatter from the injected content", async () => {
		mock.behaviour = {};
		const result = await route("How do I pool asyncpg connections?");

		assert.ok(!result.document!.content.startsWith("---"));
		assert.ok(result.document!.content.startsWith("# asyncpg Connection Pooling"));
	});

	it("truncates a document that would eat the context window, and says from what", async () => {
		mock.behaviour = {};
		const result = await route("How do I pool asyncpg connections?", { maxDocumentChars: 200 });

		assert.equal(result.document?.truncated, true);
		assert.ok(result.document!.content.length <= 200);
		assert.ok(result.document!.originalLength > 200);
	});

	it("truncates the prompt before sending it as decision state", async () => {
		mock.behaviour = {};
		await route("x".repeat(5000), { maxPromptChars: 100 });

		assert.equal((mock.requests[0].state as string).length, 100);
	});

	it("never splits a surrogate pair or leaves a code fence open", () => {
		assert.equal(sliceCodePoints("ab😀cd", 3), "ab", "drops the half of the emoji");
		assert.equal(sliceCodePoints("ab😀cd", 4), "ab😀");
		assert.equal(closeOpenFence("text\n```ts\nconst a = 1;"), "text\n```ts\nconst a = 1;\n```");
		assert.equal(closeOpenFence("```\nx\n```\nafter"), "```\nx\n```\nafter", "a closed fence is left alone");
	});
});

describe("allocateUnifiedContextBudget", () => {
	it("returns unchanged documents when total length is within budget", () => {
		const docs = [
			{ id: "a", title: "A", path: "a.md", content: "hello world", truncated: false, originalLength: 11 },
			{ id: "b", title: "B", path: "b.md", content: "foo bar baz", truncated: false, originalLength: 11 },
		];
		const res = allocateUnifiedContextBudget(docs, 100);
		assert.equal(res.length, 2);
		assert.equal(res[0].truncated, false);
		assert.equal(res[1].truncated, false);
		assert.equal(res[0].content, "hello world");
	});

	it("redistributes budget so short documents remain intact", () => {
		const docs = [
			{ id: "short", title: "Short", path: "short.md", content: "short note", truncated: false, originalLength: 10 },
			{ id: "long", title: "Long", path: "long.md", content: "x".repeat(100), truncated: false, originalLength: 100 },
		];
		// Budget is 50. Fair share would be 25 each. Short takes 10, leaving 40 for long.
		const res = allocateUnifiedContextBudget(docs, 50);
		assert.equal(res.length, 2);
		assert.equal(res[0].truncated, false);
		assert.equal(res[0].content, "short note");
		assert.equal(res[1].truncated, true);
		assert.ok(res[1].content.length <= 40);
	});
});

describe("composite routing", () => {
	it("routes cross-cutting query in parallel down two branches to inject complementary guides", async () => {
		mock.behaviour = {
			probabilities: (options) => {
				if (options.includes("backend") && options.includes("infrastructure")) {
					return { backend: 0.52, infrastructure: 0.43, frontend: 0.05, general_instructions: 0 };
				}
				if (options.includes("asyncpg_pooling")) {
					return { asyncpg_pooling: 0.92, celery_tasks: 0.08 };
				}
				if (options.includes("docker_deploy")) {
					return { docker_deploy: 0.89, github_actions: 0.11 };
				}
				const uniform = 1 / options.length;
				return Object.fromEntries(options.map((o) => [o, uniform]));
			},
			chooseBy: (options) => {
				if (options.includes("backend")) return "backend";
				if (options.includes("asyncpg_pooling")) return "asyncpg_pooling";
				if (options.includes("docker_deploy")) return "docker_deploy";
				return options[0];
			},
		};

		const result = await route("Deploy our FastAPI asyncpg backend with Docker", {
			compositeEnabled: true,
			useCache: false,
		});

		assert.equal(result.status, "composite");
		assert.equal(result.composite, true);
		assert.ok(result.documents);
		assert.equal(result.documents.length, 2);
		assert.equal(result.document?.id, result.documents[0].id);
		const ids = result.documents.map((d) => d.id).sort();
		assert.deepEqual(ids, ["asyncpg_pooling", "docker_deploy"]);
		assert.match(result.trail, /^Composite \[/);
		mock.behaviour = {};
	});

	it("falls back to single-route behavior when composite routing is disabled", async () => {
		mock.behaviour = {
			probabilities: (options) => {
				if (options.includes("backend") && options.includes("infrastructure")) {
					return { backend: 0.52, infrastructure: 0.43, frontend: 0.05, general_instructions: 0 };
				}
				if (options.includes("asyncpg_pooling")) {
					return { asyncpg_pooling: 0.92, celery_tasks: 0.08 };
				}
				const uniform = 1 / options.length;
				return Object.fromEntries(options.map((o) => [o, uniform]));
			},
			chooseBy: (options) => (options.includes("backend") ? "backend" : options[0]),
		};

		const result = await route("Deploy our FastAPI asyncpg backend with Docker", {
			compositeEnabled: false,
			useCache: false,
		});

		assert.equal(result.status, "leaf");
		assert.equal(result.composite, undefined);
		assert.equal(result.document?.id, "asyncpg_pooling");
		mock.behaviour = {};
	});
});
