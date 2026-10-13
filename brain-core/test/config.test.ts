/**
 * The shared loader: precedence, validation, and the local-network detection
 * that picks the default timeouts.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { describeConfig, loadConfig } from "../src/config.js";
import { applyPluginOptions } from "../src/env.js";
import { Logger } from "../src/logger.js";
import { isolatedEnv, tempDir } from "./helpers.js";

function withFile(values: unknown): { cwd: string; env: Record<string, string> } {
	const cwd = tempDir("brain-config-");
	writeFileSync(join(cwd, "brain-traverse.config.json"), JSON.stringify(values), "utf8");
	return { cwd, env: isolatedEnv() };
}

describe("validation", () => {
	it("coerces strings a human would write for booleans and numbers", () => {
		const config = loadConfig(withFile({ gateEnabled: "false", minConfidence: "0.6", maxHops: 3 }));
		assert.equal(config.gateEnabled, false, "the string \"false\" is not truthy here");
		assert.equal(config.minConfidence, 0.6);
		assert.equal(config.maxHops, 3);
		assert.deepEqual(config.warnings, []);
	});

	it("keeps the default and says why when a value is unusable", () => {
		const config = loadConfig(withFile({ minConfidence: 7, maxHops: 2.5, gateEnabled: "sometimes", logLevel: "verbose" }));
		assert.equal(config.minConfidence, 0.4);
		assert.equal(config.maxHops, 4);
		assert.equal(config.gateEnabled, true);
		assert.equal(config.logLevel, "info");
		assert.equal(config.warnings.length, 4);
		assert.match(config.warnings.join("\n"), /minConfidence: 7 is above the maximum 1/);
		assert.match(config.warnings.join("\n"), /logLevel: expected one of silent, error, warn, info, debug/);
	});

	it("warns about a misspelled key, and about retired ones", () => {
		const config = loadConfig(withFile({ minConfidance: 0.5, maxBatch: 10, _comment: "ignored quietly" }));
		assert.match(config.warnings[0], /unknown setting 'minConfidance'/);
		assert.match(config.warnings[1], /'maxBatch' is no longer used/);
		assert.equal(config.warnings.length, 2);
	});

	it("treats whitespace-only environment values as unset", () => {
		const config = loadConfig({ skipFile: true, env: { BRAIN_VAULT_ROOT: "  ", BRAIN_MAX_HOPS: " " } });
		assert.equal(config.vaultRoot, "");
		assert.equal(config.maxHops, 4);
	});

	it("reports an invalid environment value rather than producing NaN", () => {
		const config = loadConfig({ skipFile: true, env: { BRAIN_MAX_HOPS: "lots", BRAIN_LOG_LEVEL: "LOUD" } });
		assert.equal(config.maxHops, 4);
		assert.equal(config.logLevel, "info");
		assert.match(config.warnings.join("\n"), /env BRAIN_MAX_HOPS: ignored maxHops/);
	});

	it("rejects a config file that is not a JSON object", () => {
		assert.throws(() => loadConfig(withFile([1, 2])), /must contain a JSON object/);
		assert.throws(() => loadConfig(withFile(null)), /must contain a JSON object/);
	});

	it("warns when $BRAIN_CONFIG points at nothing", () => {
		const env = isolatedEnv({ BRAIN_CONFIG: "missing.json" });
		const config = loadConfig({ cwd: tempDir(), env });
		assert.match(config.warnings[0], /BRAIN_CONFIG points at .*missing\.json/);
	});
});

describe("sources", () => {
	it("records where each setting came from", () => {
		const { cwd, env } = withFile({ maxHops: 3 });
		const userDir = join(env.XDG_CONFIG_HOME, "brain-traverse");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(join(userDir, "config.json"), JSON.stringify({ minConfidence: 0.3 }));

		const config = loadConfig({ cwd, env: { ...env, BRAIN_GATE_THRESHOLD: "0.7" }, overrides: { retries: 0 } });
		assert.match(config.sources.maxHops, /brain-traverse\.config\.json$/);
		assert.match(config.sources.minConfidence, /config\.json$/);
		assert.equal(config.sources.gateThreshold, "env BRAIN_GATE_THRESHOLD");
		assert.equal(config.sources.retries, "override");
		assert.equal(config.sources.model, "default");

		const described = describeConfig(config);
		assert.match(described, /max hops {5}3 {3}\[.*brain-traverse\.config\.json\]/);
	});

	it("defaults the per-request timeout and the route budget", () => {
		const config = loadConfig({ skipFile: true, env: {} });
		assert.equal(config.timeoutMs, 2000);
		assert.equal(config.routeBudgetMs, 3000);
	});
});

describe("applyPluginOptions", () => {
	it("maps Claude Code plugin options onto the BRAIN_* variables", () => {
		const env = applyPluginOptions({
			CLAUDE_PLUGIN_OPTION_VAULT_ROOT: "/vaults/brain",
			CLAUDE_PLUGIN_OPTION_API_KEY: "sk-plugin",
			CLAUDE_PLUGIN_OPTION_DECISIONS_URL: "http://my-server:8081",
		});
		assert.equal(env.BRAIN_VAULT_ROOT, "/vaults/brain");
		assert.equal(env.BRAIN_DECISIONS_API_KEY, "sk-plugin");
		assert.equal(env.BRAIN_DECISIONS_URL, "http://my-server:8081");
	});

	it("leaves a BRAIN_* variable the user set alone", () => {
		const env = applyPluginOptions({ BRAIN_VAULT_ROOT: "/mine", CLAUDE_PLUGIN_OPTION_VAULT_ROOT: "/plugin" });
		assert.equal(env.BRAIN_VAULT_ROOT, "/mine");
	});

	it("ignores options that are empty or were never substituted", () => {
		const env = applyPluginOptions({
			CLAUDE_PLUGIN_OPTION_VAULT_ROOT: "  ",
			CLAUDE_PLUGIN_OPTION_API_KEY: "${user_config.api_key}",
		});
		assert.equal(env.BRAIN_VAULT_ROOT, undefined);
		assert.equal(env.BRAIN_DECISIONS_API_KEY, undefined);
	});

	it("feeds the plugin's vault into the config loader", () => {
		const config = loadConfig({ skipFile: true, env: applyPluginOptions({ CLAUDE_PLUGIN_OPTION_VAULT_ROOT: tempDir() }) });
		assert.ok(config.vaultRoot);
		assert.equal(config.sources.vaultRoot, "env BRAIN_VAULT_ROOT");
	});
});

describe("Logger", () => {
	it("falls back to info for an unknown level instead of going silent", () => {
		const seen: string[] = [];
		const logger = new Logger("verbose" as never, (level, message) => seen.push(`${level}:${message}`));
		logger.error("boom");
		logger.debug("chatter");
		assert.deepEqual(seen, ["error:boom"]);
	});
});
