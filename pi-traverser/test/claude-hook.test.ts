/**
 * The Claude Code hooks, driven the way Claude Code drives them: one call per
 * prompt, with nothing carried over in memory, only the state files in a
 * per-test data directory. The decisions API is the shared mock server.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
	MAX_CONTEXT_CHARS,
	cleanPrompt,
	fitToLimit,
	renderStatus,
	runPromptHook,
	runSessionStartHook,
	type HookInput,
} from "../src/claude-hook.js";
import { planInjection, type InjectedGuide } from "../src/session.js";
import type { TraversalResult } from "../../brain-core/src/types.js";
import { FIXTURE, fixtureCopy, isolatedEnv, tempDir } from "../../brain-core/test/helpers.js";
import { startMockDecisions, type MockServer } from "../../brain-core/test/mock-decisions.js";

let mock: MockServer;

before(async () => {
	mock = await startMockDecisions();
});

after(async () => {
	await mock.close();
});

const POOLING = "How do I configure connection pooling for asyncpg in FastAPI?";

function setup(extra: Record<string, string> = {}) {
	const env = isolatedEnv({
		BRAIN_VAULT_ROOT: FIXTURE,
		BRAIN_DECISIONS_URL: mock.url,
		BRAIN_LOG_LEVEL: "silent",
		BRAIN_FALLBACK_DOC: "general_instructions.md",
		BRAIN_USE_CACHE: "false",
		...extra,
	});
	const dataDir = tempDir("brain-plugin-data-");
	const clock = { now: 1_000_000 };
	const options = { env, dataDir, now: () => clock.now };
	const prompt = (text: string, session = "session-1") =>
		runPromptHook({ session_id: session, cwd: process.cwd(), hook_event_name: "UserPromptSubmit", prompt: text }, options);
	const sessionStart = (source: string, session = "session-1") =>
		runSessionStartHook({ session_id: session, cwd: process.cwd(), hook_event_name: "SessionStart", source } as HookInput, options);
	return { env, dataDir, clock, options, prompt, sessionStart };
}

describe("the UserPromptSubmit hook", () => {
	it("adds the routed guide as additionalContext and tells the user in one line", async () => {
		mock.behaviour = {};
		const hook = setup();

		const output = await hook.prompt(POOLING);

		assert.equal(output?.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
		const context = output!.hookSpecificOutput!.additionalContext;
		assert.match(context, /\[Reference Guide: asyncpg Connection Pooling\]/);
		assert.match(context, /Backend\/asyncpg_pooling\.md/);
		assert.match(output!.systemMessage ?? "", /^brain: asyncpg_pooling/);
	});

	it("sends a one-line reminder, not a second copy, while the guide is still in the conversation", async () => {
		mock.behaviour = {};
		const hook = setup();

		await hook.prompt(POOLING);
		const second = await hook.prompt(POOLING);

		const context = second!.hookSpecificOutput!.additionalContext;
		assert.match(context, /already provided 1 turn\(s\) ago/);
		assert.ok(context.length < 300, "a reminder, not the note");
		assert.equal(second!.systemMessage, undefined);
	});

	it("keeps each conversation's memory separate", async () => {
		mock.behaviour = {};
		const hook = setup();

		await hook.prompt(POOLING, "session-a");
		const other = await hook.prompt(POOLING, "session-b");

		assert.match(other!.hookSpecificOutput!.additionalContext, /\[Reference Guide: asyncpg Connection Pooling\]/);
	});

	it("injects the full guide again after the conversation is compacted", async () => {
		mock.behaviour = {};
		const hook = setup();

		await hook.prompt(POOLING);
		assert.equal(hook.sessionStart("compact"), undefined);
		const afterCompact = await hook.prompt(POOLING);

		assert.match(afterCompact!.hookSpecificOutput!.additionalContext, /\[Reference Guide: asyncpg Connection Pooling\]/);
	});

	it("does not ask the decisions API about a trivial follow-up", async () => {
		mock.behaviour = {};
		const hook = setup();
		const before = mock.hits;

		assert.equal(await hook.prompt("ok"), undefined);
		assert.equal(await hook.prompt("   "), undefined);
		assert.equal(mock.hits, before);
	});

	it("does nothing without a vault", async () => {
		const hook = setup({ BRAIN_VAULT_ROOT: "" });
		const before = mock.hits;

		assert.equal(await hook.prompt(POOLING), undefined);
		assert.equal(mock.hits, before);
	});

	it("reads the vault from the plugin's settings", async () => {
		mock.behaviour = {};
		const hook = setup({ BRAIN_VAULT_ROOT: "", CLAUDE_PLUGIN_OPTION_VAULT_ROOT: FIXTURE });

		const output = await hook.prompt(POOLING);

		assert.match(output!.hookSpecificOutput!.additionalContext, /asyncpg Connection Pooling/);
	});

	it("pauses routing after the service fails twice, and tries again after the cool-down", async () => {
		mock.behaviour = { failWith: 500 };
		const hook = setup({ BRAIN_RETRIES: "0" });

		assert.equal(await hook.prompt(POOLING), undefined);
		assert.equal(await hook.prompt(POOLING), undefined);
		const breaker = JSON.parse(readFileSync(join(hook.dataDir, "breaker.json"), "utf8"));
		assert.ok(breaker.downUntil > hook.clock.now, "the service is marked down");

		const whileDown = mock.hits;
		assert.equal(await hook.prompt(POOLING), undefined);
		assert.equal(mock.hits, whileDown, "no request while paused");

		mock.behaviour = {};
		hook.clock.now = breaker.downUntil + 1;
		const recovered = await hook.prompt(POOLING);
		assert.match(recovered!.hookSpecificOutput!.additionalContext, /asyncpg Connection Pooling/);
		assert.equal(JSON.parse(readFileSync(join(hook.dataDir, "breaker.json"), "utf8")).failures, 0);
	});

	it("keeps a huge note under Claude Code's 10,000-character hook output limit", async () => {
		mock.behaviour = {};
		const vault = fixtureCopy();
		const notePath = join(vault, "Backend", "asyncpg_pooling.md");
		writeFileSync(notePath, readFileSync(notePath, "utf8") + "\n" + "pool sizing detail. ".repeat(3_000), "utf8");
		const hook = setup({ BRAIN_VAULT_ROOT: vault });

		const output = await hook.prompt(POOLING);

		const context = output!.hookSpecificOutput!.additionalContext;
		assert.ok(context.length <= MAX_CONTEXT_CHARS, `${context.length} characters`);
		assert.match(context, /truncated/);
	});

	it("records what it saw for /duker-brain:status", async () => {
		mock.behaviour = {};
		const hook = setup();

		await hook.prompt(POOLING);
		const status = renderStatus(hook.options);

		assert.match(status, /Last prompt: leaf/);
		assert.match(status, /asyncpg_pooling\.md/);
		assert.ok(status.includes(FIXTURE), "shows the vault");
		assert.doesNotMatch(status, /sk-/);
	});
});

describe("the SessionStart hook", () => {
	it("tells the user once a day how to set up a vault", () => {
		const hook = setup({ BRAIN_VAULT_ROOT: "" });

		const first = hook.sessionStart("startup");
		assert.match(first?.systemMessage ?? "", /\/duker-brain:init/);
		assert.equal(hook.sessionStart("startup"), undefined, "not again the same day");

		hook.clock.now += 25 * 60 * 60_000;
		assert.match(hook.sessionStart("startup")?.systemMessage ?? "", /\/duker-brain:init/);
	});

	it("warns when Jev is the backend and no key is set", () => {
		const hook = setup({ BRAIN_DECISIONS_URL: "https://api.typesafe.ai" });
		assert.match(hook.sessionStart("startup")?.systemMessage ?? "", /API key/);
	});

	it("says nothing when routing is set up", () => {
		const hook = setup();
		assert.equal(hook.sessionStart("startup"), undefined);
		assert.equal(hook.sessionStart("resume"), undefined);
	});

	it("never fails on a session it has not seen", () => {
		const hook = setup();
		assert.equal(hook.sessionStart("clear", "never-prompted"), undefined);
		assert.equal(existsSync(join(hook.dataDir, "sessions", "never-prompted.json")), false);
	});
});

describe("hook helpers", () => {
	it("strips the markers Claude Code wraps around pasted text", () => {
		const prompt = 'Fix this:\n<pasted_content id="p1">\nTraceback (most recent call last)\n</pasted_content id="p1">';
		assert.equal(cleanPrompt(prompt), "Fix this:\nTraceback (most recent call last)");
	});

	it("truncates, as a last resort, anything over the limit", () => {
		assert.equal(fitToLimit("short"), "short");
		const cut = fitToLimit("x".repeat(20_000));
		assert.ok(cut.length <= MAX_CONTEXT_CHARS);
		assert.match(cut, /truncated/);
	});
});

describe("planInjection", () => {
	const result = (content: string): TraversalResult => ({
		status: "leaf",
		trail: "Root -> Backend -> asyncpg_pooling.md",
		hops: [],
		minConfidence: 0.9,
		totalMs: 12,
		reason: "leaf",
		document: { id: "asyncpg_pooling", title: "asyncpg Connection Pooling", path: "Backend/asyncpg_pooling.md", content, truncated: false, originalLength: content.length },
	});

	it("sends a guide in full, then a reminder, then in full again once the window has passed", () => {
		const injected = new Map<string, InjectedGuide>();

		assert.equal(planInjection(result("body"), injected, 1, 2).repeat, false);
		assert.equal(planInjection(result("body"), injected, 2, 2).repeat, true);
		const third = planInjection(result("body"), injected, 3, 2);
		assert.equal(third.repeat, false);
		assert.match(third.content ?? "", /\[Reference Guide: asyncpg Connection Pooling\]/);
	});

	it("sends a changed guide in full even inside the window", () => {
		const injected = new Map<string, InjectedGuide>();
		planInjection(result("old body"), injected, 1, 8);
		assert.equal(planInjection(result("new body"), injected, 2, 8).repeat, false);
	});

	it("re-injects every turn when the window is 0", () => {
		const injected = new Map<string, InjectedGuide>();
		planInjection(result("body"), injected, 1, 0);
		assert.equal(planInjection(result("body"), injected, 2, 0).repeat, false);
	});

	it("has nothing to add for a result without a document", () => {
		const empty: TraversalResult = { ...result(""), document: undefined, status: "skipped" };
		assert.equal(planInjection(empty, new Map(), 1, 8).content, null);
	});
});
