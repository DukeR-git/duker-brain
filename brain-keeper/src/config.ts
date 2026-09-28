/**
 * Configuration for the keeper.
 *
 * The keeper reads the very same settings as the router — one loader in
 * brain-core, the same files and `BRAIN_*` variables — because
 * `brain_check_routing` has to predict what the router will do, and a
 * prediction built from different thresholds is wrong exactly when someone has
 * tuned them. Only `vaultRoot` is required for the writing tools.
 */

import { existsSync, statSync } from "node:fs";

import { loadConfig as loadBrainConfig, type BrainConfig, type LoadOptions } from "../../brain-core/src/config.js";

export type KeeperConfig = BrainConfig;
export type { LoadOptions };

export function loadConfig(options: LoadOptions = {}): KeeperConfig {
	return loadBrainConfig(options);
}

export class ConfigError extends Error {}

/** Most tools are useless without a vault; fail with something actionable. */
export function requireVault(config: KeeperConfig): string {
	if (!config.vaultRoot) {
		throw new ConfigError(
			"No vault configured. Run `brain-keeper init <dir>` to create one, set BRAIN_VAULT_ROOT, " +
				"or add \"vaultRoot\" to ~/.config/brain-traverse/config.json.",
		);
	}
	if (!existsSync(config.vaultRoot) || !statSync(config.vaultRoot).isDirectory()) {
		throw new ConfigError(`Vault root does not exist or is not a folder: ${config.vaultRoot}`);
	}
	return config.vaultRoot;
}

/**
 * Config, loaded on first use and again while it is unusable.
 *
 * An MCP server is long-lived: if `brain-keeper init` runs after the harness
 * started it, or a broken config file is fixed, the next tool call should see
 * that without restarting the server. A good config is kept, so behaviour does
 * not shift under a session because a file changed mid-way.
 */
export class LazyConfig {
	private config: KeeperConfig | undefined;

	constructor(private readonly load: () => KeeperConfig = () => loadConfig()) {}

	get(): KeeperConfig {
		if (this.config?.vaultRoot) return this.config;
		this.config = this.load(); // throws for a config file that is not valid JSON
		return this.config;
	}
}
