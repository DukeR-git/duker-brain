/**
 * The Pi extension (../pi.ts) and `brain-keeper init`: the two pieces that make
 * the brain installable without touching MCP configuration. The extension takes
 * its environment as an option, so nothing here touches `process.env`.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { fixtureCopy, isolatedEnv, tempDir } from "../../brain-core/test/helpers.js";
import brainKeeper from "../pi.js";
import { initVault, renderInit } from "../src/init.js";
import { TOOLS } from "../src/tools.js";

interface RegisteredTool {
	name: string;
	label: string;
	parameters: Record<string, unknown>;
	execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
}

type CommandHandler = (args: string, ctx: { ui: { notify(text: string, level?: string): void } }) => void;

function register(env: Record<string, string>) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, CommandHandler>();
	brainKeeper(
		{
			registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
			registerCommand: (name: string, spec: { handler: CommandHandler }) => commands.set(name, spec.handler),
		} as never,
		{ env },
	);
	return { tools, commands };
}

describe("the Pi extension", () => {
	it("registers every tool with a plain JSON Schema object", () => {
		const { tools } = register(isolatedEnv());
		assert.deepEqual([...tools.keys()], TOOLS.map((tool) => tool.name));

		for (const tool of tools.values()) {
			assert.equal(tool.parameters.type, "object", `${tool.name} parameters`);
			assert.equal("$schema" in tool.parameters, false, `${tool.name} has no $schema key`);
			assert.match(tool.label, /^Brain: /);
		}

		const add = tools.get("brain_add_note")!.parameters as { required?: string[]; properties: object };
		assert.ok(add.required?.includes("title"), "required fields survive the conversion");
	});

	it("runs a tool against the configured vault", async () => {
		const root = fixtureCopy("brain-pi-");
		const { tools } = register(isolatedEnv({ BRAIN_VAULT_ROOT: root }));
		const result = await tools.get("brain_tree")!.execute("call-1", {});
		assert.match(result.content[0].text, /asyncpg_pooling/);
	});

	it("throws on a tool error, which is how Pi reports failure to the model", async () => {
		const { tools } = register(isolatedEnv());
		await assert.rejects(tools.get("brain_doctor")!.execute("call-1", {}), /No vault configured/);
	});

	it("picks up a vault configured after it started", async () => {
		const env = isolatedEnv();
		const { tools } = register(env);
		await assert.rejects(tools.get("brain_tree")!.execute("call-1", {}), /No vault configured/);

		// e.g. `brain-keeper init` run in another terminal mid-session
		initVault({ dir: fixtureCopy("brain-pi-"), env, saveConfig: true });
		const result = await tools.get("brain_tree")!.execute("call-2", {});
		assert.match(result.content[0].text, /asyncpg_pooling/);
	});
});

describe("/brain-init", () => {
	it("creates the vault from inside Pi and tells the user to reload", () => {
		const env = isolatedEnv();
		const { commands } = register(env);
		const dir = join(tempDir("brain-init-"), "brain");
		const notes: string[] = [];
		const ui = { notify: (text: string) => notes.push(text) };

		commands.get("brain-init")!("", { ui });
		assert.match(notes.at(-1)!, /usage/);

		commands.get("brain-init")!(`${dir} --example`, { ui });
		assert.match(notes.at(-1)!, /\/reload/);
		assert.ok(existsSync(join(dir, "Backend", "_index.json")));
		assert.equal(JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME, "brain-traverse", "config.json"), "utf8")).vaultRoot, dir);
	});

	it("previews with --dry-run and writes nothing", () => {
		const { commands } = register(isolatedEnv());
		const dir = join(tempDir("brain-init-"), "brain");
		const notes: string[] = [];
		commands.get("brain-init")!(`${dir} --example --dry-run`, { ui: { notify: (text: string) => notes.push(text) } });
		assert.match(notes.at(-1)!, /Dry run: nothing was written/);
		assert.ok(!existsSync(dir));
	});
});

describe("brain-keeper init", () => {
	it("creates a routable vault and records it in the user config", () => {
		const env = isolatedEnv();
		const dir = join(tempDir("brain-init-"), "brain");
		const result = initVault({ dir, env });

		assert.ok(existsSync(join(dir, "general_instructions.md")));
		assert.ok(existsSync(join(dir, ".brainignore")), "with an ignore file to fill in");
		const manifest = JSON.parse(readFileSync(join(dir, "_index.json"), "utf8"));
		assert.equal(manifest[0].fallback, true);

		const saved = JSON.parse(readFileSync(result.configPath!, "utf8"));
		assert.equal(saved.vaultRoot, dir);
	});

	it("never overwrites an existing note, and keeps other config keys", () => {
		const env = isolatedEnv();
		const dir = tempDir("brain-init-");
		writeFileSync(join(dir, "general_instructions.md"), "---\nid: general_instructions\ntitle: Mine\ncriteria: my own catch-all note for every request\nfallback: true\n---\n\nmine\n");

		const first = initVault({ dir, env });
		assert.deepEqual(first.created, [".brainignore"]);
		writeFileSync(first.configPath!, JSON.stringify({ vaultRoot: "elsewhere", minConfidence: 0.6 }));

		const result = initVault({ dir, env });
		assert.deepEqual(result.created, []);
		assert.match(readFileSync(join(dir, "general_instructions.md"), "utf8"), /mine/);
		assert.match(renderInit(result), /created {3}nothing \(existing files kept\)/);

		const saved = JSON.parse(readFileSync(result.configPath!, "utf8"));
		assert.equal(saved.vaultRoot, dir);
		assert.equal(saved.minConfidence, 0.6);
	});

	it("lists exactly the example files it copied", () => {
		const dir = tempDir("brain-init-");
		const result = initVault({ dir, example: true, saveConfig: false, env: isolatedEnv() });

		assert.equal(result.configPath, undefined);
		assert.equal(result.compiled.counts.leaves, 9);
		assert.equal(result.compiled.issues.filter((issue) => issue.severity === "error").length, 0);
		assert.ok(result.created.includes("Backend/asyncpg_pooling.md"));
		assert.ok(!result.created.some((path) => path.endsWith("_index.json")), "manifests are compiled, not copied");

		const again = initVault({ dir, example: true, saveConfig: false, env: isolatedEnv() });
		assert.deepEqual(again.created, [], "nothing new the second time");
	});
});
