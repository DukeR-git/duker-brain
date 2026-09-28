/**
 * Standalone CLI for the traverser.
 *
 * Exists so the tree can be exercised without launching Pi - which is what you
 * want when a prompt routes to the wrong leaf and you are rewriting criteria
 * text, or when you want to know whether a bad answer was the router's fault or
 * the model's.
 *
 *   brain-traverse route "how do I pool asyncpg connections?"
 *   brain-traverse lint
 *   brain-traverse health
 *   brain-traverse bench -n 30
 *   brain-traverse stats
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { numberFlag, parseArgs, runMain, type Args } from "../../brain-core/src/cli.js";
import { isLocalUrl } from "../../brain-core/src/env.js";
import { Logger } from "../../brain-core/src/logger.js";
import {
	MANIFEST_FILE,
	MAX_CHILDREN,
	ManifestError,
	ManifestStore,
	manifestWarnings,
} from "../../brain-core/src/manifest.js";
import { readRouteLog, renderRouteStats, resolveRouteLogPath } from "../../brain-core/src/routelog.js";
import {
	compileVault,
	defaultRouteCache,
	loadEvalSuite,
	loadIgnore,
	relativeToVault,
	renderEvalReport,
	runEvalSuite,
	scanVault,
} from "../../brain-core/src/index.js";
import { describeConfig, loadConfig, type BrainConfig } from "../src/config.js";
import { createStack } from "../src/extension.js";
import { formatInjection, formatTrace } from "../src/inject.js";

const USAGE = `
brain-traverse <command> [options]

Commands
  route <prompt>     Route one prompt and print the trail (and the document)
  eval [path]        Run routing evals against the vault (default: evals.json)
  lint               Validate every _index.json in the vault, and check none is stale
  health             Check the decisions API
  config             Print the resolved configuration and where each value came from
  bench [prompt]     Route the same prompt N times and report latency
  stats              Summarise the routing log: what is injected, what never is, near ties

Options
  --vault <path>     Override the vault root
  --url <url>        Override the decisions base URL
  --path <path>      Endpoint path (default /v1/systemone)
  --timeout <ms>     Per-request timeout
  --min-conf <n>     Confidence threshold, 0-1
  --no-gate          Skip the "does this need a manual?" pre-check
  --no-cache         Bypass the local route cache
  --no-composite     Disable multi-document composite routing
  --fail-under <pct> Fail if eval accuracy falls below this percentage (default: 100)
  --tag <name>       Filter evals by tag
  --quiet            Trail only; do not print the document
  --json             Machine-readable output
  -n <count>         Iterations for bench (default 20)
  --budget <ms>      bench: fail if p50 exceeds this (default 100 for a local host, none remote)
  -v, --debug        Verbose logging

Flags also accept --name=value. Use -- before a prompt that starts with a dash.
`.trim();

const VALUE_FLAGS = new Set(["vault", "url", "path", "timeout", "min-conf", "n", "budget", "evals", "fail-under", "tag"]);

class UsageError extends Error {}

function configFrom(args: Args, quiet = false): BrainConfig {
	const overrides: Partial<BrainConfig> = {};
	if (typeof args.flags.vault === "string") overrides.vaultRoot = args.flags.vault;
	if (typeof args.flags.url === "string") overrides.decisionsUrl = args.flags.url;
	if (typeof args.flags.path === "string") overrides.decisionsPath = args.flags.path;

	const timeout = numberFlag(args.flags, "timeout", { min: 1, integer: true });
	const minConf = numberFlag(args.flags, "min-conf", { min: 0, max: 1 });
	for (const problem of [timeout.error, minConf.error]) if (problem) throw new UsageError(problem);
	if (timeout.value !== undefined) overrides.timeoutMs = timeout.value;
	if (minConf.value !== undefined) overrides.minConfidence = minConf.value;

	if (args.flags["no-gate"]) overrides.gateEnabled = false;
	if (args.flags["no-cache"]) overrides.useCache = false;
	if (args.flags["no-composite"]) overrides.compositeEnabled = false;
	if (args.flags.debug) overrides.logLevel = "debug";

	const config = loadConfig({ overrides });
	if (!quiet) for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`);
	return config;
}

function requireVault(config: BrainConfig): boolean {
	if (config.vaultRoot) return true;
	process.stderr.write("no vault root: set BRAIN_VAULT_ROOT or pass --vault\n");
	return false;
}

// ---------------------------------------------------------------------------

async function cmdRoute(args: Args): Promise<number> {
	const prompt = args.positional.join(" ").trim();
	if (!prompt) {
		process.stderr.write("route needs a prompt\n");
		return 2;
	}

	const config = configFrom(args);
	if (!requireVault(config)) return 2;

	const { traverser } = createStack(config, new Logger(config.logLevel));
	const result = await traverser.route(prompt);

	if (args.flags.json) {
		process.stdout.write(JSON.stringify(result, null, 2) + "\n");
		return result.status === "error" ? 1 : 0;
	}

	process.stdout.write(`${formatTrace(result)}\n`);
	for (const hop of result.hops) {
		process.stdout.write(
			`  hop ${hop.from || "."} -> ${hop.chosen} [${hop.type}] ` +
				`conf=${hop.confidence.toFixed(3)} of ${hop.optionCount} options, ${Math.round(hop.latencyMs)}ms\n`,
		);
		if (hop.probabilities && args.flags.debug) {
			const ranked = Object.entries(hop.probabilities)
				.sort((a, b) => b[1] - a[1])
				.map(([label, probability]) => `${label}=${probability.toFixed(3)}`);
			process.stdout.write(`       ${ranked.join("  ")}\n`);
		}
	}

	if (!args.flags.quiet) {
		const injection = formatInjection(result);
		if (injection) process.stdout.write(`\n${injection}\n`);
	}

	return result.status === "error" ? 1 : 0;
}

/** Every directory holding a manifest, skipping what the vault scanner skips. */
function walkManifests(root: string): string[] {
	const ignored = loadIgnore(root);
	const found: string[] = [];
	const stack = [root];

	while (stack.length) {
		const dir = stack.pop() as string;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		if (entries.includes(MANIFEST_FILE)) found.push(dir);
		for (const name of entries) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const path = join(dir, name);
			if (ignored(relativeToVault(root, path))) continue;
			try {
				if (statSync(path).isDirectory()) stack.push(path);
			} catch {
				/* unreadable entry; lint reports what it can */
			}
		}
	}

	return found.sort();
}

async function cmdLint(args: Args): Promise<number> {
	const config = configFrom(args);
	if (!requireVault(config)) return 2;

	const root = resolve(config.vaultRoot);
	const store = new ManifestStore(root, false);
	const dirs = walkManifests(root);
	let errors = 0;
	let warnings = 0;
	let leaves = 0;
	const error = (message: string) => {
		process.stdout.write(`  ERROR ${message}\n`);
		errors++;
	};
	const warn = (message: string) => {
		process.stdout.write(`  warn  ${message}\n`);
		warnings++;
	};

	process.stdout.write(`Linting ${config.vaultRoot}\n`);
	if (dirs.length === 0) {
		process.stdout.write(`  no ${MANIFEST_FILE} found anywhere under the vault root\n`);
		return 1;
	}

	for (const dir of dirs) {
		const where = store.relativeToVault(dir);
		let manifest;
		try {
			manifest = store.load(dir);
		} catch (caught) {
			error(`${where}: ${(caught as Error).message}`);
			continue;
		}
		if (!manifest) continue;

		for (const warning of manifestWarnings(manifest.entries, where)) warn(warning);

		for (const entry of manifest.entries) {
			let target: string;
			try {
				target = store.resolveTarget(manifest, entry);
			} catch (caught) {
				error(`${where}: ${(caught as Error).message}`);
				continue;
			}

			let stats;
			try {
				stats = statSync(target);
			} catch {
				error(`${where}: '${entry.id}' -> missing ${entry.targetPath}`);
				continue;
			}

			if (entry.type === "branch" && !stats.isDirectory()) {
				error(`${where}: '${entry.id}' is a branch but ${entry.targetPath} is a file`);
			} else if (entry.type === "leaf") {
				if (!stats.isFile()) error(`${where}: '${entry.id}' is a leaf but ${entry.targetPath} is a directory`);
				else leaves++;
			} else {
				try {
					if (!store.load(target)) error(`${where}: branch '${entry.id}' has no ${MANIFEST_FILE}`);
				} catch (caught) {
					// A malformed child manifest, or anything else that stops it loading.
					error(`${where}: ${caught instanceof ManifestError ? "" : "cannot read child manifest: "}${(caught as Error).message}`);
				}
			}
		}
	}

	// The reader's view above says the manifests are self-consistent; this says
	// whether they still match the notes they were compiled from.
	try {
		const stale = compileVault(root, { dryRun: true, maxHops: config.maxHops }).files.filter((file) => file.status === "written");
		for (const file of stale) warn(`${file.path} is stale: the notes changed since it was compiled (run brain-keeper rebuild)`);
	} catch (caught) {
		warn(`could not check for stale manifests: ${(caught as Error).message}`);
	}

	if (config.fallbackDocument && config.fallbackDocument !== "auto") {
		try {
			statSync(resolve(root, config.fallbackDocument));
		} catch {
			warn(`fallback document '${config.fallbackDocument}' does not exist`);
		}
	} else if (config.fallbackDocument === "auto") {
		try {
			const rootManifest = store.load(root);
			if (rootManifest && !rootManifest.entries.some((entry) => entry.fallback)) {
				warn("no root note is marked `fallback: true`, so an unsure route injects nothing");
			}
		} catch {
			/* already reported above */
		}
	}

	process.stdout.write(
		`\n${dirs.length} manifest(s), ${leaves} leaf document(s), ` +
			`${errors} error(s), ${warnings} warning(s)  [limit ${MAX_CHILDREN} children/node]\n`,
	);
	return errors ? 1 : 0;
}

async function cmdHealth(args: Args): Promise<number> {
	const config = configFrom(args);
	const { client } = createStack(config, new Logger("silent"));
	const health = await client.health();

	if (args.flags.json) {
		process.stdout.write(JSON.stringify(health, null, 2) + "\n");
		return health.ok ? 0 : 1;
	}

	const lines = [`endpoint   ${client.endpoint}`, `backend    ${health.backend}`];
	if (health.model) lines.push(`model      ${health.model}`);
	if (health.device) lines.push(`device     ${health.device}`);
	for (const key of ["dtype", "load_seconds"]) {
		if (health.detail && key in health.detail) lines.push(`${key.padEnd(10)} ${String(health.detail[key])}`);
	}
	lines.push(`status     ${health.ok ? "ready" : health.error}`);
	process.stdout.write(lines.join("\n") + "\n");
	return health.ok ? 0 : 1;
}

async function cmdBench(args: Args): Promise<number> {
	const config = configFrom(args);
	if (!requireVault(config)) return 2;

	const count = numberFlag(args.flags, "n", { min: 1, max: 100_000, integer: true });
	const budgetFlag = numberFlag(args.flags, "budget", { min: 1 });
	for (const problem of [count.error, budgetFlag.error]) if (problem) throw new UsageError(problem);

	const iterations = count.value ?? 20;
	// The plan's 100ms budget assumes a Laya host next door; a remote API's
	// round trip is network time this tool cannot judge, so there is no default gate.
	const budget = budgetFlag.value ?? (isLocalUrl(config.decisionsUrl) ? 100 : undefined);
	const prompt =
		args.positional.join(" ").trim() || "How do I configure connection pooling for asyncpg in FastAPI?";
	const { traverser } = createStack(config, new Logger("silent"));

	await traverser.route(prompt); // warm the manifest cache

	const samples: number[] = [];
	const statuses = new Map<string, number>();
	for (let index = 0; index < iterations; index++) {
		const result = await traverser.route(prompt);
		samples.push(result.totalMs);
		statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
	}

	samples.sort((a, b) => a - b);
	const at = (fraction: number) => samples[Math.min(samples.length - 1, Math.round(fraction * (samples.length - 1)))];

	process.stdout.write(`prompt     ${prompt}\n`);
	process.stdout.write(`iterations ${iterations}\n`);
	process.stdout.write(`statuses   ${[...statuses].map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
	process.stdout.write(
		`latency    min=${at(0).toFixed(1)}  p50=${at(0.5).toFixed(1)}  ` +
			`p90=${at(0.9).toFixed(1)}  p99=${at(0.99).toFixed(1)}  max=${samples[samples.length - 1].toFixed(1)} (ms)\n`,
	);
	if (budget === undefined) {
		process.stdout.write(`\nNo latency gate for a remote API; pass --budget <ms> to set one.\n`);
		return 0;
	}
	const pass = at(0.5) < budget;
	process.stdout.write(`\nBudget: p50 < ${budget}ms.  ${pass ? "PASS" : "FAIL"}\n`);
	return pass ? 0 : 1;
}

async function cmdEval(args: Args): Promise<number> {
	const config = configFrom(args);
	if (!requireVault(config)) return 2;

	let evalPath = args.positional[0] || (typeof args.flags.evals === "string" ? args.flags.evals : "");
	if (!evalPath) {
		const jsonPath = join(config.vaultRoot, "evals.json");
		const yamlPath = join(config.vaultRoot, "evals.yaml");
		if (existsSync(jsonPath)) evalPath = jsonPath;
		else if (existsSync(yamlPath)) evalPath = yamlPath;
		else {
			process.stderr.write(`no eval suite specified, and neither evals.json nor evals.yaml found in ${config.vaultRoot}\n`);
			return 2;
		}
	}

	const resolvedPath = resolve(evalPath);
	let suite;
	try {
		suite = loadEvalSuite(resolvedPath);
	} catch (err) {
		process.stderr.write(`${(err as Error).message}\n`);
		return 2;
	}

	const failUnderRaw = numberFlag(args.flags, "fail-under", { min: 0, max: 100 });
	if (failUnderRaw.error) {
		process.stderr.write(`${failUnderRaw.error}\n`);
		return 2;
	}
	const failUnder = failUnderRaw.value ?? 100;

	const tags = typeof args.flags.tag === "string" ? [args.flags.tag] : undefined;
	const { traverser } = createStack(config, new Logger(config.logLevel));
	const report = await runEvalSuite(suite, traverser, { tags, failUnder });

	if (args.flags.json) {
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} else {
		process.stdout.write(`eval suite: ${resolvedPath}\n`);
		process.stdout.write(renderEvalReport(report) + "\n");
	}

	return report.accuracy * 100 >= failUnder ? 0 : 1;
}

async function cmdStats(args: Args): Promise<number> {
	const config = configFrom(args);
	const path = resolveRouteLogPath(config.routeLog);
	if (!path) {
		process.stderr.write("the routing log is off (routeLog is empty)\n");
		return 2;
	}
	let root;
	try {
		root = config.vaultRoot ? scanVault(config.vaultRoot).root : undefined;
	} catch {
		root = undefined;
	}
	process.stdout.write(`log        ${path}\n\n${renderRouteStats(readRouteLog(path), root)}\n`);

	const cacheStats = defaultRouteCache.getStats();
	if (cacheStats.hits + cacheStats.misses > 0) {
		const hitRate = ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(1);
		process.stdout.write(`cache      ${cacheStats.hits} hits, ${cacheStats.misses} misses (${hitRate}% hit rate), size=${cacheStats.size}\n`);
	}
	return 0;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2), VALUE_FLAGS, { v: "debug" });

	try {
		switch (args.command) {
			case "route":
				return await cmdRoute(args);
			case "eval":
				return await cmdEval(args);
			case "lint":
				return await cmdLint(args);
			case "health":
				return await cmdHealth(args);
			case "bench":
				return await cmdBench(args);
			case "stats":
				return await cmdStats(args);
			case "config":
				process.stdout.write(describeConfig(configFrom(args, true)) + "\n");
				return 0;
			case "":
			case "help":
				process.stdout.write(USAGE + "\n");
				return 0;
			default:
				process.stderr.write(`unknown command '${args.command}'\n\n${USAGE}\n`);
				return 2;
		}
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n`);
			return 2;
		}
		throw error;
	}
}

runMain("brain-traverse", main, true);
