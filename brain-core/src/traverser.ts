/**
 * The traversal engine.
 *
 * Walks the brain tree one `_index.json` at a time, asking the decisions API to
 * pick a child at each level, and returns the leaf markdown to inject.
 *
 * Two things this deliberately does *not* do:
 *   - throw. Every failure path returns a `TraversalResult` with a status and a
 *     reason, because a routing miss must never take down an agent turn.
 *   - scan the filesystem. If a directory has no manifest, traversal stops.
 *
 * The gate question rides along with the first hop's choice question. Laya
 * answers every question in a request in one forward pass, so asking "does this
 * prompt even need a reference guide?" costs a few milliseconds rather than a
 * whole extra round trip.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { choiceConfidence, type DecisionsClient } from "./decisions-client.js";
import { splitFrontmatter } from "./frontmatter.js";
import type { Logger } from "./logger.js";
import { ManifestError, ManifestStore, type LoadedManifest } from "./manifest.js";
import { isInsideVault, relativeToVault } from "./paths.js";
import { RouteCache, defaultRouteCache } from "./cache.js";
import type {
	Hop,
	ManifestEntry,
	Question,
	TraversalDocument,
	TraversalResult,
	TraversalStatus,
} from "./types.js";

/**
 * What the traverser needs to run. `BrainConfig` is a superset of this, so it
 * satisfies the interface structurally — the traverser does not need to know
 * about Pi-specific settings like `displayInjection`.
 */
export interface TraverserOptions {
	vaultRoot: string;
	maxHops: number;
	minConfidence: number;
	gateEnabled: boolean;
	gateThreshold: number;
	/** `"auto"`: the nearest note marked `fallback: true`; a path: that note; `""`: none. */
	fallbackDocument: string;
	maxDocumentChars: number;
	maxPromptChars: number;
	watchManifests: boolean;
	/** Ceiling on the whole route, every hop and retry included. Unlimited when absent or 0. */
	routeBudgetMs?: number;
	/** Laya only: an act probability below this counts as an unsure hop. 0 or absent disables it. */
	minActProbability?: number;
	/** Defaults to true when absent. */
	enabled?: boolean;
	/** Use the local route cache. Defaults to true when absent. */
	useCache?: boolean;
	/** Support multi-document composite routing for cross-cutting prompts. Defaults to true. */
	compositeEnabled?: boolean;
	/** Minimum probability for a branch/leaf to qualify as a composite candidate. Defaults to 0.25. */
	compositeThreshold?: number;
	/** Minimum ratio of candidate probability to winner probability to qualify. Defaults to 0.65. */
	compositeMarginRatio?: number;
	/** Maximum number of complementary guides to retrieve under composite routing. Defaults to 2. */
	maxCompositeDocuments?: number;
}

const ROUTE_QUESTION = "route_selection";
const GATE_QUESTION = "needs_reference";

const ROUTE_INSTRUCTIONS =
	"Select the reference manual most relevant to the developer prompt.";
const GATE_INSTRUCTIONS =
	"Does answering this developer prompt require consulting a technical reference manual? " +
	"Answer no for greetings, small talk, and simple questions answerable without documentation.";

type Finish = (status: TraversalStatus, reason: string, extra?: Partial<TraversalResult>) => TraversalResult;

/** Words that carry no topic: a prompt made only of these cannot need a reference guide. */
const ACKNOWLEDGEMENT_WORDS = new Set(
	(
		"y yes yeah yep yup no nope ok okay k kk sure thanks thank you thx ty cheers continue go on ahead proceed " +
		"carry keep going next done great nice cool perfect sounds looks good lgtm agreed do it ship please mate"
	).split(" "),
);

/** A follow-up so short and content-free that no reference guide could apply to it. */
export function isTrivialFollowUp(state: string): boolean {
	if (state.length > 40) return false;
	const words = state.toLowerCase().split(/[\s,.!?;:]+/).filter(Boolean);
	return words.length > 0 && words.length <= 4 && words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word));
}

/** Cut to at most `limit` UTF-16 units without splitting a surrogate pair. */
export function sliceCodePoints(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let cut = text.slice(0, limit);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return cut;
}

/** Close a Markdown code fence left open by truncation, so the rest of the prompt is not swallowed by it. */
export function closeOpenFence(content: string): string {
	let open: string | null = null;
	for (const line of content.split("\n")) {
		const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (!fence) continue;
		if (open === null) open = fence;
		else if (fence[0] === open[0] && fence.length >= open.length) open = null;
	}
	return open === null ? content : `${content}\n${open}`;
}

/**
 * Allocates a unified character budget across multiple documents.
 * Fairly divides headroom so short documents stay intact and remaining
 * budget is redistributed to longer documents, with Markdown code fences closed cleanly.
 */
export function allocateUnifiedContextBudget(
	documents: TraversalDocument[],
	maxTotalChars: number,
): TraversalDocument[] {
	if (documents.length === 0) return [];
	if (maxTotalChars <= 0) return documents;

	const totalOriginal = documents.reduce((sum, doc) => sum + doc.originalLength, 0);
	if (totalOriginal <= maxTotalChars) {
		return documents.map((doc) => ({
			...doc,
			truncated: false,
		}));
	}

	// Dynamic allocation with redistribution:
	const allocated = new Map<string, number>();
	let remainingBudget = maxTotalChars;
	let undecided = [...documents];

	// Iteratively satisfy documents whose original length is <= fairShare
	let progress = true;
	while (progress && undecided.length > 0) {
		progress = false;
		const fairShare = Math.floor(remainingBudget / undecided.length);
		const stillUndecided: TraversalDocument[] = [];

		for (const doc of undecided) {
			if (doc.originalLength <= fairShare) {
				allocated.set(doc.id, doc.originalLength);
				remainingBudget -= doc.originalLength;
				progress = true;
			} else {
				stillUndecided.push(doc);
			}
		}

		undecided = stillUndecided;
	}

	// Remaining undecided documents share what's left
	if (undecided.length > 0) {
		const perDoc = Math.floor(remainingBudget / undecided.length);
		for (const doc of undecided) {
			allocated.set(doc.id, Math.max(0, perDoc));
		}
	}

	// Apply allocations and truncation
	return documents.map((doc) => {
		const budget = allocated.get(doc.id) ?? doc.originalLength;
		if (doc.originalLength <= budget) {
			return {
				...doc,
				truncated: false,
			};
		}

		let content = doc.content.trim();
		const cut = content.lastIndexOf("\n", budget);
		content = closeOpenFence(sliceCodePoints(content, cut > budget * 0.5 ? cut : budget).trimEnd());

		return {
			...doc,
			content,
			truncated: true,
		};
	});
}

export class BrainTraverser {
	private readonly manifests: ManifestStore;
	private readonly cache: RouteCache;

	constructor(
		private readonly config: TraverserOptions,
		private readonly client: DecisionsClient,
		private readonly logger: Logger,
		cache?: RouteCache,
	) {
		this.manifests = new ManifestStore(config.vaultRoot, config.watchManifests);
		this.cache = cache ?? defaultRouteCache;
	}

	/** Drop cached manifests and route cache; used by the `/brain reload` command. */
	reload(): void {
		this.manifests.clear();
		this.cache.clear(this.config.vaultRoot);
	}

	async route(prompt: string): Promise<TraversalResult> {
		const started = performance.now();
		const deadline = this.config.routeBudgetMs ? started + this.config.routeBudgetMs : undefined;
		const hops: Hop[] = [];
		const segments = ["Root"];
		const warnings: string[] = [];
		/** Every manifest walked through, root first; the fallback search runs back up it. */
		const visited: LoadedManifest[] = [];

		const finish: Finish = (status, reason, extra = {}) => {
			const docs = extra.documents ?? (extra.document ? [extra.document] : undefined);
			const primaryDoc = extra.document ?? (docs && docs.length > 0 ? docs[0] : undefined);
			const res: TraversalResult = {
				status,
				reason,
				hops,
				trail: segments.join(" -> "),
				minConfidence: hops.length ? Math.min(...hops.map((h) => h.confidence)) : 1,
				totalMs: performance.now() - started,
				...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
				...extra,
				...(primaryDoc ? { document: primaryDoc } : {}),
				...(docs ? { documents: docs } : {}),
			};
			if (
				this.config.useCache === true &&
				(status === "leaf" || status === "composite" || status === "fallback" || status === "skipped")
			) {
				this.cache.set(prompt, this.config.vaultRoot, res);
			}
			return res;
		};

		if (this.config.enabled === false) {
			return finish("disabled", "brain-traverse is disabled by configuration");
		}
		if (!this.config.vaultRoot) return finish("no-index", "vaultRoot is not configured");

		if (this.config.useCache === true) {
			const cached = this.cache.get(prompt, this.config.vaultRoot);
			if (cached) {
				return cached;
			}
		}

		const state = this.toState(prompt);
		if (!state) return finish("skipped", "prompt is empty after normalisation");
		if (this.config.gateEnabled && isTrivialFollowUp(state)) {
			// "yes", "thanks", "continue": the gate would say no anyway, so skip the round trip.
			return finish("skipped", "a short acknowledgement; no reference needed");
		}

		let dir = resolve(this.config.vaultRoot);
		let gate: TraversalResult["gate"];

		for (let hop = 0; hop < this.config.maxHops; hop++) {
			let manifest: LoadedManifest | null;
			try {
				manifest = this.manifests.load(dir);
			} catch (error) {
				if (error instanceof ManifestError) {
					return this.withFallback(finish, visited, "error", `malformed manifest: ${error.message}`, gate);
				}
				throw error;
			}

			if (!manifest) {
				const where = this.manifests.relativeToVault(dir);
				if (hop === 0) {
					return finish("no-index", `no _index.json at the vault root (${where})`, { gate });
				}
				// A branch pointing at a directory with no manifest is a vault bug,
				// not a reason to abandon the turn.
				return this.withFallback(finish, visited, "no-index", `no _index.json in '${where}'`, gate);
			}
			visited.push(manifest);

			const criteria: Record<string, string> = {};
			for (const entry of manifest.entries) criteria[entry.id] = entry.criteria;

			const questions: Record<string, Question> = {
				[ROUTE_QUESTION]: { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria },
			};
			if (hop === 0 && this.config.gateEnabled) {
				questions[GATE_QUESTION] = { type: "noul", instructions: GATE_INSTRUCTIONS };
			}

			const outcome = await this.client.ask(state, questions, { deadline });
			if (!outcome.ok) {
				// Deliberately no fallback document here: if the decisions service is
				// down we have no evidence any guide is the right one.
				return finish("error", `decisions API failed: ${outcome.error}`, { gate });
			}
			if (outcome.warnings) warnings.push(...outcome.warnings);

			if (hop === 0 && this.config.gateEnabled) {
				const answer = outcome.answers[GATE_QUESTION];
				if (answer && answer.type === "noul" && typeof answer.noul === "number") {
					gate = { needed: answer.noul >= this.config.gateThreshold, probability: answer.noul };
					if (!gate.needed) {
						return finish(
							"skipped",
							`gate says no reference needed (p=${answer.noul.toFixed(3)} < ${this.config.gateThreshold})`,
							{ gate },
						);
					}
				} else {
					this.logger.debug("gate question returned no noul answer; continuing without it");
				}
			}

			const answer = outcome.answers[ROUTE_QUESTION];
			if (!answer || answer.type !== "choice") {
				return this.withFallback(finish, visited, "error", "decisions API returned no choice answer", gate);
			}

			const entry = manifest.entries.find((candidate) => candidate.id === answer.choice);
			if (!entry) {
				// Guard against a label that is not on the menu; without this the
				// traverser would try to descend into a directory that does not exist.
				return this.withFallback(
					finish,
					visited,
					"error",
					`model chose '${answer.choice}', which is not in ${this.manifests.relativeToVault(dir)}/_index.json`,
					gate,
				);
			}

			const confidence = choiceConfidence(answer);

			// Composite Routing: check if alternative candidates meet the composite threshold
			if (
				hop === 0 &&
				this.config.compositeEnabled !== false &&
				confidence >= this.config.minConfidence &&
				answer.probabilities
			) {
				const threshold = this.config.compositeThreshold ?? 0.25;
				const marginRatio = this.config.compositeMarginRatio ?? 0.65;
				const maxDocs = this.config.maxCompositeDocuments ?? 2;
				const winnerProb = answer.probabilities[entry.id] ?? confidence;

				const otherCandidates = manifest.entries.filter((cand) => {
					if (cand.id === entry.id) return false;
					const p = answer.probabilities?.[cand.id];
					if (typeof p !== "number" || !Number.isFinite(p)) return false;
					return p >= threshold && p >= winnerProb * marginRatio;
				});

				if (otherCandidates.length > 0 && maxDocs > 1) {
					otherCandidates.sort(
						(a, b) => (answer.probabilities?.[b.id] ?? 0) - (answer.probabilities?.[a.id] ?? 0),
					);
					const selectedCandidates = [entry, ...otherCandidates.slice(0, maxDocs - 1)];

					const branchPromises = selectedCandidates.map((cand) => {
						const candConf =
							cand.id === entry.id
								? confidence
								: choiceConfidence({ choice: cand.id, probabilities: answer.probabilities });
						return this.traverseBranch(
							manifest!,
							dir,
							cand,
							candConf,
							answer.probabilities,
							answer.action?.act_probability,
							state,
							deadline,
							visited,
						);
					});

					const branchResults = await Promise.all(branchPromises);

					const uniqueDocs: TraversalDocument[] = [];
					const seenPaths = new Set<string>();
					for (const b of branchResults) {
						if (b.document && !seenPaths.has(b.document.path)) {
							seenPaths.add(b.document.path);
							uniqueDocs.push({
								...b.document,
								confidence: b.minConfidence,
								trail: b.segments.join(" -> "),
							});
						}
						hops.push(...b.hops);
						if (b.warnings.length) warnings.push(...b.warnings);
					}

					if (uniqueDocs.length > 1) {
						const budgeted = allocateUnifiedContextBudget(uniqueDocs, this.config.maxDocumentChars);
						const compositeTrail = `Composite [${budgeted.map((d) => d.trail ?? d.path).join(", ")}]`;
						const compositeMinConf = Math.min(...budgeted.map((d) => d.confidence ?? 1));
						return finish(
							"composite",
							`composite route resolved ${budgeted.length} complementary guides`,
							{
								document: budgeted[0],
								documents: budgeted,
								composite: true,
								trail: compositeTrail,
								minConfidence: compositeMinConf,
								gate,
							},
						);
					} else if (uniqueDocs.length === 1) {
						const budgeted = allocateUnifiedContextBudget(uniqueDocs, this.config.maxDocumentChars);
						return finish("leaf", branchResults[0].reason, {
							document: budgeted[0],
							documents: budgeted,
							trail: branchResults[0].segments.join(" -> "),
							minConfidence: branchResults[0].minConfidence,
							gate,
						});
					}
					// If no branches reached a leaf, fall through to withFallback
				}
			}

			const actProbability = answer.action?.act_probability;
			hops.push({
				from: this.manifests.relativeToVault(dir),
				chosen: entry.id,
				type: entry.type,
				confidence,
				latencyMs: outcome.serverMs ?? outcome.latencyMs,
				probabilities: answer.probabilities,
				optionCount: manifest.entries.length,
				...(typeof actProbability === "number" ? { actProbability } : {}),
			});
			segments.push(entry.type === "leaf" ? basename(entry.targetPath) : entry.id);

			if (confidence < this.config.minConfidence) {
				return this.withFallback(
					finish,
					visited,
					"low-confidence",
					`confidence ${confidence.toFixed(3)} below threshold ${this.config.minConfidence} at hop ${hop + 1}`,
					gate,
				);
			}

			const minAct = this.config.minActProbability ?? 0;
			if (minAct > 0 && typeof actProbability === "number" && actProbability < minAct) {
				return this.withFallback(
					finish,
					visited,
					"low-confidence",
					`act probability ${actProbability.toFixed(3)} below threshold ${minAct} at hop ${hop + 1}`,
					gate,
				);
			}

			let target: string;
			try {
				target = this.manifests.resolveTarget(manifest, entry);
			} catch (error) {
				return this.withFallback(finish, visited, "error", (error as Error).message, gate);
			}

			if (entry.type === "leaf") {
				const document = this.readDocument(target, entry);
				if (!document) {
					return this.withFallback(
						finish,
						visited,
						"error",
						`leaf '${entry.id}' points at a missing file: ${entry.targetPath}`,
						gate,
					);
				}
				return finish("leaf", `routed in ${hops.length} hop(s)`, { document, gate });
			}

			dir = target;
		}

		return this.withFallback(
			finish,
			visited,
			"max-hops",
			`hit the ${this.config.maxHops}-hop ceiling without reaching a leaf`,
			gate,
		);
	}

	// -----------------------------------------------------------------------

	/** Normalise the prompt into the `state` the model reads. */
	private toState(prompt: string): string {
		const text = (prompt ?? "").replace(/\s+/g, " ").trim();
		// The English checkpoint's context is 512 tokens and the criteria block
		// eats into it. The routing signal is almost always in the opening lines,
		// so keep the head rather than the tail.
		return sliceCodePoints(text, this.config.maxPromptChars);
	}

	private readRawDocument(path: string, entry: ManifestEntry): TraversalDocument | null {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			return null;
		}

		const { title, body } = splitFrontmatter(raw);
		const content = body.trim();
		return {
			id: entry.id,
			title: entry.title ?? title ?? entry.id,
			path: this.manifests.relativeToVault(path),
			content,
			truncated: false,
			originalLength: content.length,
		};
	}

	private readDocument(path: string, entry: ManifestEntry): TraversalDocument | null {
		const raw = this.readRawDocument(path, entry);
		if (!raw) return null;
		const budgeted = allocateUnifiedContextBudget([raw], this.config.maxDocumentChars);
		return budgeted[0] ?? null;
	}

	private async traverseBranch(
		parentManifest: LoadedManifest,
		fromDir: string,
		entry: ManifestEntry,
		hop0Confidence: number,
		hop0Probabilities: Record<string, number> | undefined,
		hop0ActProbability: number | undefined,
		state: string,
		deadline: number | undefined,
		visited: LoadedManifest[],
	): Promise<{
		entry: ManifestEntry;
		document: TraversalDocument | null;
		hops: Hop[];
		segments: string[];
		minConfidence: number;
		status: TraversalStatus;
		reason: string;
		warnings: string[];
	}> {
		const hops: Hop[] = [];
		const segments = [
			this.manifests.relativeToVault(fromDir) || "Root",
			entry.type === "leaf" ? basename(entry.targetPath) : entry.id,
		];
		const warnings: string[] = [];
		const branchVisited = [...visited];

		hops.push({
			from: this.manifests.relativeToVault(fromDir),
			chosen: entry.id,
			type: entry.type,
			confidence: hop0Confidence,
			latencyMs: 0,
			probabilities: hop0Probabilities,
			optionCount: parentManifest.entries.length,
			...(typeof hop0ActProbability === "number" ? { actProbability: hop0ActProbability } : {}),
		});

		if (entry.type === "leaf") {
			let target: string;
			try {
				target = this.manifests.resolveTarget(parentManifest, entry);
			} catch (error) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: hop0Confidence,
					status: "error",
					reason: (error as Error).message,
					warnings,
				};
			}
			const document = this.readRawDocument(target, entry);
			if (!document) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: hop0Confidence,
					status: "error",
					reason: `leaf '${entry.id}' points at a missing file: ${entry.targetPath}`,
					warnings,
				};
			}
			return {
				entry,
				document,
				hops,
				segments,
				minConfidence: hop0Confidence,
				status: "leaf",
				reason: `routed in 1 hop`,
				warnings,
			};
		}

		let dir: string;
		try {
			dir = this.manifests.resolveTarget(parentManifest, entry);
		} catch (error) {
			return {
				entry,
				document: null,
				hops,
				segments,
				minConfidence: hop0Confidence,
				status: "error",
				reason: (error as Error).message,
				warnings,
			};
		}

		for (let hop = 1; hop < this.config.maxHops; hop++) {
			let manifest: LoadedManifest | null;
			try {
				manifest = this.manifests.load(dir);
			} catch (error) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "error",
					reason: error instanceof ManifestError ? `malformed manifest: ${error.message}` : (error as Error).message,
					warnings,
				};
			}

			if (!manifest) {
				const where = this.manifests.relativeToVault(dir);
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "no-index",
					reason: `no _index.json in '${where}'`,
					warnings,
				};
			}
			branchVisited.push(manifest);

			const criteria: Record<string, string> = {};
			for (const e of manifest.entries) criteria[e.id] = e.criteria;

			const questions: Record<string, Question> = {
				[ROUTE_QUESTION]: { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria },
			};

			const outcome = await this.client.ask(state, questions, { deadline });
			if (!outcome.ok) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "error",
					reason: `decisions API failed: ${outcome.error}`,
					warnings,
				};
			}
			if (outcome.warnings) warnings.push(...outcome.warnings);

			const answer = outcome.answers[ROUTE_QUESTION];
			if (!answer || answer.type !== "choice") {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "error",
					reason: "decisions API returned no choice answer",
					warnings,
				};
			}

			const chosenEntry = manifest.entries.find((c) => c.id === answer.choice);
			if (!chosenEntry) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "error",
					reason: `model chose '${answer.choice}', which is not in ${this.manifests.relativeToVault(dir)}/_index.json`,
					warnings,
				};
			}

			const confidence = choiceConfidence(answer);
			const actProbability = answer.action?.act_probability;
			hops.push({
				from: this.manifests.relativeToVault(dir),
				chosen: chosenEntry.id,
				type: chosenEntry.type,
				confidence,
				latencyMs: outcome.serverMs ?? outcome.latencyMs,
				probabilities: answer.probabilities,
				optionCount: manifest.entries.length,
				...(typeof actProbability === "number" ? { actProbability } : {}),
			});
			segments.push(chosenEntry.type === "leaf" ? basename(chosenEntry.targetPath) : chosenEntry.id);

			if (confidence < this.config.minConfidence) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "low-confidence",
					reason: `confidence ${confidence.toFixed(3)} below threshold ${this.config.minConfidence} at hop ${hop + 1}`,
					warnings,
				};
			}

			const minAct = this.config.minActProbability ?? 0;
			if (minAct > 0 && typeof actProbability === "number" && actProbability < minAct) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "low-confidence",
					reason: `act probability ${actProbability.toFixed(3)} below threshold ${minAct} at hop ${hop + 1}`,
					warnings,
				};
			}

			let target: string;
			try {
				target = this.manifests.resolveTarget(manifest, chosenEntry);
			} catch (error) {
				return {
					entry,
					document: null,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "error",
					reason: (error as Error).message,
					warnings,
				};
			}

			if (chosenEntry.type === "leaf") {
				const document = this.readRawDocument(target, chosenEntry);
				if (!document) {
					return {
						entry,
						document: null,
						hops,
						segments,
						minConfidence: Math.min(...hops.map((h) => h.confidence)),
						status: "error",
						reason: `leaf '${chosenEntry.id}' points at a missing file: ${chosenEntry.targetPath}`,
						warnings,
					};
				}
				return {
					entry,
					document,
					hops,
					segments,
					minConfidence: Math.min(...hops.map((h) => h.confidence)),
					status: "leaf",
					reason: `routed in ${hops.length} hop(s)`,
					warnings,
				};
			}

			dir = target;
		}

		return {
			entry,
			document: null,
			hops,
			segments,
			minConfidence: Math.min(...hops.map((h) => h.confidence)),
			status: "max-hops",
			reason: `hit the ${this.config.maxHops}-hop ceiling without reaching a leaf`,
			warnings,
		};
	}

	/**
	 * Swap in a catch-all note, if the vault has one.
	 *
	 * With `fallbackDocument: "auto"` the search runs from the folder where
	 * routing gave up back towards the root, so a confident first hop into
	 * `Backend/` followed by an unsure second one lands on Backend's own
	 * catch-all rather than discarding what the first hop established.
	 */
	private withFallback(
		finish: Finish,
		visited: LoadedManifest[],
		status: TraversalStatus,
		reason: string,
		gate: TraversalResult["gate"],
	): TraversalResult {
		this.logger.debug(`${status}: ${reason}`);
		const setting = this.config.fallbackDocument;
		if (!setting) return finish(status, reason, { gate });

		if (setting !== "auto") {
			const path = resolve(this.config.vaultRoot, setting);
			const document = isInsideVault(this.config.vaultRoot, path)
				? this.readDocument(path, { id: "fallback", type: "leaf", criteria: "", targetPath: setting })
				: null;
			if (!document) return finish(status, `${reason}; fallback '${setting}' not found`, { gate });
			return finish("fallback", reason, { document, gate });
		}

		let manifests = visited;
		if (manifests.length === 0) {
			// Nothing was walked (a malformed root manifest); try the root anyway.
			try {
				const root = this.manifests.load(resolve(this.config.vaultRoot));
				manifests = root ? [root] : [];
			} catch {
				manifests = [];
			}
		}

		for (const manifest of [...manifests].reverse()) {
			const entry = manifest.entries.find((candidate) => candidate.fallback && candidate.type === "leaf");
			if (!entry) continue;
			let document: TraversalResult["document"] | null = null;
			try {
				document = this.readDocument(this.manifests.resolveTarget(manifest, entry), entry);
			} catch {
				document = null;
			}
			if (!document) continue;
			const where = relativeToVault(this.config.vaultRoot, manifest.dir);
			return finish("fallback", where === "." ? reason : `${reason}; used the '${where}' catch-all`, {
				document,
				gate,
			});
		}

		return finish(status, `${reason}; no note is marked \`fallback: true\``, { gate });
	}
}
