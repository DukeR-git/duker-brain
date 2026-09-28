/**
 * Plumbing shared by the two command-line tools.
 */

export interface Args {
	command: string;
	positional: string[];
	flags: Record<string, string | boolean>;
}

/**
 * Parse `argv` into a command, positionals and flags. Accepts `--name value`,
 * `--name=value` and short `-n value`; `valueFlags` names the flags that take
 * a value (without dashes), and `aliases` maps short names to long ones.
 * `--` ends flag parsing, so a prompt may start with a dash.
 */
export function parseArgs(
	argv: string[],
	valueFlags: ReadonlySet<string>,
	aliases: Record<string, string> = {},
): Args {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--") {
			positional.push(...argv.slice(index + 1));
			break;
		}
		if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
			positional.push(token);
			continue;
		}

		const body = token.replace(/^--?/, "");
		const equals = body.indexOf("=");
		const rawName = equals === -1 ? body : body.slice(0, equals);
		const name = aliases[rawName] ?? rawName;

		if (equals !== -1) {
			flags[name] = body.slice(equals + 1);
		} else if (valueFlags.has(name)) {
			flags[name] = argv[++index] ?? "";
		} else {
			flags[name] = true;
		}
	}

	return { command: positional.shift() ?? "", positional, flags };
}

/** A flag that must be a number in range, or an explanation of why it is not. */
export function numberFlag(
	flags: Args["flags"],
	name: string,
	options: { min?: number; max?: number; integer?: boolean } = {},
): { value?: number; error?: string } {
	const raw = flags[name];
	if (raw === undefined) return {};
	const value = typeof raw === "string" ? Number(raw) : NaN;
	const kind = options.integer ? "a whole number" : "a number";
	if (!Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
		return { error: `--${name} needs ${kind}, got ${JSON.stringify(raw === true ? "" : raw)}` };
	}
	if (options.min !== undefined && value < options.min) return { error: `--${name} must be at least ${options.min}` };
	if (options.max !== undefined && value > options.max) return { error: `--${name} must be at most ${options.max}` };
	return { value };
}

/**
 * Release the sockets Node's global fetch keeps alive, then let the event loop
 * drain on its own. Calling `process.exit()` on top of a live keep-alive handle
 * trips a libuv assertion on Windows: the command prints its result correctly
 * and then dies with 0xC0000409 instead of 0.
 *
 * Node exposes its global dispatcher only through undici's well-known symbol,
 * which is internal; if it ever moves, this quietly does nothing.
 */
export async function shutdownHttp(): Promise<void> {
	const dispatcher = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] as
		| { close?: () => Promise<void>; destroy?: () => Promise<void> }
		| undefined;

	try {
		if (typeof dispatcher?.close === "function") await dispatcher.close();
		else if (typeof dispatcher?.destroy === "function") await dispatcher.destroy();
	} catch {
		/* best effort: a slow exit beats a crash on the way out */
	}
}

/** Run a CLI's `main`, set the exit code, and shut down cleanly on success or failure. */
export function runMain(name: string, main: () => Promise<number>, showStack = false): void {
	main().then(
		async (code) => {
			process.exitCode = code;
			await shutdownHttp();
		},
		async (error) => {
			const err = error as Error;
			process.stderr.write(`${name}: ${showStack ? (err.stack ?? err.message) : err.message}\n`);
			process.exitCode = 1;
			await shutdownHttp();
		},
	);
}
