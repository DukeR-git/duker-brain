/**
 * The one configuration loader, shared by the router, the keeper and both CLIs.
 *
 * Resolved from (in increasing priority):
 *   1. the defaults below
 *   2. the user file: ~/.config/brain-traverse/config.json
 *   3. a project file: $BRAIN_CONFIG, else ./brain-traverse.config.json
 *   4. BRAIN_* environment variables (and TYPESAFE_API_KEY for the key)
 *   5. explicit overrides (the CLIs' flags)
 *
 * One loader, not one per package, because the keeper's `brain_check_routing`
 * has to predict what the router will do: if they read different settings, the
 * prediction is wrong in exactly the cases someone has tuned.
 *
 * Every value is validated. A typo'd key, a `"false"` string where a boolean
 * belongs, or an unknown log level becomes a warning and the default — never a
 * silently wrong setting.
 */

import {
	DEFAULT_DECISIONS_PATH,
	DEFAULT_MODEL,
	JEV_URL,
	TYPESAFE_KEY_ENV,
	defaultRouteBudget,
	defaultTimeout,
	readConfigFiles,
	resolveApiKey,
	resolveUserPath,
} from "./env.js";
import type { LogLevel } from "./logger.js";

export const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

export interface BrainConfig {
	/** Master switch; false makes the router a no-op. */
	enabled: boolean;
	/** Absolute path to the Obsidian vault root holding the top-level `_index.json`. */
	vaultRoot: string;

	/** Base URL of the decisions API: https://api.typesafe.ai for Jev, or a self-hosted Laya. */
	decisionsUrl: string;
	/** `/v1/systemone` (Jev's endpoint, also served by host-laya) or host-laya's `/v1/decisions` alias. */
	decisionsPath: string;
	/** Bearer token. Required by Jev, and by a Laya host started with `LAYA_API_KEY`. */
	apiKey?: string;
	/** The `model` sent with every request. Jev reads it; Laya ignores it. */
	model: string;
	/** Per-request timeout. Derived from `decisionsUrl` when 0: 500ms on the local network, 2000ms remote. */
	timeoutMs: number;
	/** Retries on network error, 429 or 5xx, within `routeBudgetMs`. */
	retries: number;
	/** Ceiling on a whole route, every hop and retry included. Derived when 0: 1000ms local, 3000ms remote. */
	routeBudgetMs: number;

	/** Hard ceiling on hops, so a malformed vault cannot loop forever. */
	maxHops: number;
	/** Below this, stop traversing and fall back. */
	minConfidence: number;
	/** Laya only: below this act probability, treat a hop as unsure. 0 disables the check. */
	minActProbability: number;

	/** Ask "does this prompt need a manual?" before routing. Rides in hop 1's forward pass. */
	gateEnabled: boolean;
	/** Noul probability at or above which a reference guide is considered needed. */
	gateThreshold: number;

	/**
	 * The catch-all note. `"auto"` uses the note marked `fallback: true` (the
	 * nearest one above where routing gave up); a vault-relative path pins one
	 * note; `""` disables falling back.
	 */
	fallbackDocument: string;

	/** Guard against a huge note eating the agent model's context. */
	maxDocumentChars: number;
	/**
	 * How much of the user prompt is sent as the decision `state`. Laya's English
	 * checkpoint has a 512-token context and the criteria block shares it.
	 */
	maxPromptChars: number;

	/** Re-read `_index.json` when it changes on disk. Disable for a read-only vault. */
	watchManifests: boolean;
	/** Show the injected reference block in the Pi TUI. */
	displayInjection: boolean;
	/**
	 * Do not inject the same unchanged guide again within this many turns; a
	 * one-line reminder goes in instead. 0 re-injects on every turn.
	 */
	reinjectAfterTurns: number;
	/** JSONL routing log for `brain-traverse stats`. `"auto"` = the user state dir; `""` = off. */
	routeLog: string;
	/** Use the semantic route cache for prompt memoization. Defaults to true. */
	useCache: boolean;
	/** Support multi-document composite routing for cross-cutting prompts. Defaults to true. */
	compositeEnabled: boolean;
	/** Minimum probability for a branch/leaf to qualify as a composite candidate. Defaults to 0.25. */
	compositeThreshold: number;
	/** Minimum ratio of candidate probability to winner probability to qualify. Defaults to 0.65. */
	compositeMarginRatio: number;
	/** Maximum number of complementary guides to retrieve under composite routing. Defaults to 2. */
	maxCompositeDocuments: number;

	logLevel: LogLevel;

	/** Where each setting came from: `default`, a file path, `env BRAIN_X`, or `override`. */
	sources: Record<string, string>;
	/** Settings that were ignored, and why. Shown by `/brain config` and `brain-traverse config`. */
	warnings: string[];
}

type SettingKey = Exclude<keyof BrainConfig, "sources" | "warnings">;

type Kind = "boolean" | "number" | "integer" | "string" | "logLevel";

interface Setting {
	kind: Kind;
	env?: string;
	min?: number;
	max?: number;
}

const SETTINGS: Record<SettingKey, Setting> = {
	enabled: { kind: "boolean", env: "BRAIN_ENABLED" },
	vaultRoot: { kind: "string", env: "BRAIN_VAULT_ROOT" },
	decisionsUrl: { kind: "string", env: "BRAIN_DECISIONS_URL" },
	decisionsPath: { kind: "string", env: "BRAIN_DECISIONS_PATH" },
	apiKey: { kind: "string" }, // env handled by resolveApiKey
	model: { kind: "string", env: "BRAIN_DECISIONS_MODEL" },
	timeoutMs: { kind: "integer", env: "BRAIN_TIMEOUT_MS", min: 0 },
	retries: { kind: "integer", env: "BRAIN_RETRIES", min: 0, max: 5 },
	routeBudgetMs: { kind: "integer", env: "BRAIN_ROUTE_BUDGET_MS", min: 0 },
	maxHops: { kind: "integer", env: "BRAIN_MAX_HOPS", min: 1, max: 16 },
	minConfidence: { kind: "number", env: "BRAIN_MIN_CONFIDENCE", min: 0, max: 1 },
	minActProbability: { kind: "number", env: "BRAIN_MIN_ACT_PROBABILITY", min: 0, max: 1 },
	gateEnabled: { kind: "boolean", env: "BRAIN_GATE_ENABLED" },
	gateThreshold: { kind: "number", env: "BRAIN_GATE_THRESHOLD", min: 0, max: 1 },
	fallbackDocument: { kind: "string", env: "BRAIN_FALLBACK_DOC" },
	maxDocumentChars: { kind: "integer", env: "BRAIN_MAX_DOC_CHARS", min: 0 },
	maxPromptChars: { kind: "integer", env: "BRAIN_MAX_PROMPT_CHARS", min: 1 },
	watchManifests: { kind: "boolean", env: "BRAIN_WATCH_MANIFESTS" },
	displayInjection: { kind: "boolean", env: "BRAIN_DISPLAY_INJECTION" },
	reinjectAfterTurns: { kind: "integer", env: "BRAIN_REINJECT_AFTER_TURNS", min: 0 },
	routeLog: { kind: "string", env: "BRAIN_ROUTE_LOG" },
	useCache: { kind: "boolean", env: "BRAIN_USE_CACHE" },
	compositeEnabled: { kind: "boolean", env: "BRAIN_COMPOSITE_ENABLED" },
	compositeThreshold: { kind: "number", env: "BRAIN_COMPOSITE_THRESHOLD", min: 0, max: 1 },
	compositeMarginRatio: { kind: "number", env: "BRAIN_COMPOSITE_MARGIN_RATIO", min: 0, max: 1 },
	maxCompositeDocuments: { kind: "integer", env: "BRAIN_MAX_COMPOSITE_DOCS", min: 1, max: 5 },
	logLevel: { kind: "logLevel", env: "BRAIN_LOG_LEVEL" },
};

export const DEFAULTS: Omit<BrainConfig, "sources" | "warnings"> = {
	enabled: true,
	vaultRoot: "",
	decisionsUrl: JEV_URL,
	decisionsPath: DEFAULT_DECISIONS_PATH,
	model: DEFAULT_MODEL,
	timeoutMs: 0,
	retries: 1,
	routeBudgetMs: 0,
	maxHops: 4,
	minConfidence: 0.4,
	minActProbability: 0,
	gateEnabled: true,
	gateThreshold: 0.5,
	fallbackDocument: "auto",
	maxDocumentChars: 12000,
	maxPromptChars: 1500,
	watchManifests: true,
	displayInjection: true,
	reinjectAfterTurns: 8,
	routeLog: "auto",
	useCache: true,
	compositeEnabled: true,
	compositeThreshold: 0.25,
	compositeMarginRatio: 0.65,
	maxCompositeDocuments: 2,
	logLevel: "info",
};

/** Keys older versions read that no longer do anything, with what to do instead. */
const RETIRED: Record<string, string> = {
	maxBatch: "it was never enforced",
	warnOnOverfullFolder: "over-full folders are always reported",
};

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

/** Coerce one raw value, or explain why it cannot be used. */
function coerce(key: SettingKey, raw: unknown): { value: unknown } | { problem: string } {
	const setting = SETTINGS[key];
	const text = typeof raw === "string" ? raw.trim() : raw;

	switch (setting.kind) {
		case "boolean": {
			if (typeof text === "boolean") return { value: text };
			const lowered = String(text).toLowerCase();
			if (TRUE.has(lowered)) return { value: true };
			if (FALSE.has(lowered)) return { value: false };
			return { problem: `expected true or false, got ${JSON.stringify(raw)}` };
		}
		case "number":
		case "integer": {
			const value = typeof text === "number" ? text : typeof text === "string" && text !== "" ? Number(text) : NaN;
			if (!Number.isFinite(value)) return { problem: `expected a number, got ${JSON.stringify(raw)}` };
			if (setting.kind === "integer" && !Number.isInteger(value)) {
				return { problem: `expected a whole number, got ${value}` };
			}
			if (setting.min !== undefined && value < setting.min) return { problem: `${value} is below the minimum ${setting.min}` };
			if (setting.max !== undefined && value > setting.max) return { problem: `${value} is above the maximum ${setting.max}` };
			return { value };
		}
		case "logLevel": {
			const lowered = String(text).toLowerCase();
			if ((LOG_LEVELS as readonly string[]).includes(lowered)) return { value: lowered };
			return { problem: `expected one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(raw)}` };
		}
		case "string":
			if (typeof text === "string") return { value: text };
			return { problem: `expected a string, got ${JSON.stringify(raw)}` };
	}
}

export interface LoadOptions {
	/** Directory the project config file and a relative env vaultRoot resolve against. */
	cwd?: string;
	/** Explicit overrides, highest priority of all. Used by the CLIs' flags. */
	overrides?: Partial<Omit<BrainConfig, "sources" | "warnings">>;
	/** Skip the JSON files; used by tests. */
	skipFile?: boolean;
	env?: NodeJS.ProcessEnv;
}

/** Throws only for a config file that is not valid JSON; everything else becomes a warning. */
export function loadConfig(options: LoadOptions = {}): BrainConfig {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const warnings: string[] = [];
	const sources: Record<string, string> = {};
	const values: Record<string, unknown> = { ...DEFAULTS };
	for (const key of Object.keys(DEFAULTS)) sources[key] = "default";

	const apply = (key: SettingKey, raw: unknown, source: string) => {
		const result = coerce(key, raw);
		if ("problem" in result) {
			warnings.push(`${source}: ignored ${key}: ${result.problem}`);
			return;
		}
		values[key] = result.value;
		sources[key] = source;
	};

	if (!options.skipFile) {
		for (const file of readConfigFiles(cwd, env, "brain-traverse", warnings)) {
			for (const [key, raw] of Object.entries(file.values)) {
				if (key.startsWith("_")) continue; // `_comment` and friends
				if (key in SETTINGS) apply(key as SettingKey, raw, file.path);
				else if (key in RETIRED) warnings.push(`${file.path}: '${key}' is no longer used (${RETIRED[key]})`);
				else warnings.push(`${file.path}: unknown setting '${key}' was ignored`);
			}
		}
	}

	for (const [key, setting] of Object.entries(SETTINGS) as [SettingKey, Setting][]) {
		if (!setting.env) continue;
		const raw = env[setting.env];
		if (raw === undefined || raw.trim() === "") continue;
		apply(key, raw, `env ${setting.env}`);
	}

	const envKey = env.BRAIN_DECISIONS_API_KEY?.trim() ? "BRAIN_DECISIONS_API_KEY" : env[TYPESAFE_KEY_ENV]?.trim() ? TYPESAFE_KEY_ENV : "";
	values.apiKey = resolveApiKey(env, typeof values.apiKey === "string" && values.apiKey ? values.apiKey : undefined);
	if (envKey) sources.apiKey = `env ${envKey}`;

	for (const [key, raw] of Object.entries(options.overrides ?? {})) {
		if (raw === undefined) continue;
		if (key in SETTINGS) apply(key as SettingKey, raw, "override");
	}

	const config = { ...(values as Omit<BrainConfig, "sources" | "warnings">), sources, warnings } as BrainConfig;

	config.vaultRoot = config.vaultRoot.trim();
	if (config.vaultRoot) config.vaultRoot = resolveUserPath(config.vaultRoot, cwd);
	if (!config.timeoutMs) {
		// A local forward pass is ~35ms; anything near 500ms means the service is
		// wedged and the agent should proceed without context rather than stall.
		config.timeoutMs = defaultTimeout(config.decisionsUrl);
		sources.timeoutMs = `derived from ${config.decisionsUrl}`;
	}
	if (!config.routeBudgetMs) {
		config.routeBudgetMs = Math.max(defaultRouteBudget(config.decisionsUrl), config.timeoutMs);
		sources.routeBudgetMs = `derived from ${config.decisionsUrl}`;
	}

	return config;
}

export function describeConfig(config: BrainConfig, extra: Record<string, string> = {}): string {
	const source = (key: SettingKey) => {
		const from = config.sources[key];
		return from && from !== "default" ? `   [${from}]` : "";
	};
	const lines = [
		...Object.entries(extra).map(([label, value]) => `${label.padEnd(13)}${value}`),
		`vault        ${config.vaultRoot || "(unset)"}${source("vaultRoot")}`,
		`decisions    ${config.decisionsUrl}${config.decisionsPath} (model ${config.model})${source("decisionsUrl")}`,
		`api key      ${config.apiKey ? "set" : "(none)"}${source("apiKey")}`,
		`timeout      ${config.timeoutMs}ms per request, ${config.routeBudgetMs}ms per route (retries: ${config.retries})${source("timeoutMs")}`,
		`max hops     ${config.maxHops}${source("maxHops")}`,
		`min conf.    ${config.minConfidence}${source("minConfidence")}`,
		`gate         ${config.gateEnabled ? `on (>= ${config.gateThreshold})` : "off"}${source("gateEnabled")}`,
		`fallback     ${config.fallbackDocument === "auto" ? "auto (the note marked fallback: true)" : config.fallbackDocument || "(none)"}${source("fallbackDocument")}`,
		`doc limit    ${config.maxDocumentChars} chars${source("maxDocumentChars")}`,
		`prompt slice ${config.maxPromptChars} chars${source("maxPromptChars")}`,
		`re-inject    ${config.reinjectAfterTurns ? `after ${config.reinjectAfterTurns} turns` : "every turn"}${source("reinjectAfterTurns")}`,
		`route log    ${config.routeLog === "auto" ? "auto" : config.routeLog || "off"}${source("routeLog")}`,
		`log level    ${config.logLevel}${source("logLevel")}`,
	];
	if (config.warnings.length) {
		lines.push("", "Ignored settings:", ...config.warnings.map((warning) => `  ! ${warning}`));
	}
	return lines.join("\n");
}
