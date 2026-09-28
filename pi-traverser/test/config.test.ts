import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { isolatedEnv as isolated, tempDir } from "../../brain-core/test/helpers.js";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
	it("defaults to the hosted Jev API and the vault's own catch-all", () => {
		const config = loadConfig({ skipFile: true, env: {} });
		assert.equal(config.decisionsUrl, "https://api.typesafe.ai");
		assert.equal(config.decisionsPath, "/v1/systemone");
		assert.equal(config.model, "jev-latest");
		assert.equal(config.fallbackDocument, "auto");
	});

	it("derives a tight timeout for a local host and a loose one for a remote", () => {
		assert.equal(loadConfig({ skipFile: true, env: {} }).timeoutMs, 2000);
		assert.equal(
			loadConfig({ skipFile: true, env: { BRAIN_DECISIONS_URL: "http://localhost:8081" } }).timeoutMs,
			500,
		);
	});

	it("takes the API key from TYPESAFE_API_KEY unless BRAIN_DECISIONS_API_KEY is set", () => {
		assert.equal(loadConfig({ skipFile: true, env: { TYPESAFE_API_KEY: "ts" } }).apiKey, "ts");
		assert.equal(
			loadConfig({ skipFile: true, env: { TYPESAFE_API_KEY: "ts", BRAIN_DECISIONS_API_KEY: "brain" } }).apiKey,
			"brain",
		);
		assert.equal(loadConfig({ skipFile: true, env: {} }).apiKey, undefined);
	});

	it("keeps an explicit timeout", () => {
		assert.equal(loadConfig({ skipFile: true, env: { BRAIN_TIMEOUT_MS: "120" } }).timeoutMs, 120);
	});

	it("coerces booleans and numbers from the environment", () => {
		const config = loadConfig({
			skipFile: true,
			env: { BRAIN_GATE_ENABLED: "false", BRAIN_MIN_CONFIDENCE: "0.7", BRAIN_MAX_HOPS: "2" },
		});
		assert.equal(config.gateEnabled, false);
		assert.equal(config.minConfidence, 0.7);
		assert.equal(config.maxHops, 2);
	});

	it("ignores a non-numeric value rather than producing NaN", () => {
		assert.equal(loadConfig({ skipFile: true, env: { BRAIN_MAX_HOPS: "lots" } }).maxHops, 4);
	});

	it("layers file, then env, then overrides", () => {
		const cwd = tempDir("brain-config-");
		writeFileSync(
			join(cwd, "brain-traverse.config.json"),
			JSON.stringify({ maxHops: 7, minConfidence: 0.1, fallbackDocument: "from-file.md" }),
			"utf8",
		);

		const config = loadConfig({
			cwd,
			env: isolated({ BRAIN_MIN_CONFIDENCE: "0.5" }),
			overrides: { maxHops: 9 },
		});

		assert.equal(config.fallbackDocument, "from-file.md", "file value survives");
		assert.equal(config.minConfidence, 0.5, "env beats file");
		assert.equal(config.maxHops, 9, "override beats both");
	});

	it("resolves a relative vault root against the cwd", () => {
		const cwd = tempDir("brain-config-");
		const config = loadConfig({ cwd, skipFile: true, env: { BRAIN_VAULT_ROOT: "vault" } });
		assert.ok(isAbsolute(config.vaultRoot));
		assert.ok(config.vaultRoot.endsWith("vault"));
	});

	it("reads the user config, and lets a project file override it", () => {
		const env = isolated();
		const userDir = join(env.XDG_CONFIG_HOME, "brain-traverse");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(join(userDir, "config.json"), JSON.stringify({ vaultRoot: "brain", maxHops: 3, minConfidence: 0.2 }));

		const cwd = tempDir("brain-config-");
		assert.equal(loadConfig({ cwd, env }).maxHops, 3, "user file applies");
		assert.equal(
			loadConfig({ cwd, env }).vaultRoot,
			resolve(userDir, "brain"),
			"a relative vaultRoot resolves against the file that set it, not the cwd",
		);

		writeFileSync(join(cwd, "brain-traverse.config.json"), JSON.stringify({ maxHops: 6 }));
		const layered = loadConfig({ cwd, env });
		assert.equal(layered.maxHops, 6, "project file beats user file");
		assert.equal(layered.minConfidence, 0.2, "user values the project file does not set survive");
	});

	it("expands ~ in the vault root", () => {
		const config = loadConfig({ skipFile: true, env: { BRAIN_VAULT_ROOT: "~/brain" } });
		assert.ok(isAbsolute(config.vaultRoot));
		assert.ok(!config.vaultRoot.includes("~"));
	});

	it("explains itself when the config file is not valid JSON", () => {
		const cwd = tempDir("brain-config-");
		writeFileSync(join(cwd, "brain-traverse.config.json"), "{ nope", "utf8");
		assert.throws(() => loadConfig({ cwd, env: isolated() }), /could not parse/);
	});
});
