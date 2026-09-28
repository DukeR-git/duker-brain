/**
 * The Claude Code front end of the router: the plugin's hooks.
 *
 * Pi keeps one extension instance alive for a whole session. Claude Code runs a
 * hook as a fresh process for every prompt, so everything the Pi extension
 * holds in memory lives here in small JSON files instead:
 *
 *   <data>/sessions/<session_id>.json   which guides this conversation already holds
 *   <data>/breaker.json                 whether the decisions service is down
 *
 * where <data> is the plugin's persistent `CLAUDE_PLUGIN_DATA` directory. The
 * route cache needs nothing extra: brain-core already keeps it on disk.
 *
 * Contract notes taken from Claude Code's hooks docs:
 *   - UserPromptSubmit adds context with `hookSpecificOutput.additionalContext`;
 *     it is not shown in the transcript, so `systemMessage` tells the user
 *   - every hook output string is capped at 10,000 characters; past that Claude
 *     sees only a 2,000-character preview, so the guide must fit under the cap
 *   - a hook that times out is discarded and the prompt goes ahead without it,
 *     and a nonzero exit shows an error, so these functions never throw
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { JEV_URL, applyPluginOptions } from "../../brain-core/src/env.js";
import { writeFileAtomic } from "../../brain-core/src/fsutil.js";
import { Logger } from "../../brain-core/src/logger.js";
import { appendRouteLog, resolveRouteLogPath, toRouteRecord } from "../../brain-core/src/routelog.js";
import type { TraversalResult } from "../../brain-core/src/types.js";
import { describeConfig, loadConfig, type BrainConfig } from "./config.js";
import { createStack } from "./extension.js";
import { formatStatus, formatTrace } from "./inject.js";
import { isTrivialFollowUp, planInjection, type InjectedGuide } from "./session.js";

/** Claude Code's cap on one hook output string. */
export const HOOK_OUTPUT_LIMIT = 10_000;
/** What the hook lets itself send: the cap, less room for Claude Code's own wrapper. */
export const MAX_CONTEXT_CHARS = 9_900;
/** Per-guide budget under the hook, leaving room for the framing and a second guide's header. */
export const HOOK_DOCUMENT_CHARS = 8_500;

/** Mirrors the Pi extension's circuit breaker. */
const FAILURES_BEFORE_DOWN = 2;
const FIRST_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

/** Session files untouched for this long are deleted at the next session start. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
/** The "not set up yet" notice at session start is shown at most this often. */
const NOTICE_INTERVAL_MS = 24 * 60 * 60_000;

/** The fields of Claude Code's hook input that the router reads. */
export interface HookInput {
	session_id?: string;
	cwd?: string;
	hook_event_name?: string;
	/** UserPromptSubmit only. */
	prompt?: string;
	/** SessionStart only: startup, resume, clear, compact or fork. */
	source?: string;
}

export interface HookOutput {
	hookSpecificOutput?: { hookEventName: string; additionalContext: string };
	/** One line shown to the user. */
	systemMessage?: string;
}

export interface HookOptions {
	/** Defaults to a copy of `process.env`; plugin options are applied to it. */
	env?: NodeJS.ProcessEnv;
	/** Defaults to `CLAUDE_PLUGIN_DATA`, else the per-user state directory. */
	dataDir?: string;
	now?: () => number;
}

interface SessionState {
	turn: number;
	injected: Record<string, InjectedGuide>;
	last?: { at: string; cwd: string; trace: string; config: string };
}

interface BreakerState {
	failures: number;
	downUntil: number;
	cooldownMs: number;
	reason?: string;
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

export async function runPromptHook(input: HookInput, options: HookOptions = {}): Promise<HookOutput | undefined> {
	const { env, dataDir, now } = resolveOptions(options);
	const cwd = input.cwd || process.cwd();

	let config: BrainConfig;
	try {
		config = hookConfig(env, cwd);
	} catch (error) {
		process.stderr.write(`[brain-traverse] config: ${(error as Error).message}\n`);
		return undefined;
	}
	if (!config.enabled || !config.vaultRoot) return undefined;

	const sessionFile = sessionPath(dataDir, input.session_id);
	const session = readJson<SessionState>(sessionFile) ?? { turn: 0, injected: {} };
	session.turn++;

	const prompt = cleanPrompt(input.prompt ?? "");
	const breakerFile = join(dataDir, "breaker.json");
	const breaker = readJson<BreakerState>(breakerFile) ?? { failures: 0, downUntil: 0, cooldownMs: FIRST_COOLDOWN_MS };

	let result: TraversalResult | undefined;
	if (!prompt || isTrivialFollowUp(prompt)) {
		// Nothing to route; the turn still counts towards reinjection.
	} else if (now() < breaker.downUntil) {
		// The service failed recently: skip rather than make every prompt wait for a timeout.
	} else {
		const logger = new Logger(config.logLevel);
		try {
			result = await createStack(config, logger).traverser.route(prompt);
		} catch (error) {
			logger.error(`traversal threw: ${(error as Error).message}`);
		}
		if (result) {
			updateBreaker(breaker, result, now());
			writeJson(breakerFile, breaker);
			const logPath = resolveRouteLogPath(config.routeLog, env, cwd);
			if (logPath) {
				try {
					appendRouteLog(logPath, toRouteRecord(prompt, result));
				} catch {
					/* a log that cannot be written must not cost the prompt its guide */
				}
			}
		}
	}

	const injected = new Map(Object.entries(session.injected));
	const plan = result ? planInjection(result, injected, session.turn, config.reinjectAfterTurns) : undefined;
	session.injected = Object.fromEntries(injected);
	session.last = {
		at: new Date(now()).toISOString(),
		cwd,
		trace: result ? formatTrace(result) : skippedBecause(prompt, breaker, now()),
		config: describeConfig(config),
	};
	writeJson(sessionFile, session);

	if (!result || !plan?.content) return undefined;

	const output: HookOutput = {
		hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: fitToLimit(plan.content) },
	};
	if (config.displayInjection && !plan.repeat) output.systemMessage = formatStatus(result);
	return output;
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

export function runSessionStartHook(input: HookInput, options: HookOptions = {}): HookOutput | undefined {
	const { env, dataDir, now } = resolveOptions(options);

	// After /clear or a compaction the guides injected earlier are no longer in
	// the conversation, so the next prompt must send them in full again.
	if (input.source === "clear" || input.source === "compact") {
		const file = sessionPath(dataDir, input.session_id);
		const session = readJson<SessionState>(file);
		if (session) {
			session.injected = {};
			writeJson(file, session);
		}
		return undefined;
	}

	if (input.source !== "startup") return undefined;
	pruneSessions(dataDir, now());

	let problem: string | undefined;
	try {
		problem = setupProblem(hookConfig(env, input.cwd || process.cwd()));
	} catch (error) {
		problem = `the brain-traverse config could not be read (${(error as Error).message})`;
	}
	if (!problem) return undefined;

	const noticeFile = join(dataDir, "notice.json");
	const notice = readJson<{ at: number; problem: string }>(noticeFile);
	if (notice && notice.problem === problem && now() - notice.at < NOTICE_INTERVAL_MS) return undefined;
	writeJson(noticeFile, { at: now(), problem });

	return { systemMessage: `duker-brain: ${problem}` };
}

/** Why routing cannot work yet, in words that say what to do; undefined when it can. */
export function setupProblem(config: BrainConfig): string | undefined {
	if (!config.enabled) return undefined;
	if (!config.vaultRoot) {
		return "no vault is configured, so prompts are not routed. Run /duker-brain:init ~/brain --example, or set the vault folder in the plugin's settings.";
	}
	if (!existsSync(config.vaultRoot)) {
		return `the vault folder ${config.vaultRoot} does not exist. Run /duker-brain:init ${config.vaultRoot} to create it.`;
	}
	if (config.decisionsUrl.replace(/\/+$/, "") === JEV_URL && !config.apiKey) {
		return "no TypeSafe API key is set, so routing through Jev will fail. Add it in the plugin's settings, or set TYPESAFE_API_KEY.";
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// status (for the /duker-brain:status command)
// ---------------------------------------------------------------------------

export function renderStatus(options: HookOptions = {}): string {
	const { env, dataDir, now } = resolveOptions(options);
	const lines = ["duker-brain routing for Claude Code", ""];

	const latest = latestSession(dataDir);
	if (latest?.last) {
		lines.push(`Settings as the hook last saw them (${latest.last.at}, in ${latest.last.cwd}):`, indent(latest.last.config), "");
		lines.push(`Last prompt: ${latest.last.trace}`);
	} else {
		lines.push("The hook has not run yet. Settings as seen from this shell (plugin options are not visible here):");
		try {
			lines.push(indent(describeConfig(hookConfig(env, process.cwd()))));
		} catch (error) {
			lines.push(`  config error: ${(error as Error).message}`);
		}
	}

	const breaker = readJson<BreakerState>(join(dataDir, "breaker.json"));
	if (breaker && now() < breaker.downUntil) {
		const seconds = Math.ceil((breaker.downUntil - now()) / 1000);
		lines.push("", `Decisions service: paused for another ${seconds}s after repeated failures (${breaker.reason ?? "unknown error"})`);
	} else {
		lines.push("", "Decisions service: no recent failures");
	}
	lines.push("", `State: ${dataDir}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOptions(options: HookOptions): { env: NodeJS.ProcessEnv; dataDir: string; now: () => number } {
	const env = applyPluginOptions({ ...(options.env ?? process.env) });
	const dataDir = options.dataDir || env.CLAUDE_PLUGIN_DATA?.trim() || defaultDataDir(env);
	return { env, dataDir, now: options.now ?? Date.now };
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
	const base = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
	return join(base, "brain-traverse", "claude-code");
}

/** The shared config, with the guide budget cut to fit under Claude Code's hook output cap. */
function hookConfig(env: NodeJS.ProcessEnv, cwd: string): BrainConfig {
	const config = loadConfig({ env, cwd });
	if (config.maxDocumentChars > HOOK_DOCUMENT_CHARS) {
		config.maxDocumentChars = HOOK_DOCUMENT_CHARS;
		config.sources.maxDocumentChars = "capped for Claude Code's 10,000-character hook output limit";
	}
	return config;
}

/**
 * Drop the marker lines Claude Code wraps around pasted text; they would
 * otherwise take up the decision model's small prompt budget.
 */
export function cleanPrompt(prompt: string): string {
	return prompt
		.split(/\r?\n/)
		.filter((line) => !/^<\/?pasted_content\b[^>]*>$/.test(line.trim()))
		.join("\n")
		.trim();
}

function updateBreaker(breaker: BreakerState, result: TraversalResult, now: number): void {
	if (result.status === "error" && result.reason.startsWith("decisions API failed")) {
		breaker.failures++;
		breaker.reason = result.reason;
		if (breaker.failures >= FAILURES_BEFORE_DOWN) {
			breaker.downUntil = now + breaker.cooldownMs;
			breaker.cooldownMs = Math.min(breaker.cooldownMs * 2, MAX_COOLDOWN_MS);
		}
	} else if (result.status !== "error") {
		breaker.failures = 0;
		breaker.downUntil = 0;
		breaker.cooldownMs = FIRST_COOLDOWN_MS;
		delete breaker.reason;
	}
}

function skippedBecause(prompt: string, breaker: BreakerState, now: number): string {
	if (!prompt) return "skipped (empty prompt)";
	if (isTrivialFollowUp(prompt)) return "skipped (trivial follow-up)";
	if (now < breaker.downUntil) return `skipped (decisions service paused: ${breaker.reason ?? "repeated failures"})`;
	return "skipped (routing failed)";
}

/** A last line of defence: the traverser already respects the budget. */
export function fitToLimit(content: string, limit = MAX_CONTEXT_CHARS): string {
	if (content.length <= limit) return content;
	const marker = "\n\n[Reference guide truncated to fit Claude Code's hook output limit]";
	return content.slice(0, limit - marker.length) + marker;
}

function sessionPath(dataDir: string, sessionId: string | undefined): string {
	// Session ids are UUIDs; anything else is flattened so it cannot leave the folder.
	const safe = (sessionId || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
	return join(dataDir, "sessions", `${safe}.json`);
}

function latestSession(dataDir: string): SessionState | undefined {
	const dir = join(dataDir, "sessions");
	let newest: { file: string; mtime: number } | undefined;
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			const file = join(dir, name);
			const mtime = statSync(file).mtimeMs;
			if (!newest || mtime > newest.mtime) newest = { file, mtime };
		}
	} catch {
		return undefined;
	}
	return newest ? readJson<SessionState>(newest.file) : undefined;
}

function pruneSessions(dataDir: string, now: number): void {
	const dir = join(dataDir, "sessions");
	try {
		for (const name of readdirSync(dir)) {
			const file = join(dir, name);
			if (now - statSync(file).mtimeMs > SESSION_TTL_MS) rmSync(file, { force: true });
		}
	} catch {
		/* no sessions yet */
	}
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** State is a convenience: failing to save it must never fail the hook. */
function writeJson(file: string, value: unknown): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileAtomic(file, JSON.stringify(value));
	} catch (error) {
		process.stderr.write(`[brain-traverse] could not save ${file}: ${(error as Error).message}\n`);
	}
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}
