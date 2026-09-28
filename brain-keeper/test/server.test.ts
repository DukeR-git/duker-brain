/**
 * The MCP server and the CLI, run as real processes. The server is spoken to in
 * raw JSON-RPC over stdio, the way a harness does.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fixtureCopy, isolatedEnv, tempDir } from "../../brain-core/test/helpers.js";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "bin", "brain-keeper.mjs");

function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.BRAIN_CONFIG;
	delete env.BRAIN_VAULT_ROOT;
	return { ...env, ...isolatedEnv(extra) };
}

/** Start `serve`, send JSON-RPC requests, and collect the responses by id. */
async function rpc(env: NodeJS.ProcessEnv, requests: object[], cwd?: string): Promise<Map<number, any>> {
	const child = spawn(process.execPath, [CLI, "serve"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
	const responses = new Map<number, any>();
	const wanted = requests.filter((request) => "id" in request).length;
	let buffer = "";

	await new Promise<void>((done, fail) => {
		const timer = setTimeout(() => fail(new Error(`timed out; got ${responses.size} of ${wanted}`)), 30_000);
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let newline;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const message = JSON.parse(line);
				if (message.id !== undefined) responses.set(message.id, message);
				if (responses.size === wanted) {
					clearTimeout(timer);
					done();
				}
			}
		});
		child.on("error", fail);
		for (const request of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n");
	});

	child.kill();
	return responses;
}

const INIT = [
	{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
	{ method: "notifications/initialized" },
];

describe("brain-keeper serve", () => {
	it("lists every tool with read/write annotations", async () => {
		const responses = await rpc(environment({ BRAIN_VAULT_ROOT: fixtureCopy() }), [...INIT, { id: 2, method: "tools/list" }]);
		const tools = responses.get(2).result.tools as { name: string; annotations: Record<string, boolean> }[];
		assert.equal(tools.length, 17);
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		assert.equal(byName.get("brain_tree")!.annotations.readOnlyHint, true);
		assert.equal(byName.get("brain_remove_note")!.annotations.destructiveHint, true);
		assert.equal(byName.get("brain_eval")!.annotations.readOnlyHint, true);
		assert.equal(byName.get("brain_export")!.annotations.readOnlyHint, false);
	});

	it("starts with a broken config file and reports it on every call", async () => {
		const cwd = tempDir("brain-serve-");
		writeFileSync(join(cwd, "brain-traverse.config.json"), "{ nope");
		const responses = await rpc(
			environment(),
			[...INIT, { id: 2, method: "tools/call", params: { name: "brain_tree", arguments: {} } }],
			cwd,
		);
		const result = responses.get(2).result;
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /could not parse/);
	});
});

describe("brain-keeper CLI", () => {
	function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
		return new Promise((done) => {
			execFile(process.execPath, [CLI, ...args], { env, timeout: 60_000 }, (error, stdout, stderr) => {
				done({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
			});
		});
	}

	it("searches, and validates numeric flags", async () => {
		const env = environment({ BRAIN_VAULT_ROOT: fixtureCopy() });
		const search = await run(["search", "pgbouncer", "--limit=3"], env);
		assert.equal(search.code, 0, search.stderr);
		assert.match(search.stdout, /Backend\/asyncpg_pooling\.md/);

		const tree = await run(["tree", "--depth", "zero"], env);
		assert.equal(tree.code, 2);
		assert.match(tree.stderr, /--depth needs a whole number/);
	});

	it("prints setup commands that pass the API key to the server", async () => {
		const setup = await run(["setup"], environment());
		assert.match(setup.stdout, /claude mcp add brain --scope user -e TYPESAFE_API_KEY=/);
	});
});
