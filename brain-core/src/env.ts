/**
 * Configuration plumbing shared by both packages' config loaders.
 *
 * Both read the same `BRAIN_*` variables and the same JSON files for the vault
 * and the decisions API; only the extra keys differ, so the defaults, the file
 * discovery and the coercion rules live here and the packages layer their own
 * keys on top.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Decisions API defaults
// ---------------------------------------------------------------------------

/** The hosted TypeSafe Jev API. The default backend: nothing to install, just a key. */
export const JEV_URL = "https://api.typesafe.ai";
/** Jev's evaluation endpoint. */
export const DEFAULT_DECISIONS_PATH = "/v1/systemone";
/** Sent with every request; Jev requires it. */
export const DEFAULT_MODEL = "jev-latest";
/** Read when `BRAIN_DECISIONS_API_KEY` is unset - the name TypeSafe's own docs use. */
export const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";

/**
 * Claude Code plugin options (`userConfig` in .claude-plugin/plugin.json) and
 * the `BRAIN_*` variable each one stands in for. Claude Code exports option KEY
 * to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`, and the plugin's MCP server entry
 * passes the same names, so both processes see the options the same way.
 */
export const PLUGIN_OPTIONS: Readonly<Record<string, string>> = {
	CLAUDE_PLUGIN_OPTION_VAULT_ROOT: "BRAIN_VAULT_ROOT",
	CLAUDE_PLUGIN_OPTION_API_KEY: "BRAIN_DECISIONS_API_KEY",
	CLAUDE_PLUGIN_OPTION_DECISIONS_URL: "BRAIN_DECISIONS_URL",
};

/**
 * Copy each non-empty plugin option onto its `BRAIN_*` variable, unless that
 * variable is already set. Options that were left empty in the plugin dialog
 * change nothing, so the config files and the user's own environment still
 * apply. Mutates and returns `env`; outside Claude Code it is a no-op.
 */
export function applyPluginOptions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	for (const [option, target] of Object.entries(PLUGIN_OPTIONS)) {
		const value = env[option]?.trim();
		// An unsubstituted `${user_config.x}` means the option was never set.
		if (!value || value.startsWith("${")) continue;
		if (!env[target]?.trim()) env[target] = value;
	}
	return env;
}

/** The key from `BRAIN_DECISIONS_API_KEY`, else `TYPESAFE_API_KEY`, else the file value. */
export function resolveApiKey(env: NodeJS.ProcessEnv, fromFile?: string): string | undefined {
	return envString(env, "BRAIN_DECISIONS_API_KEY", "") || envString(env, TYPESAFE_KEY_ENV, "") || fromFile || undefined;
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

export const PROJECT_CONFIG_FILE = "brain-traverse.config.json";

/**
 * Keys `./brain-traverse.config.json` may not set. That file arrives with any
 * repository you clone, so it must not send your API key and prompts to its
 * own server, or point the route log at a file of its choosing.
 */
const USER_ONLY_KEYS = ["decisionsUrl", "decisionsPath", "apiKey", "routeLog"];

/**
 * The per-user config, shared by every harness and every project:
 * `$XDG_CONFIG_HOME/brain-traverse/config.json`, else `~/.config/brain-traverse/config.json`.
 *
 * It exists because an installed Pi package runs from wherever Pi was started,
 * so a project-local file alone would mean one copy per repository.
 */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	return join(base, "brain-traverse", "config.json");
}

/** `~/x` -> `<home>/x`; a relative path resolves against `base`. */
export function resolveUserPath(path: string, base: string): string {
	if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(1));
	}
	return resolve(base, path);
}

export interface ConfigFile {
	path: string;
	values: Record<string, unknown>;
}

/**
 * The JSON config files that apply, lowest priority first: the user file, then
 * `$BRAIN_CONFIG` or, failing that, `./brain-traverse.config.json` in `cwd`.
 *
 * A relative `vaultRoot` in a file resolves against that file's directory, so
 * the same file means the same vault whichever directory the agent starts in.
 * `warnings` collects anything worth telling the user that is not fatal, such
 * as a `$BRAIN_CONFIG` that points at nothing.
 */
export function readConfigFiles(cwd: string, env: NodeJS.ProcessEnv, label: string, warnings: string[] = []): ConfigFile[] {
	const explicit = env.BRAIN_CONFIG?.trim();
	const candidates = [userConfigPath(env), explicit ? resolve(cwd, explicit) : resolve(cwd, PROJECT_CONFIG_FILE)];
	if (explicit && !existsSync(candidates[1])) {
		warnings.push(`BRAIN_CONFIG points at ${candidates[1]}, which does not exist`);
	}

	const files: ConfigFile[] = [];
	for (const path of new Set(candidates)) {
		if (!existsSync(path)) continue;
		let values: unknown;
		try {
			values = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new Error(`${label}: could not parse ${path}: ${(error as Error).message}`);
		}
		if (typeof values !== "object" || values === null || Array.isArray(values)) {
			throw new Error(`${label}: ${path} must contain a JSON object of settings`);
		}
		const record = values as Record<string, unknown>;
		if (!explicit && path !== candidates[0]) {
			for (const key of USER_ONLY_KEYS.filter((key) => key in record)) {
				delete record[key];
				warnings.push(`${path}: ignored ${key}: a project file may not set it; use ${candidates[0]} or a BRAIN_* variable`);
			}
		}
		if (typeof record.vaultRoot === "string" && record.vaultRoot.trim()) {
			record.vaultRoot = resolveUserPath(record.vaultRoot.trim(), dirname(path));
		}
		files.push({ path, values: record });
	}
	return files;
}

// ---------------------------------------------------------------------------
// Environment coercion
// ---------------------------------------------------------------------------

export function envString(
	env: NodeJS.ProcessEnv,
	key: string,
	fallback: string,
): string {
	const value = env[key];
	return value === undefined || value.trim() === "" ? fallback : value.trim();
}

/** Per-request timeout: past this the agent proceeds without a guide rather than stall. */
export const DEFAULT_TIMEOUT_MS = 2000;
/** Budget for a whole route, every hop and retry included. */
export const DEFAULT_ROUTE_BUDGET_MS = 3000;
