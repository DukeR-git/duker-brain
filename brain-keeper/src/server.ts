/**
 * The MCP stdio server.
 *
 * MCP is what makes one implementation serve Pi, Claude Code and Codex: each
 * speaks it, so the tools in ./tools.ts are defined once and every harness sees
 * the same brain.
 *
 * Nothing may write to stdout except the JSON-RPC stream — a stray console.log
 * corrupts the protocol and the harness silently loses the server. All
 * diagnostics go to stderr.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { LazyConfig, type KeeperConfig } from "./config.js";
import { TOOLS, annotationsFor, runTool } from "./tools.js";

/**
 * The nearest package.json above this file: brain-keeper's own from source, the
 * repository root's from a bundle in dist/ (as the Claude Code plugin runs it).
 */
const VERSION = (() => {
	for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			return String(pkg.version ?? "0.0.0");
		} catch {
			if (dirname(dir) === dir) return "0.0.0";
		}
	}
})();

export function createServer(config = new LazyConfig()): McpServer {
	const server = new McpServer({
		name: "brain-keeper",
		version: VERSION,
	});

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.schema, annotations: annotationsFor(tool) },
			async (input: unknown) => {
				let result;
				try {
					result = await runTool(tool, config.get(), input);
				} catch (error) {
					result = { text: `${tool.name} failed: ${(error as Error).message}`, isError: true };
				}
				return {
					content: [{ type: "text" as const, text: result.text }],
					...(result.isError ? { isError: true } : {}),
				};
			},
		);
	}

	return server;
}

export async function main(): Promise<void> {
	const config = new LazyConfig();
	let vault = "(unset)";
	try {
		const loaded = config.get();
		vault = loaded.vaultRoot || "(unset)";
		for (const warning of loaded.warnings) process.stderr.write(`brain-keeper: warning: ${warning}\n`);
	} catch (error) {
		// Start anyway: every tool call will report the problem to the model,
		// which is far more visible than a server that silently failed to launch.
		process.stderr.write(`brain-keeper: ${(error as Error).message}\n`);
	}

	process.stderr.write(`brain-keeper ${VERSION}: ${TOOLS.length} tools on stdio; vault=${vault}\n`);
	if (vault === "(unset)") {
		process.stderr.write("brain-keeper: no vault configured yet; tools will say how to set one up.\n");
	}

	await createServer(config).connect(new StdioServerTransport());
}
