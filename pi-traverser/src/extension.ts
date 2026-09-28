/**
 * The Pi extension: the router.
 *
 * Loaded by `pi install` through the `pi` manifest in the repository root. The
 * extension is a thin wrapper: all the work lives in brain-core's traverser,
 * which the CLI drives independently so the tree can be tuned without launching Pi.
 *
 * Contract notes taken from Pi's extension docs:
 *   - the hook is `before_agent_start`, not `before_prompt`
 *   - returning `message` appends LLM-visible content; returning `systemPrompt`
 *     would replace the whole prompt for the turn and bust the prefix cache
 *   - handlers chain across extensions, so returning nothing is always safe
 *
 * Types are imported with `import type`, so jiti strips them at load time and
 * the extension does not care whether the host package is published as
 * `@earendil-works/pi-coding-agent` or under another scope.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { DecisionsClient, type ServiceHealth } from "../../brain-core/src/decisions-client.js";
import { withVaultLock } from "../../brain-core/src/fsutil.js";
import { Logger } from "../../brain-core/src/logger.js";
import { appendRouteLog, readRouteLog, renderRouteStats, resolveRouteLogPath, toRouteRecord } from "../../brain-core/src/routelog.js";
import { BrainTraverser } from "../../brain-core/src/traverser.js";
import type { TraversalResult } from "../../brain-core/src/types.js";
import { compileVault, scanVault } from "../../brain-core/src/vault.js";
import { loadEvalSuite, renderEvalReport, runEvalSuite } from "../../brain-core/src/eval.js";
import { describeConfig, loadConfig, type BrainConfig } from "./config.js";
import { CUSTOM_TYPE, formatInjection, formatReminder, formatStatus, formatTrace } from "./inject.js";

// Structural stand-ins for Pi's types: enough to be type-safe here without
// pinning a package name this project does not depend on.
interface PiUi {
	notify(text: string, level?: string): void;
	setStatus(key: string, text: string): void;
}
interface PiContext {
	ui: PiUi;
	hasUI?: boolean;
	cwd?: string;
	mode?: string;
}
interface BeforeAgentStartEvent {
	prompt: string;
	systemPrompt?: string;
}
interface PiExtensionAPI {
	on(
		event: "before_agent_start",
		handler: (
			event: BeforeAgentStartEvent,
			ctx: PiContext,
		) => Promise<{ message?: unknown; systemPrompt?: string } | undefined>,
	): void;
	on(event: string, handler: (event: any, ctx: PiContext) => unknown): void;
	registerCommand(
		name: string,
		spec: {
			description: string;
			handler: (args: string, ctx: PiContext) => Promise<void> | void;
			getArgumentCompletions?: (prefix: string) => { value: string; label: string }[];
		},
	): void;
}

export interface ExtensionState {
	config: BrainConfig;
	traverser: BrainTraverser;
	client: DecisionsClient;
	logger: Logger;
	lastResult?: TraversalResult;
}

/** Exported so the CLI and the tests build the stack exactly the way Pi does. */
export function createStack(config: BrainConfig, logger = new Logger(config.logLevel)): ExtensionState {
	const client = new DecisionsClient({
		baseUrl: config.decisionsUrl,
		path: config.decisionsPath,
		apiKey: config.apiKey,
		model: config.model,
		timeoutMs: config.timeoutMs,
		retries: config.retries,
		logger,
	});
	return { config, client, logger, traverser: new BrainTraverser(config, client, logger) };
}

export interface ExtensionOptions {
	/** Environment to read config from; defaults to `process.env`. For tests. */
	env?: NodeJS.ProcessEnv;
	/** Clock for the health back-off; defaults to `Date.now`. For tests. */
	now?: () => number;
}

/** First re-probe after the service goes down; doubles up to the ceiling. */
const FIRST_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
/** A host that says it is still loading its checkpoint is worth asking again soon. */
const LOADING_COOLDOWN_MS = 5_000;
/** Consecutive decision failures on the hot path before the service is treated as down. */
const FAILURES_BEFORE_DOWN = 2;

/** Identical prompts within this window reuse the earlier route (a regenerate, a retry). */
const ROUTE_CACHE_MS = 2 * 60_000;
const ROUTE_CACHE_SIZE = 32;

/**
 * Trivial follow-up prompts that need no background manual (a one-word
 * confirmation, a greeting, "continue"). Short-circuiting them locally saves
 * the gate request, network round-trip, and avoids injecting noise.
 */
const TRIVIAL_PROMPT =
	/^(?:yes|yep|yeah|no|nope|ok|okay|sure|thanks|thank you|continue|proceed|go ahead|done|next|agree|looks good|lgtm)[.!]?$/i;

export function isTrivialFollowUp(prompt: string): boolean {
	const cleaned = prompt.replace(/\s+/g, " ").trim();
	return TRIVIAL_PROMPT.test(cleaned);
}

const SUBCOMMANDS = ["status", "trace", "reload", "rebuild", "stats", "eval", "on", "off", "config", "help"];

export default function brainTraverse(pi: PiExtensionAPI, options: ExtensionOptions = {}): void {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const logger = new Logger("info");

	let state: ExtensionState | undefined;
	let configError: string | undefined;
	let userEnabled = true;
	let ui: PiContext | undefined;

	// The service's health, as a circuit breaker rather than a latch: when it is
	// down, prompts skip routing instead of each paying a timeout, and a probe
	// runs again after a cool-down so a restart of the host is picked up on its own.
	let health: "unknown" | "up" | "down" = "unknown";
	let lastHealth: ServiceHealth | undefined;
	let nextProbeAt = 0;
	let cooldownMs = FIRST_COOLDOWN_MS;
	let consecutiveFailures = 0;
	let probing: Promise<void> | undefined;

	// Session memory: which guides are already in the conversation, and recent routes.
	let turn = 0;
	const injected = new Map<string, { turn: number; hash: string }>();
	const routeCache = new Map<string, { at: number; result: TraversalResult }>();

	const notify = (text: string, level = "info") => {
		if (ui?.hasUI) ui.ui.notify(text, level);
		else process.stderr.write(`[brain-traverse] ${level}: ${text}\n`);
	};

	const setStatus = (text: string) => {
		if (ui?.hasUI) ui.ui.setStatus("brain-traverse", text);
	};

	const resetSession = () => {
		turn = 0;
		injected.clear();
		routeCache.clear();
	};

	/** (Re)load config and rebuild the stack. Never throws: a bad config disables routing and says why. */
	const build = (cwd: string) => {
		try {
			const config = loadConfig({ env, cwd });
			logger.setLevel(config.logLevel);
			state = createStack(config, logger);
			configError = undefined;
			userEnabled = config.enabled;
			for (const warning of config.warnings) logger.warn(warning);
		} catch (error) {
			state = undefined;
			configError = (error as Error).message;
			logger.error(`${configError}; routing is disabled until the config is fixed and /brain reload is run`);
		}
		health = "unknown";
		cooldownMs = FIRST_COOLDOWN_MS;
		consecutiveFailures = 0;
		resetSession();
	};

	const markDown = (why: string, loading = false) => {
		const wasDown = health === "down";
		health = "down";
		const wait = loading ? LOADING_COOLDOWN_MS : cooldownMs;
		nextProbeAt = now() + wait;
		if (!loading) cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
		if (!wasDown) {
			logger.warn(`${why}; routing is paused and will retry in ${Math.round(wait / 1000)}s`);
			setStatus("brain: service down");
		}
	};

	const probe = async (): Promise<void> => {
		if (!state) return;
		const result = await state.client.health();
		lastHealth = result;
		if (result.ok) {
			const wasDown = health === "down";
			health = "up";
			cooldownMs = FIRST_COOLDOWN_MS;
			consecutiveFailures = 0;
			const where = result.backend === "laya" ? `${result.model ?? "laya"} on ${result.device ?? "?"}` : result.model;
			if (wasDown) logger.warn(`decisions API is back (${where}); routing resumed`);
			else logger.info(`decisions API ready (${where})`);
			setStatus(`brain: ready (${where})`);
		} else {
			markDown(`decisions API not usable at ${state.client.endpoint}: ${result.error}`, result.loading === true);
		}
	};

	/** Start a background probe if one is due; the current prompt does not wait for it. */
	const maybeReprobe = () => {
		if (health !== "down" || now() < nextProbeAt || probing) return;
		probing = probe().finally(() => {
			probing = undefined;
		});
	};

	pi.on("session_start", async (_event: unknown, ctx: PiContext) => {
		ui = ctx;
		// stdout belongs to the TUI, and so does the terminal under it: with a UI,
		// problems become notifications and chatter is dropped (see /brain trace).
		logger.setSink((level, message) => {
			if (ctx.hasUI) {
				if (level === "error" || level === "warn") ctx.ui.notify(`brain-traverse: ${message}`, level);
			} else {
				process.stderr.write(`[brain-traverse] ${level}: ${message}\n`);
			}
		});

		build(ctx.cwd ?? process.cwd());
		if (!state || !userEnabled) return;

		if (!state.config.vaultRoot) {
			logger.warn(
				"no vault configured (run /brain-init <dir> [--example], or set vaultRoot in ~/.config/brain-traverse/config.json); routing is disabled",
			);
			return;
		}
		await probe();
	});

	// A new branch or a compacted history may no longer hold the guides injected
	// earlier, so forget them. (Events Pi does not emit simply never fire.)
	for (const event of ["session_switch", "session_branch", "session_compact", "session_tree"]) {
		try {
			pi.on(event, () => resetSession());
		} catch {
			/* an older Pi without this event */
		}
	}

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: PiContext) => {
		ui ??= ctx;
		if (!state && !configError) build(ctx.cwd ?? process.cwd());
		if (!state || !userEnabled || !state.config.vaultRoot) return undefined;

		turn++;
		if (health !== "up") {
			maybeReprobe();
			return undefined;
		}

		const key = event.prompt.replace(/\s+/g, " ").trim();
		if (isTrivialFollowUp(key)) {
			logger.debug(`short-circuiting trivial follow-up prompt: '${key}'`);
			setStatus("brain: no guide needed");
			return undefined;
		}

		const cached = routeCache.get(key);
		let result: TraversalResult;
		if (cached && now() - cached.at < ROUTE_CACHE_MS) {
			result = cached.result;
		} else {
			try {
				result = await state.traverser.route(event.prompt);
			} catch (error) {
				// The traverser is written not to throw; if it ever does, the turn still
				// proceeds without injected context.
				logger.error(`traversal threw: ${(error as Error).message}`);
				return undefined;
			}
			if (result.status !== "error") {
				routeCache.set(key, { at: now(), result });
				if (routeCache.size > ROUTE_CACHE_SIZE) routeCache.delete(routeCache.keys().next().value!);
			}
			const logPath = resolveRouteLogPath(state.config.routeLog, env);
			if (logPath) appendRouteLog(logPath, toRouteRecord(event.prompt, result));
		}

		state.lastResult = result;
		logger.debug(formatTrace(result));
		setStatus(formatStatus(result));

		if (result.status === "error") {
			if (result.reason.startsWith("decisions API failed")) {
				consecutiveFailures++;
				if (consecutiveFailures >= FAILURES_BEFORE_DOWN) markDown(result.reason);
				else logger.warn(result.reason);
			} else {
				logger.warn(result.reason);
			}
		} else {
			consecutiveFailures = 0;
		}

		const docs =
			result.documents && result.documents.length > 0
				? result.documents
				: result.document
					? [result.document]
					: [];
		if (docs.length === 0) return undefined;

		// The same, unchanged guide injected a few turns ago is still in the
		// conversation: send a one-line reminder instead of another full copy.
		const window = state.config.reinjectAfterTurns;
		const docHashes = docs.map((doc) => ({
			doc,
			hash: createHash("sha1").update(doc.content).digest("hex"),
		}));

		const repeatStatuses = docHashes.map(({ doc, hash }) => {
			const previous = injected.get(doc.path);
			const repeat = window > 0 && previous !== undefined && previous.hash === hash && turn - previous.turn < window;
			return { doc, hash, repeat, previous };
		});

		const anyRepeat = repeatStatuses.some((r) => r.repeat);

		let content: string | null = null;

		if (!anyRepeat) {
			content = formatInjection(result);
			for (const { doc, hash } of docHashes) {
				injected.set(doc.path, { turn, hash });
			}
		} else {
			const blocks: string[] = [];
			for (const { doc, hash, repeat, previous } of repeatStatuses) {
				const singleRes: TraversalResult = { ...result, document: doc, documents: [doc] };
				if (repeat && previous) {
					const reminder = formatReminder(singleRes, turn - previous.turn);
					if (reminder) blocks.push(reminder);
				} else {
					const injection = formatInjection(singleRes);
					if (injection) blocks.push(injection);
					injected.set(doc.path, { turn, hash });
				}
			}
			content = blocks.length > 0 ? blocks.join("\n\n") : null;
		}

		if (!content) return undefined;

		return {
			message: {
				customType: CUSTOM_TYPE,
				content,
				display: state.config.displayInjection,
				details: {
					status: result.status,
					trail: result.trail,
					path: docs.map((d) => d.path).join(", "),
					repeat: anyRepeat,
					minConfidence: result.minConfidence,
					totalMs: Math.round(result.totalMs),
					hops: result.hops,
					gate: result.gate,
				},
			},
		};
	});

	pi.registerCommand("brain", {
		description: "Brain-tree routing: status | trace | reload | rebuild | stats | on | off | config",
		getArgumentCompletions: (prefix: string) =>
			SUBCOMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx: PiContext) => {
			ui ??= ctx;
			const [command = "status"] = args.trim().split(/\s+/).filter(Boolean);
			if (!state && command !== "reload" && command !== "status") {
				ctx.ui.notify(`brain-traverse is not configured: ${configError ?? "run /brain reload"}`, "warn");
				return;
			}

			switch (command) {
				case "on": {
					userEnabled = true;
					await probe();
					ctx.ui.notify(
						health === "up" ? "brain-traverse enabled" : `brain-traverse enabled, but ${lastHealth?.error ?? "the service is down"}`,
						health === "up" ? "info" : "warn",
					);
					return;
				}
				case "off": {
					userEnabled = false;
					setStatus("brain: off");
					ctx.ui.notify("brain-traverse disabled", "info");
					return;
				}
				case "reload": {
					// Config, stack, caches and service health all start over, so an
					// edited config file or a restarted host is picked up without /reload.
					build(ctx.cwd ?? process.cwd());
					if (!state) {
						ctx.ui.notify(`brain-traverse: ${configError}`, "error");
						return;
					}
					if (state.config.vaultRoot) await probe();
					const lines = ["brain-traverse: config reloaded, caches cleared"];
					try {
						const stale = compileVault(state.config.vaultRoot, { dryRun: true, maxHops: state.config.maxHops }).files.filter(
							(file) => file.status === "written",
						);
						if (stale.length) lines.push(`${stale.length} manifest(s) are stale; run /brain rebuild`);
					} catch (error) {
						lines.push(`could not check manifests: ${(error as Error).message}`);
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "rebuild": {
					const config = state!.config;
					try {
						const result = withVaultLock(config.vaultRoot, () => compileVault(config.vaultRoot, { maxHops: config.maxHops }));
						state!.traverser.reload();
						routeCache.clear();
						const written = result.files.filter((file) => file.status === "written").length;
						const errors = result.issues.filter((issue) => issue.severity === "error").length;
						ctx.ui.notify(
							`brain-traverse: rebuilt ${written} manifest(s)` + (errors ? `; ${errors} vault error(s), run brain_doctor` : ""),
							errors ? "warn" : "info",
						);
					} catch (error) {
						ctx.ui.notify(`brain-traverse: rebuild failed: ${(error as Error).message}`, "error");
					}
					return;
				}
				case "stats": {
					const path = resolveRouteLogPath(state!.config.routeLog, env);
					if (!path) {
						ctx.ui.notify("the routing log is off (routeLog is empty)", "info");
						return;
					}
					let root;
					try {
						root = state!.config.vaultRoot ? scanVault(state!.config.vaultRoot).root : undefined;
					} catch {
						root = undefined;
					}
					ctx.ui.notify(renderRouteStats(readRouteLog(path), root), "info");
					return;
				}
				case "config": {
					ctx.ui.notify(
						describeConfig(state!.config, { routing: routingState(), service: serviceState() }),
						state!.config.warnings.length ? "warn" : "info",
					);
					return;
				}
				case "trace": {
					ctx.ui.notify(
						state!.lastResult ? formatTrace(state!.lastResult) : "no routing has happened yet",
						"info",
					);
					return;
				}
				case "eval": {
					if (!state?.config.vaultRoot) {
						ctx.ui.notify("no vault configured", "warn");
						return;
					}
					const parts = args.trim().split(/\s+/).slice(1);
					let evalPath = parts[0];
					if (!evalPath) {
						const jsonP = join(state.config.vaultRoot, "evals.json");
						const yamlP = join(state.config.vaultRoot, "evals.yaml");
						if (existsSync(jsonP)) evalPath = jsonP;
						else if (existsSync(yamlP)) evalPath = yamlP;
						else {
							ctx.ui.notify(`no eval suite found in ${state.config.vaultRoot} (expected evals.json or evals.yaml)`, "warn");
							return;
						}
					}
					try {
						const suite = loadEvalSuite(resolve(evalPath));
						const report = await runEvalSuite(suite, state.traverser);
						ctx.ui.notify(renderEvalReport(report), report.failed === 0 ? "info" : "warn");
					} catch (err) {
						ctx.ui.notify(`eval failed: ${(err as Error).message}`, "error");
					}
					return;
				}
				case "help": {
					const helpLines = [
						"brain-traverse commands:",
						"  /brain status   - Routing state, endpoint, service health, and last route",
						"  /brain trace    - Full trail and confidences from the last prompt",
						"  /brain reload   - Reload config, clear caches, and re-probe health",
						"  /brain rebuild  - Recompile vault manifests (after editing notes by hand)",
						"  /brain stats    - Routing log report: hit rates, zero-hit notes, near-ties",
						"  /brain eval     - Run routing regression evals (default: evals.json)",
						"  /brain on|off   - Enable or disable routing for this session",
						"  /brain config   - Display resolved configuration and setting origins",
						"  /brain help     - Show this command reference",
						"",
						"Authoring & research commands:",
						"  /brain-init <dir> [--example] - Initialize a new or existing brain vault",
						"  /brain-capture                - Review session and capture durable notes",
						"  /brain-research <topic>       - Research a topic and record a structured note",
					];
					ctx.ui.notify(helpLines.join("\n"), "info");
					return;
				}
				default: {
					if (state?.config.vaultRoot && userEnabled) await probe();
					const lines = [
						`routing   ${routingState()}`,
						`endpoint  ${state?.client.endpoint ?? "(none)"}`,
						`service   ${serviceState()}`,
						`vault     ${state?.config.vaultRoot || "(unset)"}`,
						state?.lastResult ? `last      ${formatTrace(state.lastResult)}` : "last      (none)",
					];
					if (configError) lines.push(`config    ${configError}`);
					ctx.ui.notify(lines.join("\n"), health === "up" ? "info" : "warn");
				}
			}
		},
	});

	function routingState(): string {
		if (configError) return "off (config error)";
		if (!userEnabled) return "off";
		if (!state?.config.vaultRoot) return "off (no vault)";
		if (health === "down") return `paused (service down; retrying in ${Math.max(0, Math.round((nextProbeAt - now()) / 1000))}s)`;
		return health === "up" ? "on" : "on (not yet checked)";
	}

	function serviceState(): string {
		if (!lastHealth) return "(not checked)";
		if (!lastHealth.ok) return lastHealth.error ?? "down";
		return `up (${lastHealth.backend}: ${lastHealth.model ?? "?"} on ${lastHealth.device ?? "?"})`;
	}
}
