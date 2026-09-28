/**
 * A logger the harness can redirect.
 *
 * Inside Pi the extension must not write to stdout - that is the TUI's - so the
 * extension installs a sink that forwards to Pi's notifications instead. The CLI
 * installs one that writes to stderr.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export type LogSink = (level: Exclude<LogLevel, "silent">, message: string) => void;

/** An unknown level must not silence everything: `ORDER[undefined]` would drop even errors. */
function normalise(level: string): LogLevel {
	const lowered = String(level).toLowerCase();
	return lowered in ORDER ? (lowered as LogLevel) : "info";
}

export class Logger {
	private level: LogLevel;

	constructor(
		level: LogLevel = "info",
		private sink: LogSink = (level, message) => {
			process.stderr.write(`[brain-traverse] ${level}: ${message}\n`);
		},
	) {
		this.level = normalise(level);
	}

	get currentLevel(): LogLevel {
		return this.level;
	}

	setLevel(level: LogLevel): void {
		this.level = normalise(level);
	}

	setSink(sink: LogSink): void {
		this.sink = sink;
	}

	private write(level: Exclude<LogLevel, "silent">, message: string): void {
		if (ORDER[this.level] >= ORDER[level]) this.sink(level, message);
	}

	error(message: string): void {
		this.write("error", message);
	}

	warn(message: string): void {
		this.write("warn", message);
	}

	info(message: string): void {
		this.write("info", message);
	}

	debug(message: string): void {
		this.write("debug", message);
	}
}
