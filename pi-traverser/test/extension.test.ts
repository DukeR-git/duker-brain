/**
 * Drives the extension factory through a stub of Pi's ExtensionAPI, so the hook
 * wiring is covered without launching Pi. The factory takes its environment and
 * clock as options, so nothing here touches `process.env`.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import brainTraverse, { isTrivialFollowUp } from "../src/extension.js";
import { FIXTURE, isolatedEnv, tempDir } from "../../brain-core/test/helpers.js";
import { readRouteLog } from "../../brain-core/src/routelog.js";
import { startMockDecisions, type MockServer } from "../../brain-core/test/mock-decisions.js";

let mock: MockServer;

before(async () => {
	mock = await startMockDecisions();
});

after(async () => {
	await mock.close();
});

interface Harness {
	start(): Promise<void>;
	prompt(text: string): Promise<any>;
	command(args: string): Promise<void>;
	event(name: string): void;
	notifications: { text: string; level?: string }[];
	statuses: Record<string, string>;
	env: Record<string, string>;
	clock: { now: number };
}

const POOLING = "How do I configure connection pooling for asyncpg in FastAPI?";

function harness(extra: Record<string, string> = {}, cwd = process.cwd()): Harness {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
	const notifications: { text: string; level?: string }[] = [];
	const statuses: Record<string, string> = {};
	const clock = { now: 1_000_000 };

	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd,
		ui: {
			notify: (text: string, level?: string) => notifications.push({ text, level }),
			setStatus: (key: string, text: string) => {
				statuses[key] = text;
			},
		},
	};

	const env = isolatedEnv({
		BRAIN_VAULT_ROOT: FIXTURE,
		BRAIN_DECISIONS_URL: mock.url,
		BRAIN_LOG_LEVEL: "warn",
		BRAIN_FALLBACK_DOC: "general_instructions.md",
		BRAIN_USE_CACHE: "false",
		...extra,
	});

	brainTraverse(
		{
			on: (event: string, handler: any) => handlers.set(event, handler),
			registerCommand: (name: string, spec: any) => commands.set(name, spec),
		} as any,
		{ env, now: () => clock.now },
	);

	return {
		start: () => handlers.get("session_start")!({ reason: "startup" }, ctx),
		prompt: (text: string) => handlers.get("before_agent_start")!({ prompt: text, systemPrompt: "SYS" }, ctx),
		command: async (args: string) => {
			await commands.get("brain")!.handler(args, ctx);
		},
		event: (name: string) => handlers.get(name)?.({}, ctx),
		notifications,
		statuses,
		env,
		clock,
	};
}

const settle = () => new Promise((done) => setTimeout(done, 50));

describe("the Pi extension", () => {
	it("injects an LLM-visible message and leaves the system prompt alone", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();

		const result = await pi.prompt(POOLING);

		assert.ok(result, "the hook returned something");
		assert.equal(
			result.systemPrompt,
			undefined,
			"never returns a systemPrompt - that would replace the turn's prompt and bust the prefix cache",
		);
		assert.equal(result.message.customType, "brain-traverse");
		assert.match(result.message.content, /^\[Reference Guide: asyncpg Connection Pooling\]/);
		assert.equal(result.message.display, true);
		assert.equal(result.message.details.path, "Backend/asyncpg_pooling.md");
		assert.equal(result.message.details.hops.length, 2);
		assert.equal(result.message.details.gate.needed, true);
	});

	it("returns nothing when the gate says no guide is needed", async () => {
		mock.behaviour = { gate: 0.05 };
		const pi = harness();
		await pi.start();

		assert.equal(await pi.prompt("morning!"), undefined);
		assert.equal(pi.statuses["brain-traverse"], "brain: no guide needed");
		mock.behaviour = {};
	});

	it("short-circuits trivial follow-up prompts locally", async () => {
		assert.equal(isTrivialFollowUp("yes"), true);
		assert.equal(isTrivialFollowUp("continue"), true);
		assert.equal(isTrivialFollowUp("thanks!"), true);
		assert.equal(isTrivialFollowUp("lgtm"), true);
		assert.equal(isTrivialFollowUp("How do I pool asyncpg connections?"), false);

		const beforeHits = mock.hits;
		const pi = harness();
		await pi.start();

		assert.equal(await pi.prompt("continue"), undefined);
		assert.equal(mock.hits, beforeHits, "trivial follow-up made zero requests to the decisions API");
		assert.equal(pi.statuses["brain-traverse"], "brain: no guide needed");
	});

	it("returns nothing, rather than throwing, when the decisions API fails", async () => {
		mock.behaviour = { failWith: 500 };
		const pi = harness({ BRAIN_RETRIES: "0" });
		await pi.start();

		assert.equal(await pi.prompt("anything"), undefined);
		mock.behaviour = {};
	});

	it("pauses when the service is unreachable at session start", async () => {
		const pi = harness({ BRAIN_DECISIONS_URL: "http://127.0.0.1:1", BRAIN_TIMEOUT_MS: "200" });
		await pi.start();

		// A dead side-car must not make every prompt pay a timeout.
		const started = performance.now();
		assert.equal(await pi.prompt("How do I pool asyncpg connections?"), undefined);
		assert.ok(performance.now() - started < 100, "skipped without a request");
		assert.equal(pi.statuses["brain-traverse"], "brain: service down");
	});

	it("resumes on its own once the service comes back", async () => {
		mock.behaviour = { health: "loading" };
		const pi = harness();
		await pi.start();
		assert.equal(await pi.prompt(POOLING), undefined, "still loading: nothing routed");

		// The host finishes loading; after the cool-down the next prompt kicks off
		// a background probe, and the one after that routes.
		mock.behaviour = {};
		pi.clock.now += 6_000;
		assert.equal(await pi.prompt(POOLING), undefined, "the probe does not block this prompt");
		await settle();
		const result = await pi.prompt(POOLING);
		assert.equal(result?.message.details.path, "Backend/asyncpg_pooling.md");
		assert.match(pi.notifications.map((note) => note.text).join("\n"), /routing resumed/);
	});

	it("stops paying for a service that starts failing mid-session", async () => {
		mock.behaviour = {};
		const pi = harness({ BRAIN_RETRIES: "0" });
		await pi.start();

		mock.behaviour = { failWith: 500 };
		await pi.prompt("first failure");
		await pi.prompt("second failure");
		const before = mock.hits;
		await pi.prompt("now paused");
		assert.equal(mock.hits, before, "no request while paused");
		assert.equal(pi.statuses["brain-traverse"], "brain: service down");
		mock.behaviour = {};
	});

	it("disables itself when no vault is configured, and says so", async () => {
		const pi = harness({ BRAIN_VAULT_ROOT: " " });
		await pi.start();
		assert.equal(await pi.prompt("anything"), undefined);
		assert.match(pi.notifications.at(-1)!.text, /no vault configured/);
	});

	it("survives a broken config file and recovers on /brain reload", async () => {
		const cwd = tempDir("brain-cwd-");
		writeFileSync(join(cwd, "brain-traverse.config.json"), "{ nope", "utf8");
		const pi = harness({}, cwd);
		await pi.start();

		assert.equal(await pi.prompt(POOLING), undefined);
		assert.match(pi.notifications.at(-1)!.text, /could not parse/);

		writeFileSync(join(cwd, "brain-traverse.config.json"), JSON.stringify({ maxHops: 4 }), "utf8");
		mock.behaviour = {};
		await pi.command("reload");
		assert.match(pi.notifications.at(-1)!.text, /config reloaded/);
		assert.ok(await pi.prompt(POOLING));
	});

	it("reports a status line after each routed prompt", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();
		await pi.prompt(POOLING);

		assert.match(pi.statuses["brain-traverse"], /^brain: asyncpg_pooling 0\.93 \d+ms$/);
	});

	it("honours /brain off and /brain on", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();

		await pi.command("off");
		assert.equal(await pi.prompt("How do I pool asyncpg connections?"), undefined);

		await pi.command("on");
		assert.ok(await pi.prompt("How do I pool asyncpg connections?"));
	});

	it("reports state through /brain status, /brain trace and /brain config", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();
		await pi.prompt(POOLING);

		await pi.command("status");
		const status = pi.notifications.at(-1)!.text;
		assert.match(status, /routing {3}on/);
		assert.match(status, /service {3}up/);

		await pi.command("trace");
		assert.match(pi.notifications.at(-1)!.text, /Backend\/asyncpg_pooling\.md/);

		await pi.command("config");
		const config = pi.notifications.at(-1)!.text;
		assert.match(config, /routing {6}on/);
		assert.match(config, /\[env BRAIN_VAULT_ROOT\]/, "says where the vault setting came from");
	});

	it("displays command help via /brain help and lists all commands", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();

		await pi.command("help");
		const helpText = pi.notifications.at(-1)!.text;
		assert.match(helpText, /brain-traverse commands:/);
		assert.match(helpText, /\/brain status/);
		assert.match(helpText, /\/brain eval/);
		assert.match(helpText, /\/brain-init/);
		assert.match(helpText, /\/brain-capture/);
	});

	it("runs evals via /brain eval", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();

		await pi.command("eval");
		const evalText = pi.notifications.at(-1)!.text;
		assert.match(evalText, /✔ \[PASS\] asyncpg-pool/);
		assert.match(evalText, /Summary: \d+\/\d+ passed/);
	});

	it("respects BRAIN_DISPLAY_INJECTION", async () => {
		mock.behaviour = {};
		const pi = harness({ BRAIN_DISPLAY_INJECTION: "false" });
		await pi.start();

		const result = await pi.prompt(POOLING);
		assert.equal(result.message.display, false);
	});

	it("routes through a Jev-style API, sending the key and the model", async () => {
		mock.behaviour = { jevKey: "sk-test" };
		const before = mock.requests.length;
		const pi = harness({ TYPESAFE_API_KEY: "sk-test" });
		await pi.start();

		assert.match(pi.statuses["brain-traverse"], /^brain: ready \(jev-latest\)$/);
		const result = await pi.prompt(POOLING);
		assert.equal(result.message.details.path, "Backend/asyncpg_pooling.md");
		assert.equal(mock.requests[before].model, "jev-latest");
		mock.behaviour = {};
	});

	it("pauses, naming the fix, when Jev has no API key", async () => {
		mock.behaviour = { jevKey: "sk-test" };
		const pi = harness({ TYPESAFE_API_KEY: "", BRAIN_DECISIONS_API_KEY: "" });
		await pi.start();

		assert.equal(await pi.prompt("How do I pool asyncpg connections?"), undefined);
		assert.match(pi.notifications.at(-1)!.text, /TYPESAFE_API_KEY/);
		mock.behaviour = {};
	});
});

describe("session memory", () => {
	it("sends a one-line reminder instead of re-injecting the same guide", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();

		const first = await pi.prompt(POOLING);
		assert.equal(first.message.details.repeat, false);

		const second = await pi.prompt("And what pool size should asyncpg use under FastAPI?");
		assert.equal(second.message.details.repeat, true);
		assert.match(second.message.content, /already provided 1 turn\(s\) ago/);
		assert.ok(second.message.content.length < 300, "a reminder, not the document");
	});

	it("re-injects after the window, and after the history changes", async () => {
		mock.behaviour = {};
		const pi = harness({ BRAIN_REINJECT_AFTER_TURNS: "2" });
		await pi.start();

		await pi.prompt(POOLING);
		await pi.prompt("unrelated: how are you");
		const third = await pi.prompt("asyncpg pool connections in FastAPI again");
		assert.equal(third.message.details.repeat, false, "two turns later it goes in again");

		pi.event("session_compact");
		const afterCompact = await pi.prompt(`${POOLING} once more`);
		assert.equal(afterCompact.message.details.repeat, false, "a compacted history may have lost it");
	});

	it("can be told to inject every turn", async () => {
		mock.behaviour = {};
		const pi = harness({ BRAIN_REINJECT_AFTER_TURNS: "0" });
		await pi.start();
		await pi.prompt(POOLING);
		const again = await pi.prompt(`${POOLING}?`);
		assert.equal(again.message.details.repeat, false);
	});

	it("reuses the route for an identical prompt instead of asking again", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();
		await pi.prompt(POOLING);
		const before = mock.hits;
		await pi.prompt(POOLING);
		assert.equal(mock.hits, before);
	});

	it("logs each route without the prompt text, for /brain stats", async () => {
		mock.behaviour = {};
		const pi = harness();
		await pi.start();
		await pi.prompt(POOLING);

		const records = readRouteLog(resolve(pi.env.XDG_STATE_HOME, "brain-traverse", "routes.jsonl"));
		assert.equal(records.length, 1);
		assert.equal(records[0].path, "Backend/asyncpg_pooling.md");
		assert.ok(!JSON.stringify(records).includes("asyncpg in FastAPI"));

		await pi.command("stats");
		assert.match(pi.notifications.at(-1)!.text, /1 routed prompt\(s\)/);
	});

	it("handles composite routing with multiple guides and reminders across turns", async () => {
		mock.behaviour = {
			probabilities: (options) => {
				if (options.includes("backend") && options.includes("infrastructure")) {
					return { backend: 0.52, infrastructure: 0.43, frontend: 0.05, general_instructions: 0 };
				}
				if (options.includes("asyncpg_pooling")) return { asyncpg_pooling: 0.92, celery_tasks: 0.08 };
				if (options.includes("docker_deploy")) return { docker_deploy: 0.89, github_actions: 0.11 };
				return Object.fromEntries(options.map((o) => [o, 1 / options.length]));
			},
			chooseBy: (options) => {
				if (options.includes("backend")) return "backend";
				if (options.includes("asyncpg_pooling")) return "asyncpg_pooling";
				if (options.includes("docker_deploy")) return "docker_deploy";
				return options[0];
			},
		};

		const pi = harness({ BRAIN_COMPOSITE_ENABLED: "true" });
		await pi.start();

		const first = await pi.prompt("Deploy our FastAPI asyncpg backend with Docker");
		assert.ok(first);
		assert.equal(first.message.details.status, "composite");
		assert.match(first.message.details.path, /Backend\/asyncpg_pooling\.md, Infrastructure\/docker_deploy\.md/);
		assert.match(first.message.content, /\[Reference Guide 1\/2: asyncpg Connection Pooling\]/);
		assert.match(first.message.content, /\[Reference Guide 2\/2: Docker Deployment\]/);

		// Second turn with same composite query triggers reminder for both guides
		const second = await pi.prompt("Deploy our FastAPI asyncpg backend with Docker again");
		assert.ok(second);
		assert.equal(second.message.details.repeat, true);
		assert.match(second.message.content, /already provided 1 turn\(s\) ago/);

		mock.behaviour = {};
	});
});
