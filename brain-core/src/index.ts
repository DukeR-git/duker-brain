/**
 * brain-core — the vault model shared by the reader (pi-traverser) and the
 * writer (brain-keeper).
 *
 * Consumers import from here by relative path (`../../brain-core/src/index.js`)
 * rather than through node_modules. That keeps the three folders working as a
 * plain checkout with no build step, and no surprises when Pi loads the package
 * from its git clone or through a symlink. (The root workspace only exists to
 * install dependencies in one place.)
 */

export * from "./types.js";
export * from "./paths.js";
export * from "./frontmatter.js";
export * from "./manifest.js";
export * from "./vault.js";
export * from "./env.js";
export * from "./config.js";
export * from "./fsutil.js";
export * from "./routelog.js";
export * from "./cli.js";
export { BrainTraverser, type TraverserOptions } from "./traverser.js";
export { Logger, type LogLevel, type LogSink } from "./logger.js";
export * from "./cache.js";
export * from "./eval.js";
export * from "./exporter.js";
export {
	DecisionsClient,
	choiceConfidence,
	type AskOptions,
	type DecisionOutcome,
	type DecisionsClientOptions,
	type ServiceHealth,
} from "./decisions-client.js";
