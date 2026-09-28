/**
 * brain-hook: the Claude Code plugin's hook command.
 *
 *   brain-hook prompt          UserPromptSubmit: hook JSON on stdin, context JSON on stdout
 *   brain-hook session-start   SessionStart: resets the session after /clear or a compaction
 *   brain-hook status          What the hook last saw, for /duker-brain:status
 *        [--data <dir>]        the plugin's data directory (default: $CLAUDE_PLUGIN_DATA)
 *
 * The plugin runs the bundled copy, dist/brain-hook.mjs, so it needs nothing
 * installed. Every path exits 0: a hook that fails or runs long must never
 * block or delay the user's prompt, only go without a guide.
 */

import { parseArgs, runMain, shutdownHttp } from "../../brain-core/src/cli.js";
import { renderStatus, runPromptHook, runSessionStartHook, type HookInput, type HookOutput } from "../src/claude-hook.js";

/** Below the plugin's 10 s hook timeout, so Claude Code never has to cancel the hook. */
const DEADLINE_MS = 8_000;

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

function parseInput(raw: string): HookInput {
	try {
		const value = JSON.parse(raw) as unknown;
		return value && typeof value === "object" ? (value as HookInput) : {};
	} catch {
		return {};
	}
}

function emit(output: HookOutput | undefined): void {
	if (output) process.stdout.write(JSON.stringify(output));
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2), new Set(["data"]));
	const dataDir = typeof args.flags.data === "string" ? args.flags.data : undefined;

	switch (args.command) {
		case "prompt": {
			// Close keep-alive sockets before exiting: process.exit() over a live one
			// crashes Node on Windows, which Claude Code would report as a hook error.
			setTimeout(() => void shutdownHttp().finally(() => process.exit(0)), DEADLINE_MS).unref();
			try {
				emit(await runPromptHook(parseInput(await readStdin()), { dataDir }));
			} catch (error) {
				process.stderr.write(`[brain-traverse] hook failed: ${(error as Error).message}\n`);
			}
			return 0;
		}
		case "session-start": {
			try {
				emit(runSessionStartHook(parseInput(await readStdin()), { dataDir }));
			} catch (error) {
				process.stderr.write(`[brain-traverse] hook failed: ${(error as Error).message}\n`);
			}
			return 0;
		}
		case "status":
			process.stdout.write(renderStatus({ dataDir }) + "\n");
			return 0;
		default:
			process.stderr.write("usage: brain-hook prompt | session-start | status [--data <dir>]\n");
			return 2;
	}
}

runMain("brain-hook", main);
