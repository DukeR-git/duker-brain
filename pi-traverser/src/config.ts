/**
 * Configuration. The loader lives in brain-core so the router and the keeper
 * read exactly the same settings; see ../../brain-core/src/config.ts for the
 * precedence rules and every key.
 */

export {
	DEFAULTS,
	describeConfig,
	loadConfig,
	type BrainConfig,
	type LoadOptions,
} from "../../brain-core/src/config.js";
